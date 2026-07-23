//go:build legacy_backend

package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/sipeed/miki/pkg/config"
	ppid "github.com/sipeed/miki/pkg/pid"
)

func newhiroProxyRequest(method, path string) *http.Request {
	req := httptest.NewRequest(method, "http://launcher.local:18800"+path, nil)
	req.Header.Set("Origin", "http://launcher.local:18800")
	return req
}

func TestEnsurehiroChannel_FreshConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	h := NewHandler(configPath)

	changed, err := h.EnsurehiroChannel()
	if err != nil {
		t.Fatalf("EnsurehiroChannel() error = %v", err)
	}
	if !changed {
		t.Fatal("EnsurehiroChannel() should report changed on a fresh config")
	}

	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}

	bc := cfg.Channels["hiro"]
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	hiroCfg := decoded.(*config.hiroSettings)
	if !bc.Enabled {
		t.Error("expected hiro to be enabled after setup")
	}
	if hiroCfg.Token.String() == "" {
		t.Error("expected a non-empty token after setup")
	}
}

func TestEnsurehiroChannel_DoesNotEnableTokenQuery(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	h := NewHandler(configPath)

	if _, err := h.EnsurehiroChannel(); err != nil {
		t.Fatalf("EnsurehiroChannel() error = %v", err)
	}

	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}

	bc := cfg.Channels["hiro"]
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	hiroCfg := decoded.(*config.hiroSettings)
	if hiroCfg.AllowTokenQuery {
		t.Error("setup must not enable allow_token_query by default")
	}
}

func TestEnsurehiroChannel_LeavesAllowOriginsEmptyByDefault(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	h := NewHandler(configPath)

	if _, err := h.EnsurehiroChannel(); err != nil {
		t.Fatalf("EnsurehiroChannel() error = %v", err)
	}

	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}

	bc := cfg.Channels["hiro"]
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	hiroCfg := decoded.(*config.hiroSettings)
	if len(hiroCfg.AllowOrigins) != 0 {
		t.Errorf("allow_origins = %v, want empty", hiroCfg.AllowOrigins)
	}
}

func TestEnsurehiroChannel_NoOriginConfigurationRequired(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	h := NewHandler(configPath)

	if _, err := h.EnsurehiroChannel(); err != nil {
		t.Fatalf("EnsurehiroChannel() error = %v", err)
	}

	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}

	bc := cfg.Channels["hiro"]
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	hiroCfg := decoded.(*config.hiroSettings)
	if len(hiroCfg.AllowOrigins) != 0 {
		t.Errorf("allow_origins = %v, want empty", hiroCfg.AllowOrigins)
	}
}

func TestEnsurehiroChannel_PreservesUserSettings(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")

	// Pre-configure with custom user settings
	cfg := config.DefaultConfig()
	bc := cfg.Channels["hiro"]
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	hiroCfg := decoded.(*config.hiroSettings)
	bc.Enabled = true
	hiroCfg.SetToken("user-custom-token")
	hiroCfg.AllowTokenQuery = true
	hiroCfg.AllowOrigins = []string{"https://myapp.example.com"}
	if err = config.SaveConfig(configPath, cfg); err != nil {
		t.Fatalf("SaveConfig() error = %v", err)
	}

	h := NewHandler(configPath)

	changed, err := h.EnsurehiroChannel()
	if err != nil {
		t.Fatalf("EnsurehiroChannel() error = %v", err)
	}
	if changed {
		t.Error("EnsurehiroChannel() should not change a fully configured config")
	}

	cfg, err = config.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}

	bc = cfg.Channels["hiro"]
	decoded, err = bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	hiroCfg = decoded.(*config.hiroSettings)
	if hiroCfg.Token.String() != "user-custom-token" {
		t.Errorf("token = %q, want %q", hiroCfg.Token.String(), "user-custom-token")
	}
	if !hiroCfg.AllowTokenQuery {
		t.Error("user's allow_token_query=true must be preserved")
	}
	if len(hiroCfg.AllowOrigins) != 1 || hiroCfg.AllowOrigins[0] != "https://myapp.example.com" {
		t.Errorf("allow_origins = %v, want [https://myapp.example.com]", hiroCfg.AllowOrigins)
	}
}

