package main

import "testing"

func TestParseConfigFlags(t *testing.T) {
	cfg, err := parseConfig([]string{"start", "--host", "0.0.0.0", "--port=19000", "--debug", "--plain"})
	if err != nil {
		t.Fatalf("parseConfig() error = %v", err)
	}
	if cfg.Command != commandStart {
		t.Fatalf("Command = %q, want %q", cfg.Command, commandStart)
	}
	if cfg.Host != "0.0.0.0" {
		t.Fatalf("Host = %q", cfg.Host)
	}
	if cfg.Port != 19000 {
		t.Fatalf("Port = %d", cfg.Port)
	}
	if !cfg.Debug || !cfg.Plain {
		t.Fatalf("Debug/Plain = %v/%v, want true/true", cfg.Debug, cfg.Plain)
	}
}

func TestParseConfigRejectsOldSplitCommands(t *testing.T) {
	for _, arg := range []string{"core", "gateway", "webui"} {
		if _, err := parseConfig([]string{arg}); err == nil {
			t.Fatalf("parseConfig(%q) error = nil, want error", arg)
		}
	}
}
