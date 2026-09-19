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

// registermikiRoutes binds miki Channel management endpoints to the ServeMux.
func (h *Handler) registermikiRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/miki/info", h.handleGetmikiInfo)
	mux.HandleFunc("POST /api/miki/token", h.handleRegenmikiToken)
	mux.HandleFunc("POST /api/miki/setup", h.handlemikiSetup)

	// WebSocket proxy: forward /miki/ws to gateway
	// This allows the frontend to connect via the same port as the web UI,
	// avoiding the need to expose extra ports for WebSocket communication.
	mux.HandleFunc("GET /miki/ws", h.handleWebSocketProxy())
	mux.HandleFunc("GET /miki/media/{id}", h.handlemikiMediaProxy())
	mux.HandleFunc("HEAD /miki/media/{id}", h.handlemikiMediaProxy())
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

func (h *Handler) createmikiHTTPProxy(token string) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			target := h.gatewayProxyURL()
			r.SetURL(target)
			r.Out.Header.Set("Authorization", "Bearer "+token)
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			logger.Errorf("Failed to proxy miki HTTP request: %v", err)
			http.Error(w, "Gateway unavailable: "+err.Error(), http.StatusBadGateway)
		},
	}
}

func (h *Handler) gatewayAvailableForProxy() bool {
	gateway.mu.Lock()
	ensuremikiTokenCachedLocked(h.configPath)
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

func decodemikiSettings(cfg *config.Config) (config.mikiSettings, bool) {
	if cfg == nil {
		return config.mikiSettings{}, false
	}

	bc := cfg.Channels.GetByType(config.Channelmiki)
	if bc == nil {
		return config.mikiSettings{}, false
	}

	var mikiCfg config.mikiSettings
	if err := bc.Decode(&mikiCfg); err != nil {
		return config.mikiSettings{}, false
	}

	return mikiCfg, bc.Enabled
}

func (h *Handler) writemikiInfoResponse(
	w http.ResponseWriter,
	r *http.Request,
	cfg *config.Config,
	changed *bool,
) {
	mikiCfg, enabled := decodemikiSettings(cfg)

	resp := map[string]any{
		"ws_url":  h.buildWsURL(r),
		"enabled": enabled,
	}
	if changed != nil {
		resp["changed"] = *changed
	}
	if mikiCfg.Token.String() != "" {
		resp["configured"] = true
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// handleWebSocketProxy wraps a reverse proxy to handle WebSocket connections.
// It relies on launcher dashboard auth, then injects the raw miki token only
// on the upstream gateway request.
func (h *Handler) handleWebSocketProxy() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !h.gatewayAvailableForProxy() {
			logger.Warnf("Gateway not available for WebSocket proxy")
			http.Error(w, "Gateway not available", http.StatusServiceUnavailable)
			return
		}

		upstreamProtocol := mikiGatewayProtocol()
		if upstreamProtocol == "" {
			logger.Warn("miki token unavailable for WebSocket proxy")
			http.Error(w, "miki channel not configured", http.StatusServiceUnavailable)
			return
		}

		var origProtocol string
		if prot := r.Header.Values(protocolKey); len(prot) > 0 {
			origProtocol = prot[0]
		}

		h.createWsProxy(origProtocol, upstreamProtocol).ServeHTTP(w, r)
	}
}

func (h *Handler) handlemikiMediaProxy() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !h.gatewayAvailableForProxy() {
			logger.Warnf("Gateway not available for miki media proxy")
			http.Error(w, "Gateway not available", http.StatusServiceUnavailable)
			return
		}

		gateway.mu.Lock()
		mikiToken := gateway.mikiToken
		gateway.mu.Unlock()

		if mikiToken == "" {
			logger.Warnf("Missing miki token for media proxy")
			http.Error(w, "Invalid miki token", http.StatusForbidden)
			return
		}

		h.createmikiHTTPProxy(mikiToken).ServeHTTP(w, r)
	}
}

// handleGetmikiInfo returns non-secret miki connection info for the launcher UI.
//
//	GET /api/miki/info
func (h *Handler) handleGetmikiInfo(w http.ResponseWriter, r *http.Request) {
	cfg, err := config.LoadConfig(h.configPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to load config: %v", err), http.StatusInternalServerError)
		return
	}

	h.writemikiInfoResponse(w, r, cfg, nil)
}

// handleRegenmikiToken rotates the raw miki WebSocket token and returns
// non-secret connection info for the launcher UI.
//
//	POST /api/miki/token
func (h *Handler) handleRegenmikiToken(w http.ResponseWriter, r *http.Request) {
	cfg, err := config.LoadConfig(h.configPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to load config: %v", err), http.StatusInternalServerError)
		return
	}

	token := generateSecureToken()
	if bc := cfg.Channels.GetByType(config.Channelmiki); bc != nil {
		decoded, err := bc.GetDecoded()
		if err == nil && decoded != nil {
			if settings, ok := decoded.(*config.mikiSettings); ok {
				settings.Token = *config.NewSecureString(token)
			}
		}
	}

	if err := config.SaveConfig(h.configPath, cfg); err != nil {
		http.Error(w, fmt.Sprintf("Failed to save config: %v", err), http.StatusInternalServerError)
		return
	}

	gateway.mu.Lock()
	gateway.mikiToken = token
	gateway.mu.Unlock()

	h.writemikiInfoResponse(w, r, cfg, nil)
}

// EnsuremikiChannel enables the miki channel with sane defaults if it isn't
// already configured. Returns true when the config was modified.
func (h *Handler) EnsuremikiChannel() (bool, error) {
	cfg, err := config.LoadConfig(h.configPath)
	if err != nil {
		return false, fmt.Errorf("failed to load config: %w", err)
	}

	changed := false

	bc := cfg.Channels.GetByType(config.Channelmiki)
	if bc == nil {
		bc = &config.Channel{Type: config.Channelmiki}
		cfg.Channels["miki"] = bc
	}

	if !bc.Enabled {
		bc.Enabled = true
		changed = true
	}

	if decoded, err := bc.GetDecoded(); err == nil && decoded != nil {
		if mikiCfg, ok := decoded.(*config.mikiSettings); ok {
			if mikiCfg.Token.String() == "" {
				mikiCfg.Token = *config.NewSecureString(generateSecureToken())
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

// handlemikiSetup automatically configures everything needed for the miki Channel to work.
//
//	POST /api/miki/setup
func (h *Handler) handlemikiSetup(w http.ResponseWriter, r *http.Request) {
	changed, err := h.EnsuremikiChannel()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Reload config (EnsuremikiChannel may have modified it).
	cfg, err := config.LoadConfig(h.configPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to load config: %v", err), http.StatusInternalServerError)
		return
	}

	h.writemikiInfoResponse(w, r, cfg, &changed)
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