func TestEnsurehiroChannel_ExistingConfigWithoutSecurityFile(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")

	cfg := config.DefaultConfig()
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if err = os.WriteFile(configPath, raw, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	h := NewHandler(configPath)

	changed, err := h.EnsurehiroChannel()
	if err != nil {
		t.Fatalf("EnsurehiroChannel() error = %v", err)
	}
	if !changed {
		t.Fatal("EnsurehiroChannel() should report changed when hiro is missing")
	}

	cfg, err = config.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}

	bc := cfg.Channels["hiro"]
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	hiroCfg := decoded.(*config.hiroSettings)
	if !bc.Enabled {
		t.Error("expected hiro to be enabled after setup")
	}
	if hiroCfg.Token.String() == "" {
		t.Error("expected a non-empty token after setup")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(configPath), config.SecurityConfigFile)); err != nil {
		t.Fatalf("expected .security.yml to be created: %v", err)
	}
}

func TestEnsurehiroChannel_ConfigureshiroWithoutGateway(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")

	cfg := config.DefaultConfig()
	cfg.Agents.Defaults.ModelName = ""
	if err := config.SaveConfig(configPath, cfg); err != nil {
		t.Fatalf("SaveConfig() error = %v", err)
	}

	h := NewHandler(configPath)
	if _, err := h.EnsurehiroChannel(); err != nil {
		t.Fatalf("EnsurehiroChannel() error = %v", err)
	}

	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}

	bc := cfg.Channels["hiro"]
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	hiroCfg := decoded.(*config.hiroSettings)
	if !bc.Enabled {
		t.Error("expected hiro to be enabled after launcher startup setup")
	}
	if hiroCfg.Token.String() == "" {
		t.Error("expected a non-empty token after launcher startup setup")
	}
}

func TestEnsurehiroChannel_Idempotent(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	h := NewHandler(configPath)

	// First call sets things up
	if _, err := h.EnsurehiroChannel(); err != nil {
		t.Fatalf("first EnsurehiroChannel() error = %v", err)
	}

	cfg1, _ := config.LoadConfig(configPath)
	bc := cfg1.Channels["hiro"]
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	hiroCfg := decoded.(*config.hiroSettings)
	token1 := hiroCfg.Token.String()

	// Second call should be a no-op
	changed, err := h.EnsurehiroChannel()
	if err != nil {
		t.Fatalf("second EnsurehiroChannel() error = %v", err)
	}
	if changed {
		t.Error("second EnsurehiroChannel() should not report changed")
	}

	cfg2, _ := config.LoadConfig(configPath)
	bc = cfg2.Channels["hiro"]
	decoded, err = bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	hiroCfg = decoded.(*config.hiroSettings)
	if hiroCfg.Token.String() != token1 {
		t.Error("token should not change on subsequent calls")
	}
}

func TestHandlehiroSetup_DoesNotPersistRequestOrigin(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	h := NewHandler(configPath)

	req := httptest.NewRequest("POST", "/api/hiro/setup", nil)
	req.Header.Set("Origin", "http://10.0.0.5:3000")
	rec := httptest.NewRecorder()

	h.handlehiroSetup(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}

	bc := cfg.Channels["hiro"]
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	hiroCfg := decoded.(*config.hiroSettings)
	if len(hiroCfg.AllowOrigins) != 0 {
		t.Errorf("allow_origins = %v, want empty", hiroCfg.AllowOrigins)
	}
}

