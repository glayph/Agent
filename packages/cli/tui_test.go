package main

import (
	"strings"
	"testing"
)

func TestTUIActionsStayMinimal(t *testing.T) {
	model := newTUIModel(Config{}, NewRuntime(Config{}))
	actions := model.actions()
	if len(actions) != 4 {
		t.Fatalf("len(actions) = %d, want 4", len(actions))
	}
	want := []action{actionToggle, actionRestart, actionLogs, actionShutdown}
	for i, expected := range want {
		if actions[i].id != expected {
			t.Fatalf("actions[%d] = %v, want %v", i, actions[i].id, expected)
		}
	}
}

func TestFormatLogLinesCollapsesHealthPolls(t *testing.T) {
	got := formatLogLines([]string{
		"[2026-06-01T15:22:19.112Z] [INFO] GET /gateway/health -> 200 (1ms)",
		"[2026-06-01T15:22:20.112Z] [INFO] GET /gateway/health -> 200 (1ms)",
		"[2026-06-01T15:22:21.112Z] [ERROR] Port 18800 is already in use",
	})
	if strings.Count(got, "GET /gateway/health") != 1 {
		t.Fatalf("expected health checks to be collapsed, got %q", got)
	}
	if !strings.Contains(got, "(2 health checks)") {
		t.Fatalf("expected collapsed health count, got %q", got)
	}
	if !strings.Contains(got, "Port 18800 is already in use") {
		t.Fatalf("expected error log to be preserved, got %q", got)
	}
}
