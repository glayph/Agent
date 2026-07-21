package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type RuntimeState string

const (
	stateStopped    RuntimeState = "stopped"
	stateStarting   RuntimeState = "starting"
	stateRunning    RuntimeState = "running"
	stateStopping   RuntimeState = "stopping"
	stateRestarting RuntimeState = "restarting"
	stateError      RuntimeState = "error"
)

type Runtime struct {
	cfg    Config
	opMu   sync.Mutex
	mu     sync.RWMutex
	cmd    *exec.Cmd
	state  RuntimeState
	err    string
	start  time.Time
	done   chan struct{}
	cancel context.CancelFunc
	logs   *LogBuffer
	logCh  chan string
}

func NewRuntime(cfg Config) *Runtime {
	return &Runtime{
		cfg:   cfg,
		state: stateStopped,
		logs:  NewLogBuffer(1200),
		logCh: make(chan string, 512),
	}
}

func (r *Runtime) Start() error {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	return r.startRuntime()
}

func (r *Runtime) startRuntime() error {
	r.mu.Lock()
	if r.cmd != nil || r.state == stateStarting || r.state == stateStopping || r.state == stateRestarting {
		r.mu.Unlock()
		return nil
	}
	r.logs.Reset()
	r.state = stateStarting
	r.err = ""
	r.start = time.Now()
	r.appendLocked("Starting Hiro runtime...")
	r.mu.Unlock()

	if !fileExists(r.cfg.GatewayEntry) {
		return r.failStart(fmt.Errorf("gateway entrypoint not found: %s", r.cfg.GatewayEntry))
	}
	if err := ensurePortAvailable(r.cfg.Host, r.cfg.Port); err != nil {
		return r.failStart(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	args := append(nodeLoaderArgs(r.cfg.RuntimeLoader), r.cfg.GatewayEntry)
	cmd := exec.CommandContext(ctx, r.cfg.NodePath, args...)
	applyProcessAttrs(cmd)
	cmd.Dir = r.cfg.WorkspaceDir
	cmd.Env = runtimeEnv(os.Environ(), r.cfg)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return r.failStart(err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return r.failStart(err)
	}

	r.mu.Lock()
	r.done = make(chan struct{})
	r.cancel = cancel
	r.mu.Unlock()

	if err := cmd.Start(); err != nil {
		cancel()
		return r.failStart(err)
	}

	r.mu.Lock()
	r.cmd = cmd
	r.appendLocked(fmt.Sprintf("Runtime PID: %d", cmd.Process.Pid))
	r.mu.Unlock()

	go r.scan(stdout)
	go r.scan(stderr)
	go r.watch(cmd, cancel)
	go r.pollHealth(ctx)
	return nil
}

func (r *Runtime) failStart(err error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.state = stateError
	r.err = err.Error()
	r.cmd = nil
	r.cancel = nil
	r.done = nil
	r.appendLocked("Start failed: " + err.Error())
	return err
}

func (r *Runtime) Stop() error {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	return r.stop()
}

func (r *Runtime) stop() error {
	r.mu.Lock()
	cmd := r.cmd
	cancel := r.cancel
	done := r.done
	if cmd == nil {
		r.state = stateStopped
		r.mu.Unlock()
		return nil
	}
	r.state = stateStopping
	r.appendLocked("Stopping Hiro runtime...")
	r.mu.Unlock()

	if err := terminateProcessTree(cmd, 4*time.Second); err != nil {
		r.mu.Lock()
		r.state = stateError
		r.err = err.Error()
		r.appendLocked("Stop failed: " + err.Error())
		r.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		return err
	}

	if cancel != nil {
		cancel()
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
	return nil
}

func (r *Runtime) Restart() error {
	r.opMu.Lock()
	defer r.opMu.Unlock()

	r.mu.Lock()
	if r.state == stateStarting || r.state == stateStopping || r.state == stateRestarting {
		r.mu.Unlock()
		return nil
	}
	r.state = stateRestarting
	r.appendLocked("Restart requested.")
	r.mu.Unlock()
	if err := r.stop(); err != nil {
		return err
	}
	time.Sleep(350 * time.Millisecond)
	return r.startRuntime()
}

func (r *Runtime) State() RuntimeState {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.state
}

func (r *Runtime) Error() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.err
}

func (r *Runtime) PID() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.cmd == nil || r.cmd.Process == nil {
		return 0
	}
	return r.cmd.Process.Pid
}

func (r *Runtime) Uptime() time.Duration {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.start.IsZero() || r.cmd == nil {
		return 0
	}
	return time.Since(r.start).Round(time.Second)
}

func (r *Runtime) DashboardURL() string {
	hostPort := net.JoinHostPort(r.cfg.Host, fmt.Sprintf("%d", r.cfg.Port))
	u := url.URL{
		Scheme: "http",
		Host:   hostPort,
	}
	return u.String()
}

func (r *Runtime) Logs() []string {
	return r.logs.Lines()
}

func (r *Runtime) LogChannel() <-chan string {
	return r.logCh
}

func (r *Runtime) Done() <-chan struct{} {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.done
}

func (r *Runtime) scan(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		r.AppendLog(scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		r.AppendLog("Log stream error: " + err.Error())
	}
}

func (r *Runtime) watch(cmd *exec.Cmd, cancel context.CancelFunc) {
	err := cmd.Wait()
	cancel()
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cmd == cmd {
		r.cmd = nil
		r.cancel = nil
	}
	if err != nil && r.state != stateStopping && r.state != stateRestarting {
		r.state = stateError
		r.err = err.Error()
		r.appendLocked("Runtime exited: " + err.Error())
	} else if r.state != stateRestarting {
		r.state = stateStopped
		r.appendLocked("Runtime stopped.")
	}
	if r.done != nil {
		close(r.done)
		r.done = nil
	}
}

func (r *Runtime) pollHealth(ctx context.Context) {
	ticker := time.NewTicker(900 * time.Millisecond)
	defer ticker.Stop()
	client := http.Client{Timeout: 1200 * time.Millisecond}
	healthHostPort := net.JoinHostPort(r.cfg.Host, fmt.Sprintf("%d", r.cfg.Port))
	healthURL := url.URL{
		Scheme: "http",
		Host:   healthHostPort,
		Path:   "/gateway/health",
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			resp, err := client.Get(healthURL.String())
			if err != nil {
				continue
			}
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				r.mu.Lock()
				if r.state == stateStarting {
					r.appendLocked("Gateway is healthy.")
				}
				if r.cmd != nil {
					r.state = stateRunning
					r.err = ""
				}
				r.mu.Unlock()
			}
		}
	}
}

