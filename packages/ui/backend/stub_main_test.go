package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestCompatibilityStubDefaultPort(t *testing.T) {
	t.Setenv("GATEWAY_PORT", "")
	if got := compatibilityStubDefaultPort(); got != "18801" {
		t.Fatalf("default port = %q, want 18801", got)
	}

	t.Setenv("GATEWAY_PORT", "19000")
	if got := compatibilityStubDefaultPort(); got != "19000" {
		t.Fatalf("env port = %q, want 19000", got)
	}
}

func TestValidateCompatibilityPortRejectsPrimaryPortByDefault(t *testing.T) {
	t.Setenv("MIKI_ALLOW_COMPATIBILITY_STUB_PRIMARY_PORT", "")
	if err := validateCompatibilityPort("18800"); err == nil {
		t.Fatal("expected primary port to be rejected")
	}
	t.Setenv("MIKI_ALLOW_COMPATIBILITY_STUB_PRIMARY_PORT", "1")
	if err := validateCompatibilityPort("18800"); err != nil {
		t.Fatalf("allow override should pass: %v", err)
	}
}

func TestResolveDistDirUsesFrontendAssetsNextToExecutable(t *testing.T) {
	tempRoot := t.TempDir()
	exeDir := filepath.Join(tempRoot, "packages", "ui", "backend", "dist", "bin")
	frontendDistDir := filepath.Join(tempRoot, "packages", "ui", "frontend", "dist")
	if err := os.MkdirAll(exeDir, 0o755); err != nil {
		t.Fatalf("mkdir exe dir: %v", err)
	}
	if err := os.MkdirAll(frontendDistDir, 0o755); err != nil {
		t.Fatalf("mkdir frontend dist: %v", err)
	}
	if err := os.WriteFile(filepath.Join(frontendDistDir, "index.html"), []byte("<html></html>"), 0o644); err != nil {
		t.Fatalf("write index.html: %v", err)
	}

	got := resolveDistDir(filepath.Join(exeDir, "miki-web"), filepath.Join(tempRoot, "missing"))
	if got != frontendDistDir {
		t.Fatalf("resolveDistDir() = %q, want %q", got, frontendDistDir)
	}
}

func TestCompatibilityStubHealth(t *testing.T) {
	handler := newCompatibilityStubHandler(t.TempDir())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if body := rec.Body.String(); body != `{"status":"ok","mode":"compatibility-stub","backend_role":"compatibility-stub","primary_backend":"node-gateway"}` {
		t.Fatalf("body = %q", body)
	}
	if got := rec.Header().Get("X-Miki-Backend-Role"); got != "compatibility-stub" {
		t.Fatalf("backend role header = %q, want compatibility-stub", got)
	}
}

func TestCompatibilityStubVersion(t *testing.T) {
	handler := newCompatibilityStubHandler(t.TempDir())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/version", nil)

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var body versionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("json decode: %v", err)
	}
	if body.Mode != "compatibility-stub" {
		t.Fatalf("mode = %q, want compatibility-stub", body.Mode)
	}
}
