package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
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

// restartExitCode is what the gateway exits with when the dashboard asked for a restart (see gateway /api/gateway/restart).
const restartExitCode = 75

// autoRestartCeiling caps the wait between automatic restarts, the same ceiling the 24/7 supervisor uses.
const autoRestartCeiling = 3 * time.Minute

// autoRestartResetAfter: a gateway that ran this long before failing starts the backoff from the beginning again.
const autoRestartResetAfter = 5 * time.Minute

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
	// Last "degraded" note written to the log, so the same note is not repeated on every poll.
	lastDegradedNote string
	// gen changes on every user action (start, stop, restart). A pending automatic restart from an earlier
	// generation gives up instead of starting a gateway the user has already stopped.
	gen             uint64
	restartAttempts int
}

// restartBackoff returns the wait before automatic restart attempt n (1 s, 2 s, 4 s ... capped at autoRestartCeiling).
func restartBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 20 {
		attempt = 20
	}
	wait := time.Second * time.Duration(1<<(attempt-1))
	if wait > autoRestartCeiling {
		wait = autoRestartCeiling
	}
	return wait
}

func exitCodeOf(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}

// closeDoneLocked closes the done channel once (callers hold r.mu). Waiters on Done() then see the runtime has stopped for good.
func (r *Runtime) closeDoneLocked() {
	if r.done != nil {
		close(r.done)
		r.done = nil
	}
}

func (r *Runtime) bumpGen() {
	r.mu.Lock()
	r.gen++
	r.mu.Unlock()
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
	r.bumpGen()
	return r.startRuntime()
}

