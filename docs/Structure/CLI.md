# Hiro-cli — Terminal UI

Go-based terminal launcher with Bubble Tea TUI, plain text mode, runtime supervision,
and Windows-specific process management.

```
Hiro-cli/
├── main.go                         CLI entry point (flag parsing, mode selection)
├── tui.go                          Bubble Tea TUI (terminal UI with spinners, logs, controls)
├── plain.go                        Plain text mode (no TUI, direct stdout)
├── config.go                       CLI configuration (flags, env, config file)
├── runtime.go                      Runtime subprocess supervision (spawn, health, restart)
├── logbuffer.go                    Circular log line buffer for TUI display
├── help.go                         Help text and usage
├── styles.go                       TUI color and style definitions
├── process_unix.go                 Unix process management (signals, etc.)
├── terminal_selection_other.go     Non-Windows terminal detection
├── go.mod / go.sum                 Go module (github.com/Hiro-cli)
├── dist/                           Build output
└── Hiro-cli                  Compiled CLI binary
```
