// Package main implements a minimal compatibility stub web server.
//
// IMPORTANT: This is a STUB backend that only registers /api/version and
// /api/health endpoints. The full launcher API (models, config, gateway
// control, etc.) is served by the Node.js launcher-compat API server.
// This Go binary is used only for static file serving and basic health
// checks in environments where the full Node.js backend is not available.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type versionResponse struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Mode    string `json:"mode"`
}

const compatibilityAuthCookie = "miki_compat_auth"

func compatibilityPassword() string {
	if password := strings.TrimSpace(os.Getenv("MIKI_UI_PASSWORD")); password != "" {
		return password
	}
	return "123456789"
}

func compatibilityAuthHandler(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth/status", func(w http.ResponseWriter, r *http.Request) {
		_, err := r.Cookie(compatibilityAuthCookie)
		authenticated := err == nil
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": authenticated, "initialized": true, "session_timeout_minutes": 0})
	})
	mux.HandleFunc("POST /api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Password != compatibilityPassword() {
			http.Error(w, `{"error":"Invalid password"}`, http.StatusUnauthorized)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: compatibilityAuthCookie, Value: "1", Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"default_model_configured":false}`))
	})
	mux.HandleFunc("POST /api/auth/setup", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Password string `json:"password"`
			Confirm  string `json:"confirm"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Password == "" || body.Password != body.Confirm {
			http.Error(w, `{"error":"Passwords do not match"}`, http.StatusBadRequest)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: compatibilityAuthCookie, Value: "1", Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode})
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /api/auth/logout", func(w http.ResponseWriter, _ *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: compatibilityAuthCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
		w.WriteHeader(http.StatusNoContent)
	})
}

func compatibilityStubDefaultPort() string {
	if port := strings.TrimSpace(os.Getenv("GATEWAY_PORT")); port != "" {
		return port
	}
	return "18800"
}

func resolveDistDir(executablePath, cwd string) string {
	candidates := make([]string, 0, 4)
	if cwd != "" {
		candidates = append(candidates, filepath.Join(cwd, "dist"))
	}
	if executablePath != "" {
		exeDir := filepath.Dir(executablePath)
		candidates = append(candidates,
			filepath.Join(exeDir, "..", "..", "..", "frontend", "dist"),
		)
	}
	candidates = append(candidates, "dist")

	seen := map[string]struct{}{}
	for _, candidate := range candidates {
		cleanCandidate := filepath.Clean(candidate)
		if _, ok := seen[cleanCandidate]; ok {
			continue
		}
		seen[cleanCandidate] = struct{}{}
		if _, err := os.Stat(filepath.Join(cleanCandidate, "index.html")); err == nil {
			return cleanCandidate
		}
	}

	if cwd != "" {
		return filepath.Join(cwd, "dist")
	}
	return "dist"
}

func newCompatibilityStubHandler(distDir string) http.Handler {
	mux := http.NewServeMux()
	compatibilityAuthHandler(mux)
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(versionResponse{
			Name:    "miki-web",
			Version: "1.0.0",
			Mode:    "compatibility-stub",
		})
	})
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","mode":"compatibility-stub"}`))
	})

	if _, err := os.Stat(filepath.Join(distDir, "index.html")); err == nil {
		fileServer := http.FileServer(http.Dir(distDir))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				http.NotFound(w, r)
				return
			}
			requested := filepath.Join(distDir, filepath.Clean(r.URL.Path))
			if r.URL.Path != "/" {
				if info, statErr := os.Stat(requested); statErr == nil && !info.IsDir() {
					fileServer.ServeHTTP(w, r)
					return
				}
				if filepath.Ext(r.URL.Path) != "" {
					fileServer.ServeHTTP(w, r)
					return
				}
			}
			http.ServeFile(w, r, filepath.Join(distDir, "index.html"))
		})
	} else {
		mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "miki WebUI assets are not built. Run npm run build.", http.StatusServiceUnavailable)
		})
	}
	return mux
}

func main() {
	host := flag.String("host", "127.0.0.1", "host to bind")
	port := flag.String("port", compatibilityStubDefaultPort(), "port to bind")
	flag.Parse()

	executablePath, err := os.Executable()
	if err != nil {
		executablePath = ""
	}
	distDir := resolveDistDir(executablePath, ".")
	mux := newCompatibilityStubHandler(distDir)

	addr := fmt.Sprintf("%s:%s", *host, *port)
	log.Printf("miki Go compatibility backend listening on http://%s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