func TestHandlehiroSetup_Response(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	h := NewHandler(configPath)

	req := httptest.NewRequest("POST", "/api/hiro/setup", nil)
	rec := httptest.NewRecorder()

	h.handlehiroSetup(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var resp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if _, ok := resp["token"]; ok {
		t.Error("response must not expose the raw hiro token")
	}
	if resp["ws_url"] == nil || resp["ws_url"] == "" {
		t.Error("response should contain ws_url")
	}
	if resp["enabled"] != true {
		t.Error("response should have enabled=true")
	}
	if resp["changed"] != true {
		t.Error("response should have changed=true on first setup")
	}
	if resp["configured"] != true {
		t.Error("response should have configured=true")
	}
}

func TestHandleGethiroInfo_OmitsToken(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	h := NewHandler(configPath)

	if _, err := h.EnsurehiroChannel(); err != nil {
		t.Fatalf("EnsurehiroChannel() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://launcher.local/api/hiro/info", nil)
	rec := httptest.NewRecorder()

	h.handleGethiroInfo(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var resp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if _, ok := resp["token"]; ok {
		t.Fatal("info response must not expose the raw hiro token")
	}
	if resp["enabled"] != true {
		t.Fatalf("enabled = %#v, want true", resp["enabled"])
	}
	if resp["configured"] != true {
		t.Fatalf("configured = %#v, want true", resp["configured"])
	}
	if resp["ws_url"] == nil || resp["ws_url"] == "" {
		t.Fatal("response should contain ws_url")
	}
}

func TestHandleRegenhiroToken_RefreshesGatewayTokenCache(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	h := NewHandler(configPath)

	if _, err := h.EnsurehiroChannel(); err != nil {
		t.Fatalf("EnsurehiroChannel() error = %v", err)
	}

	orighiroToken := gateway.hiroToken
	t.Cleanup(func() {
		gateway.mu.Lock()
		gateway.hiroToken = orighiroToken
		gateway.mu.Unlock()
	})

	gateway.mu.Lock()
	gateway.hiroToken = "stale-token"
	gateway.mu.Unlock()

	req := httptest.NewRequest(http.MethodPost, "http://launcher.local/api/hiro/token", nil)
	rec := httptest.NewRecorder()
	h.handleRegenhiroToken(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}

	bc := cfg.Channels["hiro"]
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	token := decoded.(*config.hiroSettings).Token.String()
	if token == "" {
		t.Fatal("expected regenerated hiro token to be persisted")
	}
	if token == "stale-token" {
		t.Fatal("expected regenerated hiro token to differ from stale cache")
	}

	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	if gateway.hiroToken != token {
		t.Fatalf("gateway.hiroToken = %q, want %q", gateway.hiroToken, token)
	}
}

func TestHandleWebSocketProxyReloadsGatewayTargetFromConfig(t *testing.T) {
	origMatcher := gatewayProcessMatcher
	gatewayProcessMatcher = func(int) (bool, bool) { return true, true }
	t.Cleanup(func() { gatewayProcessMatcher = origMatcher })

	home := t.TempDir()
	t.Setenv("miki_HOME", home)

	configPath := filepath.Join(t.TempDir(), "config.json")
	h := NewHandler(configPath)
	handler := h.handleWebSocketProxy()

	server1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/hiro/ws" {
			t.Fatalf("server1 path = %q, want %q", r.URL.Path, "/hiro/ws")
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "server1")
	}))
	defer server1.Close()

	server2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/hiro/ws" {
			t.Fatalf("server2 path = %q, want %q", r.URL.Path, "/hiro/ws")
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "server2")
	}))
	defer server2.Close()

	cfg := config.DefaultConfig()
	cfg.Gateway.Host = "127.0.0.1"
	cfg.Gateway.Port = mustGatewayTestPort(t, server1.URL)
	if err := config.SaveConfig(configPath, cfg); err != nil {
		t.Fatalf("SaveConfig() error = %v", err)
	}
	cmd := startGatewayLikeProcess(t)
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	})
	writeTestPidFile(t, ppid.PidFileData{
		PID:   cmd.Process.Pid,
		Token: "test-token",
		Host:  cfg.Gateway.Host,
		Port:  cfg.Gateway.Port,
	})
	origPidData := gateway.pidData
	orighiroToken := gateway.hiroToken
	t.Cleanup(func() {
		ppid.RemovePidFile(globalConfigDir())
		gateway.pidData = origPidData
		gateway.hiroToken = orighiroToken
	})

	gateway.pidData = &ppid.PidFileData{}
	gateway.hiroToken = "hiro"
	req1 := newhiroProxyRequest(http.MethodGet, "/hiro/ws")
	rec1 := httptest.NewRecorder()
	handler(rec1, req1)

	if rec1.Code != http.StatusOK {
		t.Fatalf("first status = %d, want %d", rec1.Code, http.StatusOK)
	}
	if body := rec1.Body.String(); body != "server1" {
		t.Fatalf("first body = %q, want %q", body, "server1")
	}

	cfg.Gateway.Port = mustGatewayTestPort(t, server2.URL)
	if err := config.SaveConfig(configPath, cfg); err != nil {
		t.Fatalf("SaveConfig() error = %v", err)
	}

	req2 := newhiroProxyRequest(http.MethodGet, "/hiro/ws")
	rec2 := httptest.NewRecorder()
	handler(rec2, req2)

	if rec2.Code != http.StatusOK {
		t.Fatalf("second status = %d, want %d", rec2.Code, http.StatusOK)
	}
	if body := rec2.Body.String(); body != "server2" {
		t.Fatalf("second body = %q, want %q", body, "server2")
	}
}

