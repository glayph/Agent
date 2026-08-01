package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type action int

const (
	actionToggle action = iota
	actionRestart
	actionLogs
	actionShutdown
)

type actionItem struct {
	id    action
	label string
	desc  string
}

type tickMsg time.Time
type logMsg string
type runtimeMsg struct {
	action string
	err    error
}

type tuiModel struct {
	cfg         Config
	runtime     *Runtime
	spinner     spinner.Model
	viewport    viewport.Model
	width       int
	height      int
	selected    int
	focusLogs   bool
	followLogs  bool
	confirmQuit bool
	lastError   string
}

func runTUI(cfg Config) error {
	rt := NewRuntime(cfg)
	program := tea.NewProgram(newTUIModel(cfg, rt), tea.WithAltScreen())
	_, err := program.Run()
	return err
}

func newTUIModel(cfg Config, rt *Runtime) tuiModel {
	spin := spinner.New()
	spin.Spinner = spinner.MiniDot
	spin.Style = lipgloss.NewStyle().Foreground(colorBlue)
	return tuiModel{
		cfg:        cfg,
		runtime:    rt,
		spinner:    spin,
		viewport:   viewport.New(80, 20),
		followLogs: true,
	}
}

func (m tuiModel) Init() tea.Cmd {
	return tea.Batch(tea.DisableMouse, enableTerminalTextSelection, m.spinner.Tick, waitForLog(m.runtime), tick(), runtimeAction("start", m.runtime.Start))
}

func (m tuiModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.resizeViewport()
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		cmds = append(cmds, cmd)
	case tickMsg:
		m.refreshLogs()
		cmds = append(cmds, tick())
	case logMsg:
		m.refreshLogs()
		cmds = append(cmds, waitForLog(m.runtime))
	case runtimeMsg:
		if msg.err != nil {
			m.lastError = msg.err.Error()
			m.runtime.AppendLog(msg.action + " failed: " + msg.err.Error())
		} else {
			m.lastError = ""
		}
	case tea.KeyMsg:
		return m.handleKey(msg, cmds)
	}

	return m, tea.Batch(cmds...)
}

func (m tuiModel) handleKey(msg tea.KeyMsg, cmds []tea.Cmd) (tea.Model, tea.Cmd) {
	if m.confirmQuit {
		switch msg.String() {
		case "enter", " ", "y", "q", "ctrl+c":
			return m, tea.Sequence(runtimeAction("shutdown", m.runtime.Stop), tea.Quit)
		case "esc", "n":
			m.confirmQuit = false
			return m, tea.Batch(cmds...)
		}
	}

	switch msg.String() {
	case "ctrl+c", "q", "esc":
		m.confirmQuit = true
	case "tab":
		m.focusLogs = !m.focusLogs
	case "up", "k":
		if m.focusLogs {
			m.viewport.LineUp(1)
			m.followLogs = false
		} else if m.selected > 0 {
			m.selected--
		}
	case "down", "j":
		if m.focusLogs {
			m.viewport.LineDown(1)
			m.followLogs = m.viewport.AtBottom()
		} else if m.selected < len(m.actions())-1 {
			m.selected++
		}
	case "pgup":
		m.viewport.HalfPageUp()
		m.followLogs = false
	case "pgdown":
		m.viewport.HalfPageDown()
		m.followLogs = m.viewport.AtBottom()
	case "home":
		m.viewport.GotoTop()
		m.followLogs = false
	case "end":
		m.viewport.GotoBottom()
		m.followLogs = true
	case "enter", " ":
		if m.actions()[m.selected].id == actionLogs {
			m.focusLogs = true
			m.followLogs = true
			m.viewport.GotoBottom()
		} else {
			cmds = append(cmds, m.activateSelected())
		}
	}
	return m, tea.Batch(cmds...)
}

func (m tuiModel) View() string {
	if m.width == 0 || m.height == 0 {
		return "Starting Hiro..."
	}
	header := m.renderHeader()
	body := lipgloss.JoinHorizontal(lipgloss.Top, m.renderMenu(), m.renderLogs())
	footer := m.renderFooter()
	return appStyle.Width(m.width).Height(m.height).Render(lipgloss.JoinVertical(lipgloss.Left, header, body, footer))
}

