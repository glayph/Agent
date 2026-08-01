package main

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
