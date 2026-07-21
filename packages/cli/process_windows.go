//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"strconv"
	"time"
)

func applyProcessAttrs(_ *exec.Cmd) {}

func terminateProcessTree(cmd *exec.Cmd, timeout time.Duration) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	pid := strconv.Itoa(cmd.Process.Pid)
	_ = exec.Command("taskkill", "/T", "/PID", pid).Run()
	if waitProcess(cmd, timeout) {
		return nil
	}
	if err := exec.Command("taskkill", "/F", "/T", "/PID", pid).Run(); err != nil {
		return fmt.Errorf("taskkill failed: %w", err)
	}
	waitProcess(cmd, 2*time.Second)
	return nil
}

func waitProcess(cmd *exec.Cmd, timeout time.Duration) bool {
	if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
		return true
	}
	deadline := time.After(timeout)
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-deadline:
			return cmd.ProcessState != nil && cmd.ProcessState.Exited()
		case <-tick.C:
			if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
				return true
			}
		}
	}
}