func (m tuiModel) renderHeader() string {
	state := m.runtime.State()
	pill := pillStyle.Copy().Background(statusColor(state)).Render(strings.ToUpper(string(state)))
	leftParts := []string{titleStyle.Render("Hiro"), "  ", pill}
	if err := m.runtime.Error(); err != "" {
		leftParts = append(leftParts, "  ", errorTextStyle.Render(truncateText(err, max(18, m.width/3))))
	}
	left := lipgloss.JoinHorizontal(lipgloss.Center, leftParts...)
	right := fmt.Sprintf("%s  uptime %s", m.runtime.DashboardURL(), formatDuration(m.runtime.Uptime()))
	if lipgloss.Width(left)+lipgloss.Width(right)+6 > m.width {
		right = truncateText(right, max(18, m.width-lipgloss.Width(left)-6))
	}
	gap := strings.Repeat(" ", max(1, m.width-lipgloss.Width(left)-lipgloss.Width(right)-6))
	line := lipgloss.JoinHorizontal(lipgloss.Center, left, gap, descStyle.Render(right))
	return headerStyle.Width(max(0, m.width-4)).Render(line)
}

func (m tuiModel) renderMenu() string {
	items := m.actions()
	rows := make([]string, 0, len(items))
	for i, item := range items {
		style := menuItemStyle.Width(m.menuWidth() - 6)
		cursor := " "
		if i == m.selected && !m.focusLogs {
			style = menuItemSelectedStyle.Width(m.menuWidth() - 6)
			cursor = ">"
		}
		label := item.label
		if item.id == actionToggle {
			label = m.toggleLabel()
		}
		desc := truncateText(item.desc, max(8, m.menuWidth()-10))
		rows = append(rows, style.Render(fmt.Sprintf("%s %s\n  %s", cursor, labelStyle.Render(label), descStyle.Render(desc))))
	}
	title := labelStyle.Render("Controls")
	if m.focusLogs {
		title = descStyle.Render("Controls")
	}
	return panelStyle.Width(m.menuWidth()).Height(m.bodyHeight()).Render(lipgloss.JoinVertical(lipgloss.Left, title, "", m.renderRuntimeSummary(), "", strings.Join(rows, "\n")))
}

func (m tuiModel) renderLogs() string {
	title := labelStyle.Render("Live logs")
	if m.focusLogs {
		title = titleStyle.Render("Live logs")
	}
	content := m.viewport.View()
	if strings.TrimSpace(content) == "" {
		content = descStyle.Render("Waiting for runtime output...")
	}
	return panelStyle.Width(m.logWidth()).Height(m.bodyHeight()).Render(lipgloss.JoinVertical(lipgloss.Left, title, "", logStyle.Render(content)))
}

func (m tuiModel) renderFooter() string {
	text := "Up/Down navigate  Enter action  Tab logs  Q quit"
	if m.focusLogs {
		text = "Logs focused  Wheel/PgUp/PgDown/Home/End scroll  Tab menu  Q quit"
	}
	if m.confirmQuit {
		text = "Shutdown Hiro? Enter confirms, Esc cancels"
	}
	if err := firstNonEmpty(m.lastError, m.runtime.Error()); err != "" {
		text = "Error: " + truncateText(err, max(16, m.width-12))
	}
	return footerStyle.Width(max(0, m.width-2)).Render(text)
}

func (m tuiModel) renderRuntimeSummary() string {
	state := m.runtime.State()
	stateText := strings.ToUpper(string(state))
	switch state {
	case stateRunning:
		stateText = successTextStyle.Render(stateText)
	case stateStarting, stateRestarting:
		stateText = warnTextStyle.Render(stateText)
	case stateError:
		stateText = errorTextStyle.Render(stateText)
	default:
		stateText = descStyle.Render(stateText)
	}

	pid := "-"
	if value := m.runtime.PID(); value > 0 {
		pid = fmt.Sprintf("%d", value)
	}
	port := fmt.Sprintf("%s:%d", m.cfg.Host, m.cfg.Port)
	lines := []string{
		fmt.Sprintf("%s %s", descStyle.Render("Status:"), stateText),
		fmt.Sprintf("%s %s", descStyle.Render("PID:"), pid),
		fmt.Sprintf("%s %s", descStyle.Render("Port:"), truncateText(port, max(8, m.menuWidth()-10))),
	}
	if err := m.runtime.Error(); err != "" {
		lines = append(lines, fmt.Sprintf("%s %s", descStyle.Render("Last error:"), errorTextStyle.Render(truncateText(err, max(8, m.menuWidth()-14)))))
	}
	return strings.Join(lines, "\n")
}