func TestHandleWebSocketProxyLoadsCachedhiroTokenWhenMissing(t *testing.T) {
	origMatcher := gatewayProcessMatcher
	gatewayProcessMatcher = func(int) (bool, bool) { return true, true }
	t.Cleanup(func() { gatewayProcessMatcher = origMatcher })

	home := t.TempDir()
	t.Setenv("miki_HOME", home)

	configPath := filepath.Join(t.TempDir(), "config.json")
	h := NewHandler(configPath)
	handler := h.handleWebSocketProxy()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/hiro/ws" {
			t.Fatalf("path = %q, want %q", r.URL.Path, "/hiro/ws")
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "proxied")
	}))
	defer server.Close()

	cfg := config.DefaultConfig()
	cfg.Gateway.Host = "127.0.0.1"
	cfg.Gateway.Port = mustGatewayTestPort(t, server.URL)
	bc := cfg.Channels["hiro"]
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	hiroCfg := decoded.(*config.hiroSettings)
	bc.Enabled = true
	hiroCfg.SetToken("cached-token")
	if err := config.SaveConfig(configPath, cfg); err != nil {
		t.Fatalf("SaveConfig() error = %v", err)
	}
	cmd := startGatewayLikeProcess(t)
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	})
	writeTestPidFile(t, ppid.PidFileData{
		PID:   cmd.Process.Pid,
		Token: "test-token",
		Host:  cfg.Gateway.Host,
		Port:  cfg.Gateway.Port,
	})
	t.Cleanup(func() {
		ppid.RemovePidFile(globalConfigDir())
	})

	origPidData := gateway.pidData
	orighiroToken := gateway.hiroToken
	t.Cleanup(func() {
		gateway.pidData = origPidData
		gateway.hiroToken = orighiroToken
	})

	gateway.pidData = &ppid.PidFileData{}
	gateway.hiroToken = ""

	req := newhiroProxyRequest(http.MethodGet, "/hiro/ws?session_id=test-session")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if body := rec.Body.String(); body != "proxied" {
		t.Fatalf("body = %q, want %q", body, "proxied")
	}
	if gateway.hiroToken != "cached-token" {
		t.Fatalf("gateway.hiroToken = %q, want %q", gateway.hiroToken, "cached-token")
	}
}

func TestHandleWebSocketProxyLoadsPidDataOnDemand(t *testing.T) {
	origMatcher := gatewayProcessMatcher
	gatewayProcessMatcher = func(int) (bool, bool) { return true, true }
	t.Cleanup(func() { gatewayProcessMatcher = origMatcher })

	home := t.TempDir()
	t.Setenv("miki_HOME", home)

	configPath := filepath.Join(t.TempDir(), "config.json")
	h := NewHandler(configPath)
	handler := h.handleWebSocketProxy()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/hiro/ws" {
			t.Fatalf("path = %q, want %q", r.URL.Path, "/hiro/ws")
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, r.Header.Get(protocolKey))
	}))
	defer server.Close()

	cfg := config.DefaultConfig()
	cfg.Gateway.Host = "127.0.0.1"
	cfg.Gateway.Port = mustGatewayTestPort(t, server.URL)
	bc := cfg.Channels["hiro"]
	bc.Enabled = true
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	decoded.(*config.hiroSettings).SetToken("ui-token")
	if err := config.SaveConfig(configPath, cfg); err != nil {
		t.Fatalf("SaveConfig() error = %v", err)
	}

	cmd := startGatewayLikeProcess(t)
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	})
	pidData := ppid.PidFileData{
		PID:   cmd.Process.Pid,
		Token: "test-token",
		Host:  cfg.Gateway.Host,
		Port:  cfg.Gateway.Port,
	}
	writeTestPidFile(t, pidData)
	t.Cleanup(func() {
		ppid.RemovePidFile(globalConfigDir())
	})

	origPidData := gateway.pidData
	orighiroToken := gateway.hiroToken
	origStatus := gateway.runtimeStatus
	t.Cleanup(func() {
		gateway.mu.Lock()
		gateway.pidData = origPidData
		gateway.hiroToken = orighiroToken
		gateway.runtimeStatus = origStatus
		gateway.mu.Unlock()
	})

	gateway.mu.Lock()
	gateway.pidData = nil
	gateway.hiroToken = ""
	setGatewayRuntimeStatusLocked("stopped")
	gateway.mu.Unlock()

	req := newhiroProxyRequest(http.MethodGet, "/hiro/ws?session_id=test-session")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	expected := tokenPrefix + "ui-token"
	if got := rec.Body.String(); got != expected {
		t.Fatalf("forwarded protocol = %q, want %q", got, expected)
	}

	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	if gateway.pidData == nil {
		t.Fatal("gateway.pidData should be loaded from pid file")
	}
	if gateway.runtimeStatus != "running" {
		t.Fatalf("runtimeStatus = %q, want %q", gateway.runtimeStatus, "running")
	}
}