func (r *Runtime) startRuntime() error {
	r.mu.Lock()
	if r.cmd != nil || r.state == stateStarting {
		r.mu.Unlock()
		return nil
	}
	if r.state == stateStopping {
		// Returning nil here used to report a successful start that never happened. Tell the caller to try again.
		r.mu.Unlock()
		return fmt.Errorf("the Miki runtime is still stopping; try again when it has stopped")
	}
	r.logs.Reset()
	r.state = stateStarting
	r.err = ""
	r.start = time.Now()
	r.appendLocked("Starting Miki runtime...")
	r.mu.Unlock()

	if !fileExists(r.cfg.GatewayEntry) {
		return r.failStart(fmt.Errorf("gateway entrypoint not found: %s", r.cfg.GatewayEntry))
	}
	ports := []struct {
		name string
		port int
	}{
		{name: "gateway", port: r.cfg.Port},
		{name: "core", port: r.cfg.CorePort},
		{name: "LiteLLM", port: r.cfg.LiteLLMPort},
	}
	seenPorts := make(map[int]string, len(ports))
	for _, service := range ports {
		if service.port <= 0 {
			continue
		}
		if previous, exists := seenPorts[service.port]; exists {
			return r.failStart(fmt.Errorf("%s port %d conflicts with %s port", service.name, service.port, previous))
		}
		seenPorts[service.port] = service.name
		if err := ensurePortAvailable(r.cfg.Host, service.port); err != nil {
			return r.failStart(fmt.Errorf("%s: %w", service.name, err))
		}
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

	stopRequestPath := filepath.Join(r.cfg.WorkspaceDir, "data", "gateway-stop.request")
	_ = os.MkdirAll(filepath.Dir(stopRequestPath), 0755)
	_ = os.Remove(stopRequestPath)
	_ = os.Remove(gatewayRestartRequestPath(r.cfg.WorkspaceDir))

	r.mu.Lock()
	// Reuse an open done channel: an automatic restart keeps the same one, so waiters are woken only when the runtime stops for good.
	if r.done == nil {
		r.done = make(chan struct{})
	}
	r.cancel = cancel
	r.mu.Unlock()

	if err := cmd.Start(); err != nil {
		cancel()
		return r.failStart(err)
	}

	r.mu.Lock()
	r.cmd = cmd
	r.appendLocked(fmt.Sprintf("Runtime PID: %d", cmd.Process.Pid))
	// Write PID file for daemon mode
	pidDir := filepath.Join(r.cfg.WorkspaceDir, "data")
	_ = os.MkdirAll(pidDir, 0755)
	_ = os.WriteFile(filepath.Join(pidDir, "gateway.pid"), []byte(strconv.Itoa(cmd.Process.Pid)), 0644)
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
	// done stays open on purpose: an automatic restart may still start the gateway, and Stop closes it for good.
	r.appendLocked("Start failed: " + err.Error())
	return err
}

func (r *Runtime) Stop() error {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	r.bumpGen()
	return r.forceStop()
}

// StopDaemon requests a graceful shutdown of a gateway started outside
// this Runtime instance. The launcher/supervisor owns the lifecycle, so do
// not call an unauthenticated HTTP shutdown endpoint. Signal the PID from the
// runtime-owned PID file and leave the supervisor stop marker in place so it
// does not immediately restart the requested shutdown.
func (r *Runtime) StopDaemon() error {
	r.bumpGen()
	pidFile := filepath.Join(r.cfg.WorkspaceDir, "data", "gateway.pid")
	pidBytes, err := os.ReadFile(pidFile)
	if err != nil {
		return fmt.Errorf("no running backend found (PID file missing: %s)", pidFile)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
	if err != nil || pid <= 0 {
		return fmt.Errorf("invalid gateway PID in %s", pidFile)
	}

	dataDir := filepath.Join(r.cfg.WorkspaceDir, "data")
	_ = os.MkdirAll(dataDir, 0755)
	// Keep both lifecycle markers compatible with the regular CLI runtime and
	// the 24/7 supervisor. Only the active supervisor's configured marker is
	// consumed; the extra marker is harmless for standalone runtime use.
	for _, stopFile := range []string{
		filepath.Join(dataDir, "gateway-stop.request"),
		filepath.Join(dataDir, "24-7-gateway-stop.request"),
	} {
		_ = os.WriteFile(stopFile, []byte(fmt.Sprintf("{\"requested_at\":%q,\"pid\":%d}\n", time.Now().UTC().Format(time.RFC3339Nano), pid)), 0600)
	}

	if err := requestProcessStop(pid); err != nil {
		return fmt.Errorf("failed to stop backend PID %d: %w", pid, err)
	}
	fmt.Printf("Miki backend (PID %d) is shutting down...\n", pid)
	_ = os.Remove(pidFile)
	return nil
}

// ForceStop terminates the backend process tree. It is used for Stop,
// Shutdown, and Restart actions initiated by this process.
func (r *Runtime) ForceStop() error {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	r.bumpGen()
	return r.forceStop()
}

func (r *Runtime) forceStop() error {
	r.mu.Lock()
	cmd := r.cmd
	cancel := r.cancel
	done := r.done
	if cmd == nil {
		r.state = stateStopped
		r.closeDoneLocked()
		r.mu.Unlock()
		return nil
	}
	r.state = stateStopping
	r.appendLocked("Force stopping Miki runtime...")
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
		// Wait until the process has really exited (watch closes done). Only then may a new one start on the same port.
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			r.mu.Lock()
			r.state = stateError
			r.err = "the gateway did not exit within 10 seconds"
			r.appendLocked("Stop failed: " + r.err)
			r.mu.Unlock()
			return errors.New(r.err)
		}
	}
	return nil
}

func (r *Runtime) stop() error {
	r.mu.Lock()
	cmd := r.cmd
	cancel := r.cancel
	if cmd == nil {
		r.state = stateStopped
		r.closeDoneLocked()
		r.mu.Unlock()
		return nil
	}
	// Detach: leave backend running, just release our handle
	pid := 0
	if cmd.Process != nil {
		pid = cmd.Process.Pid
	}
	r.state = stateStopped
	r.cmd = nil
	r.cancel = nil
	r.closeDoneLocked()
	r.appendLocked(fmt.Sprintf("Detached from backend (PID: %d). Backend continues running.", pid))
	r.mu.Unlock()

	// Cancel context but do NOT kill the process tree
	if cancel != nil {
		cancel()
	}
	return nil
}

