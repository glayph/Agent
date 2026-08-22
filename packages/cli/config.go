package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Command string

const (
	commandStart   Command = "start"
	commandHelp    Command = "help"
	commandVersion Command = "version"
)

type Config struct {
	Command       Command
	WorkspaceDir  string
	RuntimeRoot   string
	GatewayEntry  string
	RuntimeLoader string
	NodePath      string
	Host          string
	Port          int
	CorePort      int
	LiteLLMPort   int
	Debug         bool
	Plain         bool
	Version       string
}

func parseConfig(args []string) (Config, error) {
	workspaceDir := firstNonEmpty(os.Getenv("MIKI_WORKSPACE_DIR"), os.Getenv("Miki_WORKSPACE_DIR"), discoverWorkspaceDir())
	runtimeRoot := firstNonEmpty(os.Getenv("MIKI_RUNTIME_ROOT"), os.Getenv("Miki_RUNTIME_ROOT"), defaultRuntimeRoot(workspaceDir))
	cfg := Config{
		Command:       commandStart,
		WorkspaceDir:  workspaceDir,
		RuntimeRoot:   runtimeRoot,
		GatewayEntry:  firstNonEmpty(os.Getenv("MIKI_GATEWAY_ENTRY"), os.Getenv("Miki_GATEWAY_ENTRY"), filepath.Join(runtimeRoot, "packages", "gateway", "dist", "index.js")),
		RuntimeLoader: firstNonEmpty(os.Getenv("MIKI_RUNTIME_LOADER"), os.Getenv("Miki_RUNTIME_LOADER"), filepath.Join(runtimeRoot, "runtime-loader.mjs")),
		NodePath:      firstNonEmpty(os.Getenv("MIKI_NODE"), os.Getenv("Miki_NODE"), "node"),
		Host:          firstNonEmpty(os.Getenv("GATEWAY_HOST"), "127.0.0.1"),
		Port:          intFromEnv("GATEWAY_PORT", 18800),
		CorePort:      intFromEnv("CORE_PORT", 8000),
		LiteLLMPort:   intFromEnv("LITELLM_PORT", 4000),
		Version:       firstNonEmpty(os.Getenv("MIKI_PACKAGE_VERSION"), os.Getenv("Miki_PACKAGE_VERSION"), packageVersion(workspaceDir)),
	}

	for i := 0; i < len(args); i++ {
		arg := strings.TrimSpace(args[i])
		switch {
		case arg == "" || arg == "start":
			cfg.Command = commandStart
		case arg == "help" || arg == "-h" || arg == "--help":
			cfg.Command = commandHelp
		case arg == "version" || arg == "-v" || arg == "--version":
			cfg.Command = commandVersion
		case arg == "--debug" || arg == "-d":
			cfg.Debug = true
		case arg == "--plain":
			cfg.Plain = true
		case arg == "--host":
			i++
			if i >= len(args) || strings.HasPrefix(args[i], "-") {
				return cfg, errors.New("--host requires a value")
			}
			cfg.Host = strings.TrimSpace(args[i])
		case strings.HasPrefix(arg, "--host="):
			cfg.Host = strings.TrimSpace(strings.TrimPrefix(arg, "--host="))
		case arg == "--port":
			i++
			if i >= len(args) || strings.HasPrefix(args[i], "-") {
				return cfg, errors.New("--port requires a value")
			}
			port, err := parsePort(args[i])
			if err != nil {
				return cfg, err
			}
			cfg.Port = port
		case strings.HasPrefix(arg, "--port="):
			port, err := parsePort(strings.TrimPrefix(arg, "--port="))
			if err != nil {
				return cfg, err
			}
			cfg.Port = port
		default:
			return cfg, fmt.Errorf("unknown option: %s", arg)
		}
	}

	if cfg.Host == "" {
		cfg.Host = "127.0.0.1"
	}
	if cfg.Port <= 0 || cfg.Port > 65535 {
		return cfg, fmt.Errorf("invalid gateway port: %d", cfg.Port)
	}
	if cfg.CorePort <= 0 || cfg.CorePort > 65535 {
		return cfg, fmt.Errorf("invalid core port: %d", cfg.CorePort)
	}
	if cfg.LiteLLMPort <= 0 || cfg.LiteLLMPort > 65535 {
		return cfg, fmt.Errorf("invalid LiteLLM port: %d", cfg.LiteLLMPort)
	}
	return cfg, nil
}

func parsePort(value string) (int, error) {
	port, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || port <= 0 || port > 65535 {
		return 0, fmt.Errorf("invalid port: %s", value)
	}
	return port, nil
}

func intFromEnv(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 || parsed > 65535 {
		return fallback
	}
	return parsed
}

func defaultRuntimeRoot(workspaceDir string) string {
	candidate := filepath.Join(workspaceDir, "dist", "runtime")
	if fileExists(filepath.Join(candidate, "packages", "gateway", "dist", "index.js")) {
		return candidate
	}
	return workspaceDir
}

func discoverWorkspaceDir() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	for dir := wd; ; dir = filepath.Dir(dir) {
		if fileExists(filepath.Join(dir, "package.json")) && fileExists(filepath.Join(dir, "bin", "Miki.js")) {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return wd
		}
	}
}

func packageVersion(workspaceDir string) string {
	type packageJSON struct {
		Version string `json:"version"`
	}
	content, err := os.ReadFile(filepath.Join(workspaceDir, "package.json"))
	if err != nil {
		return "1.0.0"
	}
	var pkg packageJSON
	if err := json.Unmarshal(content, &pkg); err != nil || pkg.Version == "" {
		return "1.0.0"
	}
	return pkg.Version
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
