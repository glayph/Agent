//go:build legacy_backend

package api

import "net/http"

const destructiveConfirmationHeader = "X-Hiro-Confirm"

func requireDestructiveConfirmation(w http.ResponseWriter, r *http.Request, expected string) bool {
	if r.Header.Get(destructiveConfirmationHeader) == expected {
		return true
	}
	http.Error(w, "destructive action confirmation required", http.StatusPreconditionRequired)
	return false
}
