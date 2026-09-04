package main

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRuntimeStartRejectsOccupiedPort(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	gatewayEntry := filepath.Join(t.TempDir(), "index.js")
	if err := os.WriteFile(gatewayEntry, []byte("console.log('unused')\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	port := listener.Addr().(*net.TCPAddr).Port
	rt := NewRuntime(Config{
		GatewayEntry: gatewayEntry,
		NodePath:     "node",
		Host:         "127.0.0.1",
		Port:         port,
	})

	err = rt.Start()
	if err == nil {
		t.Fatal("Start() succeeded on an occupied port")
	}
	if !strings.Contains(err.Error(), "already in use") {
		t.Fatalf("Start() error = %q, want occupied-port message", err)
	}
	if rt.State() != stateError {
		t.Fatalf("State() = %q, want %q", rt.State(), stateError)
	}
	if rt.PID() != 0 {
		t.Fatalf("PID() = %d, want 0", rt.PID())
	}
}

func TestRuntimeStopTerminatesManagedProcess(t *testing.T) {
	workspace := t.TempDir()
	gatewayEntry := filepath.Join(workspace, "gateway.mjs")
	gateway := `import http from "node:http";
const port = Number(process.env.GATEWAY_PORT);
http.createServer((req, res) => {
  if (req.url === "/gateway/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}\\n");
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, process.env.GATEWAY_HOST);
`
	if err := os.WriteFile(gatewayEntry, []byte(gateway), 0o600); err != nil {
		t.Fatal(err)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()

	rt := NewRuntime(Config{
		WorkspaceDir: workspace,
		GatewayEntry: gatewayEntry,
		NodePath:     "node",
		Host:         "127.0.0.1",
		Port:         port,
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for rt.State() != stateRunning && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if rt.State() != stateRunning {
		t.Fatalf("State() = %q, want %q; error=%q", rt.State(), stateRunning, rt.Error())
	}
	if rt.PID() == 0 {
		t.Fatal("PID() = 0 while runtime is running")
	}

	if err := rt.Stop(); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for rt.State() != stateStopped && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if rt.State() != stateStopped {
		t.Fatalf("State() = %q, want %q", rt.State(), stateStopped)
	}
	if rt.PID() != 0 {
		t.Fatalf("PID() = %d after Stop(), want 0", rt.PID())
	}
}
