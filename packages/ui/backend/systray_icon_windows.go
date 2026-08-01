//go:build legacy_backend && (windows)

package main

import _ "embed"

//go:embed icon.ico
var iconICO []byte

func getIcon() []byte {
	return iconICO
}
