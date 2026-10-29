package main

import (
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeGateway writes its PID to data/pids.txt and serves /gateway/health. On its first run it does `firstRunExit`
// (75 = restart requested, anything else = crash); later runs stay up.
func fakeGateway(t *testing.T, firstRunExit int) (workspace string, port int) {
	t.Helper()
	workspace = t.TempDir()
	script := `import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const data = path.join(process.env.MIKI_WORKSPACE_DIR, "data");
fs.mkdirSync(data, { recursive: true });
fs.appendFileSync(path.join(data, "pids.txt"), process.pid + "\n");
const marker = path.join(data, "first-run-done");
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, "1");
  if (` + strconv.Itoa(firstRunExit) + ` === 75) fs.writeFileSync(path.join(data, "gateway-restart.request"), "{}");
  process.exit(` + strconv.Itoa(firstRunExit) + `);
}
http.createServer((req, res) => {
  if (req.url === "/gateway/health") { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
  res.writeHead(404); res.end();
}).listen(Number(process.env.GATEWAY_PORT), process.env.GATEWAY_HOST);
`
	entry := filepath.Join(workspace, "gateway.mjs")
	if err := os.WriteFile(entry, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port = listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	t.Setenv("MIKI_TEST_GATEWAY_ENTRY", entry)
	return workspace, port
}

func runningPIDs(t *testing.T, workspace string) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(workspace, "data", "pids.txt"))
	if err != nil {
		return nil
	}
	return strings.Fields(string(raw))
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return cond()
}

func TestRuntimeRestartsWhenGatewayRequestsRestart(t *testing.T) {
	workspace, port := fakeGateway(t, restartExitCode)
	rt := NewRuntime(Config{WorkspaceDir: workspace, GatewayEntry: filepath.Join(workspace, "gateway.mjs"), NodePath: "node", Host: "127.0.0.1", Port: port})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	defer rt.Stop()
	if !waitFor(t, 20*time.Second, func() bool { return len(runningPIDs(t, workspace)) >= 2 && rt.State() == stateRunning }) {
		t.Fatalf("gateway was not restarted after exit %d; pids=%v state=%q err=%q", restartExitCode, runningPIDs(t, workspace), rt.State(), rt.Error())
	}
	pids := runningPIDs(t, workspace)
	if pids[0] == pids[1] {
		t.Fatalf("restart reused the same process: %v", pids)
	}
}

func TestRuntimeRestartsAfterCrash(t *testing.T) {
	workspace, port := fakeGateway(t, 1)
	rt := NewRuntime(Config{WorkspaceDir: workspace, GatewayEntry: filepath.Join(workspace, "gateway.mjs"), NodePath: "node", Host: "127.0.0.1", Port: port})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	defer rt.Stop()
	if !waitFor(t, 20*time.Second, func() bool { return len(runningPIDs(t, workspace)) >= 2 && rt.State() == stateRunning }) {
		t.Fatalf("gateway was not restarted after a crash; pids=%v state=%q err=%q", runningPIDs(t, workspace), rt.State(), rt.Error())
	}
}

func TestRuntimeStopCancelsPendingAutomaticRestart(t *testing.T) {
	workspace, port := fakeGateway(t, 1)
	rt := NewRuntime(Config{WorkspaceDir: workspace, GatewayEntry: filepath.Join(workspace, "gateway.mjs"), NodePath: "node", Host: "127.0.0.1", Port: port})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	// Wait for the crash, then stop before the first automatic restart (1 s backoff) can fire.
	if !waitFor(t, 10*time.Second, func() bool { return rt.State() == stateError }) {
		t.Fatalf("expected the crash to be seen; state=%q", rt.State())
	}
	if err := rt.Stop(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2500 * time.Millisecond)
	if rt.State() == stateRunning || rt.PID() != 0 {
		t.Fatalf("runtime restarted after the user stopped it: state=%q pid=%d", rt.State(), rt.PID())
	}
	if n := len(runningPIDs(t, workspace)); n != 1 {
		t.Fatalf("expected exactly one gateway process, got %d", n)
	}
}

func TestRestartBackoffGrowsAndCaps(t *testing.T) {
	if restartBackoff(1) != time.Second || restartBackoff(2) != 2*time.Second || restartBackoff(3) != 4*time.Second {
		t.Fatalf("unexpected early backoff: %s %s %s", restartBackoff(1), restartBackoff(2), restartBackoff(3))
	}
	if restartBackoff(50) != autoRestartCeiling {
		t.Fatalf("backoff must cap at %s, got %s", autoRestartCeiling, restartBackoff(50))
	}
}

func TestRuntimeEnvKeepsCanonicalAndLegacyNamesApart(t *testing.T) {
	env := runtimeEnv([]string{"PATH=/bin"}, Config{WorkspaceDir: "/work/ws", RuntimeRoot: "/work/rt"})
	counts := map[string]int{}
	values := map[string]string{}
	for _, entry := range env {
		name, value, _ := strings.Cut(entry, "=")
		counts[name]++
		values[name] = value
	}
	if values["MIKI_WORKSPACE_DIR"] != "/work/ws" {
		t.Fatalf("MIKI_WORKSPACE_DIR = %q, want /work/ws (env: %v)", values["MIKI_WORKSPACE_DIR"], env)
	}
	if values["Miki_WORKSPACE_DIR"] != "/work/ws" {
		t.Fatalf("legacy Miki_WORKSPACE_DIR = %q, want /work/ws", values["Miki_WORKSPACE_DIR"])
	}
	if counts["MIKI_RESTART_FILE"] != 0 || values["MIKI_GATEWAY_RESTART_FILE"] == "" {
		t.Fatalf("MIKI_GATEWAY_RESTART_FILE missing from child environment")
	}
	for name, n := range counts {
		if n > 1 {
			t.Fatalf("%s appears %d times in the child environment", name, n)
		}
	}
}
