package main

import "github.com/charmbracelet/lipgloss"

var (
	colorInk      = lipgloss.Color("#E9EDF1")
	colorMuted    = lipgloss.Color("#8A96A6")
	colorBlue     = lipgloss.Color("#6CB6FF")
	colorGreen    = lipgloss.Color("#7EE787")
	colorYellow   = lipgloss.Color("#F2CC60")
	colorRed      = lipgloss.Color("#FF7B72")
	colorPanel    = lipgloss.Color("#161B22")
	colorBorder   = lipgloss.Color("#30363D")
	colorSelected = lipgloss.Color("#1F6FEB")

	appStyle = lipgloss.NewStyle().
			Foreground(colorInk).
			Background(lipgloss.Color("#0D1117"))

	headerStyle = lipgloss.NewStyle().
			Foreground(colorInk).
			Background(colorPanel).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorBorder).
			Padding(0, 1)

	titleStyle = lipgloss.NewStyle().
			Foreground(colorBlue).
			Bold(true)

	pillStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#0D1117")).
			Background(colorGreen).
			Bold(true).
			Padding(0, 1)

	panelStyle = lipgloss.NewStyle().
			Background(colorPanel).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorBorder).
			Padding(1, 2)

	menuItemStyle = lipgloss.NewStyle().
			Border(lipgloss.NormalBorder(), false, false, false, true).
			BorderForeground(colorBorder).
			Padding(0, 1)

	menuItemSelectedStyle = menuItemStyle.Copy().
				BorderForeground(colorSelected).
				Foreground(colorInk).
				Background(lipgloss.Color("#10233F"))

	labelStyle = lipgloss.NewStyle().
			Bold(true)

	descStyle = lipgloss.NewStyle().
			Foreground(colorMuted)

	errorTextStyle = lipgloss.NewStyle().
			Foreground(colorRed).
			Bold(true)

	warnTextStyle = lipgloss.NewStyle().
			Foreground(colorYellow)

	successTextStyle = lipgloss.NewStyle().
				Foreground(colorGreen)

	logStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#C9D1D9"))

	logErrorStyle = lipgloss.NewStyle().
			Foreground(colorRed)

	logWarnStyle = lipgloss.NewStyle().
			Foreground(colorYellow)

	logHealthStyle = lipgloss.NewStyle().
			Foreground(colorMuted)

	footerStyle = lipgloss.NewStyle().
			Foreground(colorMuted).
			Background(colorPanel).
			Padding(0, 1)
)

func statusColor(state RuntimeState) lipgloss.Color {
	switch state {
	case stateRunning:
		return colorGreen
	case stateStarting, stateRestarting:
		return colorYellow
	case stateError:
		return colorRed
	default:
		return colorMuted
	}
}