func (r *Runtime) AppendLog(line string) {
	r.mu.Lock()
	r.appendLocked(line)
	r.mu.Unlock()
}

func (r *Runtime) appendLocked(line string) {
	line = strings.TrimRight(line, "\r\n")
	if line == "" {
		return
	}
	r.logs.Append(line)
	select {
	case r.logCh <- line:
	default:
	}
}

func nodeLoaderArgs(loader string) []string {
	if loader == "" || !fileExists(loader) {
		return nil
	}
	code := fmt.Sprintf(
		`import { register } from "node:module"; import { pathToFileURL } from "node:url"; register(%q, pathToFileURL("./"));`,
		fileURL(loader),
	)
	return []string{"--import", "data:text/javascript," + url.PathEscape(code)}
}

func fileURL(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	slash := filepath.ToSlash(abs)
	if strings.HasPrefix(slash, "/") {
		return "file://" + slash
	}
	return "file:///" + slash
}

func runtimeEnv(base []string, cfg Config) []string {
	env := append([]string(nil), base...)
	env = setEnv(env, "Hiro_RUNTIME_ROOT", cfg.RuntimeRoot)
	env = setEnv(env, "Hiro_WORKSPACE_DIR", cfg.WorkspaceDir)
	env = setEnv(env, "GATEWAY_HOST", cfg.Host)
	env = setEnv(env, "GATEWAY_PORT", fmt.Sprintf("%d", cfg.Port))
	if cfg.Debug {
		env = setEnv(env, "LOG_LEVEL", "debug")
	}
	return env
}

func setEnv(env []string, key string, value string) []string {
	prefix := strings.ToUpper(key) + "="
	for i, entry := range env {
		if strings.HasPrefix(strings.ToUpper(entry), prefix) {
			env[i] = key + "=" + value
			return env
		}
	}
	return append(env, key+"="+value)
}

func ensurePortAvailable(host string, port int) error {
	address := net.JoinHostPort(host, strconv.Itoa(port))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("port %d is already in use on %s; stop the existing process or choose another --port", port, host)
	}
	return listener.Close()
}