func TestCreatehiroHTTPProxyInjectsGatewayAuth(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	h := NewHandler(configPath)

	cfg := config.DefaultConfig()
	cfg.Gateway.Host = "127.0.0.1"
	cfg.Gateway.Port = 18790
	bc := cfg.Channels["hiro"]
	bc.Enabled = true
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	decoded.(*config.hiroSettings).SetToken("ui-token")
	if err := config.SaveConfig(configPath, cfg); err != nil {
		t.Fatalf("SaveConfig() error = %v", err)
	}

	proxy := h.createhiroHTTPProxy("ui-token")
	var capturedPath string
	var capturedAuth string
	proxy.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		capturedPath = req.URL.Path
		capturedAuth = req.Header.Get("Authorization")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("proxied")),
			Request:    req,
		}, nil
	})

	req := httptest.NewRequest(http.MethodGet, "/hiro/media/attachment-1", nil)
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if capturedPath != "/hiro/media/attachment-1" {
		t.Fatalf("capturedPath = %q, want %q", capturedPath, "/hiro/media/attachment-1")
	}
	expected := "Bearer ui-token"
	if capturedAuth != expected {
		t.Fatalf("Authorization = %q, want %q", capturedAuth, expected)
	}
}

func TestHandlehiroMediaProxyUsesRawBearerToken(t *testing.T) {
	home := t.TempDir()
	t.Setenv("miki_HOME", home)

	configPath := filepath.Join(t.TempDir(), "config.json")
	h := NewHandler(configPath)
	handler := h.handlehiroMediaProxy()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/hiro/media/attachment-1" {
			t.Fatalf("path = %q, want %q", r.URL.Path, "/hiro/media/attachment-1")
		}
		if got := r.Header.Get("Authorization"); got != "Bearer ui-token" {
			t.Fatalf("Authorization = %q, want %q", got, "Bearer ui-token")
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "proxied-media")
	}))
	defer server.Close()

	cfg := config.DefaultConfig()
	cfg.Gateway.Host = "127.0.0.1"
	cfg.Gateway.Port = mustGatewayTestPort(t, server.URL)
	bc := cfg.Channels["hiro"]
	bc.Enabled = true
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	decoded.(*config.hiroSettings).SetToken("ui-token")
	if err := config.SaveConfig(configPath, cfg); err != nil {
		t.Fatalf("SaveConfig() error = %v", err)
	}

	cmd := startGatewayLikeProcess(t)
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	})

	origPidData := gateway.pidData
	orighiroToken := gateway.hiroToken
	origCmd := gateway.cmd
	t.Cleanup(func() {
		gateway.mu.Lock()
		gateway.pidData = origPidData
		gateway.hiroToken = orighiroToken
		gateway.cmd = origCmd
		gateway.mu.Unlock()
	})

	gateway.mu.Lock()
	gateway.pidData = &ppid.PidFileData{PID: cmd.Process.Pid}
	gateway.hiroToken = "ui-token"
	gateway.cmd = cmd
	gateway.mu.Unlock()

	req := newhiroProxyRequest(http.MethodGet, "/hiro/media/attachment-1")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if body := rec.Body.String(); body != "proxied-media" {
		t.Fatalf("body = %q, want %q", body, "proxied-media")
	}
}