func (r *Runtime) Restart() error {
	r.opMu.Lock()
	defer r.opMu.Unlock()

	r.mu.Lock()
	if r.state == stateStarting || r.state == stateStopping {
		state := r.state
		r.mu.Unlock()
		return fmt.Errorf("the Miki runtime is %s; try the restart again in a moment", state)
	}
	r.gen++
	r.state = stateRestarting
	r.appendLocked("Restart requested.")
	r.mu.Unlock()
	if err := r.forceStop(); err != nil {
		return err
	}
	// The old gateway has exited; wait until its port is free so the new one can bind it (up to 10 s).
	if err := waitForPortFree(r.cfg.Host, r.cfg.Port, 10*time.Second); err != nil {
		return r.failStart(fmt.Errorf("previous gateway still holds the port: %w", err))
	}
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
	requestedStopPath := filepath.Join(r.cfg.WorkspaceDir, "data", "gateway-stop.request")
	requestedStop := fileExists(requestedStopPath)
	if requestedStop {
		_ = os.Remove(requestedStopPath)
	}
	restartPath := gatewayRestartRequestPath(r.cfg.WorkspaceDir)
	// The gateway asked for a restart: exit code 75, or the request file it wrote before exiting.
	restartRequested := exitCodeOf(err) == restartExitCode || fileExists(restartPath)
	if restartRequested {
		_ = os.Remove(restartPath)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cmd == cmd {
		r.cmd = nil
		r.cancel = nil
	}
	ranFor := time.Since(r.start)
	if requestedStop {
		r.state = stateStopped
		r.err = ""
		r.appendLocked("Runtime stopped by gateway shutdown request.")
		r.closeDoneLocked()
		return
	}
	if r.state == stateStopping || r.state == stateRestarting {
		// A Stop or Restart from the user decides what happens next; Restart starts the runtime itself.
		if r.state != stateRestarting {
			r.state = stateStopped
			r.appendLocked("Runtime stopped.")
			r.closeDoneLocked()
		}
		return
	}
	if restartRequested {
		r.restartAttempts = 0
		r.state = stateRestarting
		r.appendLocked("Gateway requested a restart; starting it again.")
		r.scheduleAutoRestartLocked(0)
		return
	}
	// The gateway exited on its own (crash or unexpected exit): start it again, with a growing wait.
	if ranFor >= autoRestartResetAfter {
		r.restartAttempts = 0
	}
	r.restartAttempts++
	wait := restartBackoff(r.restartAttempts)
	if err != nil {
		r.state = stateError
		r.err = err.Error()
		r.appendLocked(fmt.Sprintf("Runtime exited: %s. Restarting in %s.", err.Error(), wait))
	} else {
		r.state = stateError
		r.err = "the gateway exited unexpectedly"
		r.appendLocked(fmt.Sprintf("Runtime exited unexpectedly. Restarting in %s.", wait))
	}
	r.scheduleAutoRestartLocked(wait)
}

// scheduleAutoRestartLocked starts the restart loop for the current generation. Callers hold r.mu.
func (r *Runtime) scheduleAutoRestartLocked(initialWait time.Duration) {
	go r.superviseRestart(r.gen, initialWait)
}

// superviseRestart starts the gateway after wait, and keeps trying with backoff until it starts or the user acts.
// A successful start is watched by watch(), which schedules the next restart if that process fails too.
func (r *Runtime) superviseRestart(gen uint64, wait time.Duration) {
	for {
		time.Sleep(wait)
		r.opMu.Lock()
		r.mu.Lock()
		if r.gen != gen || r.cmd != nil {
			r.mu.Unlock()
			r.opMu.Unlock()
			return
		}
		r.appendLocked("Restarting Miki runtime...")
		r.mu.Unlock()
		err := r.startRuntime()
		r.opMu.Unlock()
		if err == nil {
			return
		}
		r.mu.Lock()
		if r.gen != gen {
			r.mu.Unlock()
			return
		}
		r.restartAttempts++
		wait = restartBackoff(r.restartAttempts)
		r.appendLocked(fmt.Sprintf("Automatic restart failed: %s. Trying again in %s.", err.Error(), wait))
		r.mu.Unlock()
	}
}

func gatewayRestartRequestPath(workspaceDir string) string {
	return filepath.Join(workspaceDir, "data", "gateway-restart.request")
}

// waitForPortFree polls until the port can be bound again, or the timeout passes.
func waitForPortFree(host string, port int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		err := ensurePortAvailable(host, port)
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return err
		}
		time.Sleep(200 * time.Millisecond)
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
			var health struct {
				Status         string   `json:"status"`
				DegradedReason []string `json:"degraded_reasons"`
			}
			// The health body is optional detail; an older gateway without it is still healthy on HTTP 2xx.
			_ = json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&health)
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				r.mu.Lock()
				if health.Status == "degraded" {
					// Running, but something (model, channel, waiting replies) needs attention. Log it once per change.
					note := "Gateway is running but degraded: " + strings.Join(health.DegradedReason, "; ")
					if len(health.DegradedReason) == 0 {
						note = "Gateway is running but degraded."
					}
					if note != r.lastDegradedNote {
						r.lastDegradedNote = note
						r.appendLocked(note)
					}
				} else {
					r.lastDegradedNote = ""
					if r.state == stateStarting {
						r.appendLocked("Gateway is healthy.")
					}
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
	env = setEnv(env, "MIKI_RUNTIME_ROOT", cfg.RuntimeRoot)
	env = setEnv(env, "MIKI_WORKSPACE_DIR", cfg.WorkspaceDir)
	// Legacy mixed-case aliases: older installs / external tooling may
	// still read these directly. readMikiEnv() on the TS side checks
	// MIKI_* first, so these are only a fallback.
	env = setEnv(env, "Miki_RUNTIME_ROOT", cfg.RuntimeRoot)
	env = setEnv(env, "Miki_WORKSPACE_DIR", cfg.WorkspaceDir)
	env = setEnv(env, "MIKI_DATA_DIR", filepath.Join(cfg.WorkspaceDir, "data"))
	env = setEnv(env, "MIKI_CONFIG_DIR", filepath.Join(cfg.WorkspaceDir, "config"))
	env = setEnv(env, "MIKI_GATEWAY_STOP_FILE", filepath.Join(cfg.WorkspaceDir, "data", "gateway-stop.request"))
	env = setEnv(env, "MIKI_GATEWAY_RESTART_FILE", gatewayRestartRequestPath(cfg.WorkspaceDir))
	env = setEnv(env, "GATEWAY_HOST", cfg.Host)
	env = setEnv(env, "GATEWAY_PORT", fmt.Sprintf("%d", cfg.Port))
	if cfg.CorePort > 0 {
		env = setEnv(env, "CORE_PORT", fmt.Sprintf("%d", cfg.CorePort))
	}
	if cfg.LiteLLMPort > 0 {
		env = setEnv(env, "LITELLM_PORT", fmt.Sprintf("%d", cfg.LiteLLMPort))
	}
	if cfg.Debug {
		env = setEnv(env, "LOG_LEVEL", "debug")
	}
	return env
}

// setEnv sets key=value, replacing an existing entry with the same name. Names are case-sensitive on Linux and macOS,
// so the legacy alias Miki_WORKSPACE_DIR must not overwrite MIKI_WORKSPACE_DIR; Windows environments are case-insensitive.
func setEnv(env []string, key string, value string) []string {
	for i, entry := range env {
		if envEntryHasName(entry, key) {
			env[i] = key + "=" + value
			return env
		}
	}
	return append(env, key+"="+value)
}

func envEntryHasName(entry string, key string) bool {
	prefix := key + "="
	if len(entry) < len(prefix) {
		return false
	}
	if goruntime.GOOS == "windows" {
		return strings.EqualFold(entry[:len(prefix)], prefix)
	}
	return entry[:len(prefix)] == prefix
}

func ensurePortAvailable(host string, port int) error {
	address := net.JoinHostPort(host, strconv.Itoa(port))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("port %d is already in use on %s; stop the existing process or choose another --port", port, host)
	}
	return listener.Close()
}
