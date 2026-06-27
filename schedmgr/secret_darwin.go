// SPDX-License-Identifier: Apache-2.0
//go:build darwin

package main

import (
	"os/exec"
	"strings"
)

// keychainRead reads a generic-password item from the macOS login keychain. The signed schedmgr
// binary must be granted access to the GUI-created item (the cross-binary ACL — see the Plan 2
// Task B real-machine runbook). On any error (no item / ACL denied) resolveDSN uses the 0600 fallback.
func keychainRead(service string) (string, error) {
	out, err := exec.Command("security", "find-generic-password", "-s", service, "-w").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimRight(string(out), "\n"), nil
}