func TestHandleWebSocketProxyRejectsStalePidDataAfterProcessExit(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)
	t.Setenv("miki_HOME", filepath.Join(tmpDir, ".miki"))

	configPath := filepath.Join(tmpDir, "config.json")
	h := NewHandler(configPath)
	handler := h.handleWebSocketProxy()

	cfg := config.DefaultConfig()
	bc := cfg.Channels["hiro"]
	bc.Enabled = true
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	decoded.(*config.hiroSettings).SetToken("ui-token")
	if err := config.SaveConfig(configPath, cfg); err != nil {
		t.Fatalf("SaveConfig() error = %v", err)
	}

	cmd := startLongRunningProcess(t)
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	_ = cmd.Wait()

	origPidData := gateway.pidData
	orighiroToken := gateway.hiroToken
	origCmd := gateway.cmd
	origStatus := gateway.runtimeStatus
	t.Cleanup(func() {
		gateway.mu.Lock()
		gateway.pidData = origPidData
		gateway.hiroToken = orighiroToken
		gateway.cmd = origCmd
		gateway.runtimeStatus = origStatus
		gateway.mu.Unlock()
	})

	gateway.mu.Lock()
	gateway.pidData = &ppid.PidFileData{PID: cmd.Process.Pid, Token: "stale-token"}
	gateway.hiroToken = "ui-token"
	gateway.cmd = cmd
	setGatewayRuntimeStatusLocked("running")
	gateway.mu.Unlock()

	req := newhiroProxyRequest(http.MethodGet, "/hiro/ws?session_id=test-session")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	if gateway.pidData != nil {
		t.Fatal("gateway.pidData should be cleared after stale process exit is detected")
	}
}

func TestHandleWebSocketProxy_AllowsArbitraryOrigin(t *testing.T) {
	origMatcher := gatewayProcessMatcher
	gatewayProcessMatcher = func(int) (bool, bool) { return true, true }
	t.Cleanup(func() { gatewayProcessMatcher = origMatcher })

	home := t.TempDir()
	t.Setenv("miki_HOME", home)

	configPath := filepath.Join(t.TempDir(), "config.json")
	h := NewHandler(configPath)
	handler := h.handleWebSocketProxy()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/hiro/ws" {
			t.Fatalf("path = %q, want %q", r.URL.Path, "/hiro/ws")
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "proxied")
	}))
	defer server.Close()

	cfg := config.DefaultConfig()
	cfg.Gateway.Host = "127.0.0.1"
	cfg.Gateway.Port = mustGatewayTestPort(t, server.URL)
	bc := cfg.Channels["hiro"]
	bc.Enabled = true
	decoded, err := bc.GetDecoded()
	if err != nil {
		t.Fatalf("GetDecoded() error = %v", err)
	}
	decoded.(*config.hiroSettings).SetToken("ui-token")
	if err := config.SaveConfig(configPath, cfg); err != nil {
		t.Fatalf("SaveConfig() error = %v", err)
	}

	cmd := startGatewayLikeProcess(t)
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	})
	writeTestPidFile(t, ppid.PidFileData{
		PID:   cmd.Process.Pid,
		Token: "test-token",
		Host:  cfg.Gateway.Host,
		Port:  cfg.Gateway.Port,
	})
	t.Cleanup(func() {
		ppid.RemovePidFile(globalConfigDir())
	})

	origPidData := gateway.pidData
	orighiroToken := gateway.hiroToken
	t.Cleanup(func() {
		gateway.pidData = origPidData
		gateway.hiroToken = orighiroToken
	})

	gateway.pidData = &ppid.PidFileData{}
	gateway.hiroToken = "ui-token"

	req := httptest.NewRequest(http.MethodGet, "http://launcher.local/hiro/ws?session_id=test-session", nil)
	req.Header.Set("Origin", "http://evil.example")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func mustGatewayTestPort(t *testing.T, rawURL string) int {
	t.Helper()

	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("url.Parse() error = %v", err)
	}

	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatalf("Atoi(%q) error = %v", parsed.Port(), err)
	}

	return port
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}
