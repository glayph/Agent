//go:build !windows

package main

import (
	"errors"
	"os/exec"
	"syscall"
	"time"
)

func applyProcessAttrs(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func terminateProcessTree(cmd *exec.Cmd, timeout time.Duration) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	pid := cmd.Process.Pid
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	if waitProcess(cmd, timeout) {
		return nil
	}
	if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
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
