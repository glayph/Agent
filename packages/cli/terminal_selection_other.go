//go:build !windows

package main

import tea "github.com/charmbracelet/bubbletea"

func enableTerminalTextSelection() tea.Msg {
	return nil
}
