package main

import (
	"fmt"
	"os"

	"github.com/charmbracelet/glamour"
	"golang.org/x/term"
)

const helpMarkdown = `# Hiro

Minimal terminal control surface for the Hiro agent runtime.

## Usage

` + "```" + `
Hiro [start] [--host <host>] [--port <port>] [--debug] [--plain]
` + "```" + `

## Commands

- **start** - open the TUI and start the runtime
- **help** - show this help
- **version** - show version

## Keys

- **Up/Down** - move through actions
- **Enter/Space** - activate
- **Tab** - switch menu/log focus
- **PgUp/PgDown/Home/End** - scroll logs
- **q/Esc/Ctrl+C** - shutdown prompt
`

func printHelp() {
	if !term.IsTerminal(int(os.Stdout.Fd())) {
		fmt.Print(helpMarkdown)
		return
	}
	renderer, err := glamour.NewTermRenderer(
		glamour.WithAutoStyle(),
		glamour.WithWordWrap(96),
	)
	if err != nil {
		fmt.Print(helpMarkdown)
		return
	}
	out, err := renderer.Render(helpMarkdown)
	if err != nil {
		fmt.Print(helpMarkdown)
		return
	}
	fmt.Print(out)
}
