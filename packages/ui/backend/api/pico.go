//go:build legacy_backend

package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httputil"
	"time"

	"github.com/sipeed/miki/pkg/config"
	"github.com/sipeed/miki/pkg/logger"
	ppid "github.com/sipeed/miki/pkg/pid"
)

// registerhiroRoutes binds hiro Channel management endpoints to the ServeMux.
func (h *Handler) registerhiroRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/hiro/info", h.handleGethiroInfo)
	mux.HandleFunc("POST /api/hiro/token", h.handleRegenhiroToken)
	mux.HandleFunc("POST /api/hiro/setup", h.handlehiroSetup)

	// WebSocket proxy: forward /hiro/ws to gateway
	// This allows the frontend to connect via the same port as the web UI,
	// avoiding the need to expose extra ports for WebSocket communication.
	mux.HandleFunc("GET /hiro/ws", h.handleWebSocketProxy())
	mux.HandleFunc("GET /hiro/media/{id}", h.handlehiroMediaProxy())
	mux.HandleFunc("HEAD /hiro/media/{id}", h.handlehiroMediaProxy())
}

// createWsProxy creates a reverse proxy to the current gateway WebSocket endpoint.
// The gateway bind host and port are resolved from the latest configuration.
func (h *Handler) createWsProxy(origProtocol string, upstreamProtocol string) *httputil.ReverseProxy {
	wsProxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			target := h.gatewayProxyURL()
			r.SetURL(target)
			r.Out.Header.Del(protocolKey)
			if upstreamProtocol != "" {
				r.Out.Header.Set(protocolKey, upstreamProtocol)
			}
		},
		ModifyResponse: func(r *http.Response) error {
			if prot := r.Header.Values(protocolKey); len(prot) > 0 {
				r.Header.Del(protocolKey)
				if origProtocol != "" {
					r.Header.Set(protocolKey, origProtocol)
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			logger.Errorf("Failed to proxy WebSocket: %v", err)
			http.Error(w, "Gateway unavailable: "+err.Error(), http.StatusBadGateway)
		},
	}
	return wsProxy
}

func (h *Handler) createhiroHTTPProxy(token string) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			target := h.gatewayProxyURL()
			r.SetURL(target)
			r.Out.Header.Set("Authorization", "Bearer "+token)
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			logger.Errorf("Failed to proxy hiro HTTP request: %v", err)
			http.Error(w, "Gateway unavailable: "+err.Error(), http.StatusBadGateway)
		},
	}
}

func (h *Handler) gatewayAvailableForProxy() bool {
	gateway.mu.Lock()
	ensurehiroTokenCachedLocked(h.configPath)
	cachedPID := gateway.pidData
	trackedCmd := gateway.cmd
	gateway.mu.Unlock()

	if pidData := h.sanitizeGatewayPidData(ppid.ReadPidFileWithCheck(globalConfigDir()), nil); pidData != nil {
		gateway.mu.Lock()
		gateway.pidData = pidData
		setGatewayRuntimeStatusLocked("running")
		gateway.mu.Unlock()
		return true
	}

	if cachedPID == nil {
		return false
	}

	if isCmdProcessAliveLocked(trackedCmd) {
		return true
	}

	gateway.mu.Lock()
	if gateway.cmd == trackedCmd {
		gateway.pidData = nil
		setGatewayRuntimeStatusLocked("stopped")
	}
	available := gateway.pidData != nil
	gateway.mu.Unlock()
	return available
}

func decodehiroSettings(cfg *config.Config) (config.hiroSettings, bool) {
	if cfg == nil {
		return config.hiroSettings{}, false
	}

	bc := cfg.Channels.GetByType(config.Channelhiro)
	if bc == nil {
		return config.hiroSettings{}, false
	}

	var hiroCfg config.hiroSettings
	if err := bc.Decode(&hiroCfg); err != nil {
		return config.hiroSettings{}, false
	}

	return hiroCfg, bc.Enabled
}

func (h *Handler) writehiroInfoResponse(
	w http.ResponseWriter,
	r *http.Request,
	cfg *config.Config,
	changed *bool,
) {
	hiroCfg, enabled := decodehiroSettings(cfg)

	resp := map[string]any{
		"ws_url":  h.buildWsURL(r),
		"enabled": enabled,
	}
	if changed != nil {
		resp["changed"] = *changed
	}
	if hiroCfg.Token.String() != "" {
		resp["configured"] = true
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// handleWebSocketProxy wraps a reverse proxy to handle WebSocket connections.
// It relies on launcher dashboard auth, then injects the raw hiro token only
// on the upstream gateway request.
func (h *Handler) handleWebSocketProxy() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !h.gatewayAvailableForProxy() {
			logger.Warnf("Gateway not available for WebSocket proxy")
			http.Error(w, "Gateway not available", http.StatusServiceUnavailable)
			return
		}

		upstreamProtocol := hiroGatewayProtocol()
		if upstreamProtocol == "" {
			logger.Warn("hiro token unavailable for WebSocket proxy")
			http.Error(w, "hiro channel not configured", http.StatusServiceUnavailable)
			return
		}

		var origProtocol string
		if prot := r.Header.Values(protocolKey); len(prot) > 0 {
			origProtocol = prot[0]
		}

		h.createWsProxy(origProtocol, upstreamProtocol).ServeHTTP(w, r)
	}
}

