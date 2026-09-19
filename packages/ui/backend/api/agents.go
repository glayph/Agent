//go:build legacy_backend

package api

import (
	"encoding/json"
	"net/http"
)

func (h *Handler) registerAgentRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/agents", h.handleAgentsList)
	mux.HandleFunc("/api/agents/", h.handleAgentsByIdOrMessages)
	mux.HandleFunc("/api/swarm/status", h.handleSwarmStatus)
}

func (h *Handler) handleAgentsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Mock agent registry response for UI phase
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"agents": []map[string]any{
			{"id": "agent-1", "name": "Miki", "specialist": "miki", "status": "idle"},
			{"id": "agent-2", "name": "Sage", "specialist": "sage", "status": "running"},
		},
	})
}

func (h *Handler) handleAgentsByIdOrMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// e.g. /api/agents/agent-1/messages
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"messages": []map[string]any{
			{"id": "msg-1", "type": "task_delegate", "payload": "Analyze this repo"},
		},
	})
}

func (h *Handler) handleSwarmStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"status": "healthy",
		"active_agents": 2,
		"pending_tasks": 0,
	})
}