func (m tuiModel) activateSelected() tea.Cmd {
	item := m.actions()[m.selected]
	switch item.id {
	case actionToggle:
		if m.runtime.State() == stateRunning || m.runtime.State() == stateStarting {
			return runtimeAction("stop", m.runtime.Stop)
		}
		return runtimeAction("start", m.runtime.Start)
	case actionRestart:
		return runtimeAction("restart", m.runtime.Restart)
	case actionLogs:
		return func() tea.Msg { return nil }
	case actionShutdown:
		return tea.Sequence(runtimeAction("shutdown", m.runtime.Stop), tea.Quit)
	default:
		return nil
	}
}

func (m tuiModel) actions() []actionItem {
	return []actionItem{
		{id: actionToggle, label: "Start / Stop", desc: "Toggle the runtime"},
		{id: actionRestart, label: "Restart", desc: "Reload gateway and services"},
		{id: actionLogs, label: "Logs", desc: "Focus the live log pane"},
		{id: actionShutdown, label: "Shutdown", desc: "Stop services and exit"},
	}
}

func (m tuiModel) toggleLabel() string {
	switch m.runtime.State() {
	case stateRunning, stateStarting:
		return "Stop"
	default:
		return "Start"
	}
}

func (m *tuiModel) resizeViewport() {
	m.viewport.Width = max(10, m.logWidth()-6)
	m.viewport.Height = max(3, m.bodyHeight()-4)
	m.refreshLogs()
}

func (m *tuiModel) refreshLogs() {
	m.viewport.SetContent(formatLogLines(m.runtime.Logs()))
	if m.followLogs {
		m.viewport.GotoBottom()
	}
}

func (m tuiModel) menuWidth() int {
	if m.width < 92 {
		return max(28, m.width/3)
	}
	return 36
}

func (m tuiModel) logWidth() int {
	return max(30, m.width-m.menuWidth()-6)
}

func (m tuiModel) bodyHeight() int {
	return max(8, m.height-6)
}

func waitForLog(rt *Runtime) tea.Cmd {
	return func() tea.Msg {
		line := <-rt.LogChannel()
		return logMsg(line)
	}
}

func runtimeAction(name string, fn func() error) tea.Cmd {
	return func() tea.Msg {
		return runtimeMsg{action: name, err: fn()}
	}
}

func tick() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func formatDuration(d time.Duration) string {
	if d <= 0 {
		return "0s"
	}
	return d.String()
}

func formatLogLines(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	formatted := make([]string, 0, len(lines))
	var healthCount int
	var lastHealth string
	flushHealth := func() {
		if healthCount == 0 {
			return
		}
		line := lastHealth
		if healthCount > 1 {
			line = fmt.Sprintf("%s  (%d health checks)", lastHealth, healthCount)
		}
		formatted = append(formatted, logHealthStyle.Render(line))
		healthCount = 0
		lastHealth = ""
	}

	for _, line := range lines {
		if isHealthPollLine(line) {
			healthCount++
			lastHealth = line
			continue
		}
		flushHealth()
		formatted = append(formatted, formatLogLine(line))
	}
	flushHealth()
	return strings.Join(formatted, "\n")
}

func formatLogLine(line string) string {
	lower := strings.ToLower(line)
	switch {
	case strings.Contains(lower, "[error]") || strings.Contains(lower, "failed") || strings.Contains(lower, "already in use") || strings.Contains(lower, "runtime exited"):
		return logErrorStyle.Render(line)
	case strings.Contains(lower, "[warn]") || strings.Contains(lower, "stopping") || strings.Contains(lower, "restart"):
		return logWarnStyle.Render(line)
	case strings.Contains(lower, "healthy"):
		return successTextStyle.Render(line)
	default:
		return logStyle.Render(line)
	}
}

func isHealthPollLine(line string) bool {
	return strings.Contains(line, "GET /gateway/health -> 200")
}

func truncateText(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if lipgloss.Width(value) <= limit {
		return value
	}
	if limit <= 3 {
		return strings.Repeat(".", limit)
	}
	runes := []rune(value)
	for len(runes) > 0 && lipgloss.Width(string(runes))+3 > limit {
		runes = runes[:len(runes)-1]
	}
	return string(runes) + "..."
}

func max(a int, b int) int {
	if a > b {
		return a
	}
	return b
}