func (h *Handler) handlehiroMediaProxy() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !h.gatewayAvailableForProxy() {
			logger.Warnf("Gateway not available for hiro media proxy")
			http.Error(w, "Gateway not available", http.StatusServiceUnavailable)
			return
		}

		gateway.mu.Lock()
		hiroToken := gateway.hiroToken
		gateway.mu.Unlock()

		if hiroToken == "" {
			logger.Warnf("Missing hiro token for media proxy")
			http.Error(w, "Invalid hiro token", http.StatusForbidden)
			return
		}

		h.createhiroHTTPProxy(hiroToken).ServeHTTP(w, r)
	}
}

// handleGethiroInfo returns non-secret hiro connection info for the launcher UI.
//
//	GET /api/hiro/info
func (h *Handler) handleGethiroInfo(w http.ResponseWriter, r *http.Request) {
	cfg, err := config.LoadConfig(h.configPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to load config: %v", err), http.StatusInternalServerError)
		return
	}

	h.writehiroInfoResponse(w, r, cfg, nil)
}

// handleRegenhiroToken rotates the raw hiro WebSocket token and returns
// non-secret connection info for the launcher UI.
//
//	POST /api/hiro/token
func (h *Handler) handleRegenhiroToken(w http.ResponseWriter, r *http.Request) {
	cfg, err := config.LoadConfig(h.configPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to load config: %v", err), http.StatusInternalServerError)
		return
	}

	token := generateSecureToken()
	if bc := cfg.Channels.GetByType(config.Channelhiro); bc != nil {
		decoded, err := bc.GetDecoded()
		if err == nil && decoded != nil {
			if settings, ok := decoded.(*config.hiroSettings); ok {
				settings.Token = *config.NewSecureString(token)
			}
		}
	}

	if err := config.SaveConfig(h.configPath, cfg); err != nil {
		http.Error(w, fmt.Sprintf("Failed to save config: %v", err), http.StatusInternalServerError)
		return
	}

	gateway.mu.Lock()
	gateway.hiroToken = token
	gateway.mu.Unlock()

	h.writehiroInfoResponse(w, r, cfg, nil)
}

// EnsurehiroChannel enables the hiro channel with sane defaults if it isn't
// already configured. Returns true when the config was modified.
func (h *Handler) EnsurehiroChannel() (bool, error) {
	cfg, err := config.LoadConfig(h.configPath)
	if err != nil {
		return false, fmt.Errorf("failed to load config: %w", err)
	}

	changed := false

	bc := cfg.Channels.GetByType(config.Channelhiro)
	if bc == nil {
		bc = &config.Channel{Type: config.Channelhiro}
		cfg.Channels["hiro"] = bc
	}

	if !bc.Enabled {
		bc.Enabled = true
		changed = true
	}

	if decoded, err := bc.GetDecoded(); err == nil && decoded != nil {
		if hiroCfg, ok := decoded.(*config.hiroSettings); ok {
			if hiroCfg.Token.String() == "" {
				hiroCfg.Token = *config.NewSecureString(generateSecureToken())
				changed = true
			}
		}
	}

	if changed {
		if err := config.SaveConfig(h.configPath, cfg); err != nil {
			return false, fmt.Errorf("failed to save config: %w", err)
		}
	}

	return changed, nil
}

// handlehiroSetup automatically configures everything needed for the hiro Channel to work.
//
//	POST /api/hiro/setup
func (h *Handler) handlehiroSetup(w http.ResponseWriter, r *http.Request) {
	changed, err := h.EnsurehiroChannel()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Reload config (EnsurehiroChannel may have modified it).
	cfg, err := config.LoadConfig(h.configPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to load config: %v", err), http.StatusInternalServerError)
		return
	}

	h.writehiroInfoResponse(w, r, cfg, &changed)
}

// generateSecureToken creates a random 32-character hex string.
func generateSecureToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// Fallback to something pseudo-random if crypto/rand fails
		return fmt.Sprintf("%032x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
