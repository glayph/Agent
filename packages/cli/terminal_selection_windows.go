//go:build windows

package main

import (
	tea "github.com/charmbracelet/bubbletea"
	"golang.org/x/sys/windows"
)

func enableTerminalTextSelection() tea.Msg {
	handle := windows.Stdin
	var mode uint32
	if err := windows.GetConsoleMode(handle, &mode); err != nil {
		return nil
	}
	mode |= windows.ENABLE_EXTENDED_FLAGS | windows.ENABLE_QUICK_EDIT_MODE
	mode &^= windows.ENABLE_MOUSE_INPUT
	_ = windows.SetConsoleMode(handle, mode)
	return nil
}
