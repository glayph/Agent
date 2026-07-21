package main

import (
	"fmt"
	"os"
	"os/signal"
)

func runPlain(cfg Config) int {
	rt := NewRuntime(cfg)
	if err := rt.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "Hiro:", err)
		return 1
	}
	fmt.Println("Hiro")
	fmt.Println("  Dashboard ", rt.DashboardURL())
	fmt.Println("  Stop       Ctrl+C")
	fmt.Println("")

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt)
	defer signal.Stop(signals)

	for {
		select {
		case line := <-rt.LogChannel():
			fmt.Println(line)
		case <-signals:
			_ = rt.Stop()
			return 0
		case <-rt.Done():
			if rt.State() == stateError {
				return 1
			}
			return 0
		}
	}
}
