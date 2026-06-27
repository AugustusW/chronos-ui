// SPDX-License-Identifier: Apache-2.0
//go:build linux

package main

import (
	"os/exec"
	"strings"
)

// keychainRead uses libsecret's secret-tool (gnome-keyring / kwallet via the Secret Service API).
// Absent a running keyring the command errors and resolveDSN falls back to the 0600 file.
func keychainRead(service string) (string, error) {
	out, err := exec.Command("secret-tool", "lookup", "service", service).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimRight(string(out), "\n"), nil
}
