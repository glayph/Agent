package main

import (
	"fmt"
	"os"

	"golang.org/x/term"
)

func main() {
	cfg, err := parseConfig(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "Miki:", err)
		fmt.Fprintln(os.Stderr, "Run `Miki help` for usage.")
		os.Exit(1)
	}

	switch cfg.Command {
	case commandHelp:
		printHelp()
	case commandVersion:
		fmt.Println(cfg.Version)
	default:
		if cfg.Plain || !term.IsTerminal(int(os.Stdout.Fd())) {
			os.Exit(runPlain(cfg))
		}
		if err := runTUI(cfg); err != nil {
			fmt.Fprintln(os.Stderr, "Miki:", err)
			os.Exit(1)
		}
	}
}
