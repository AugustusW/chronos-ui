// SPDX-License-Identifier: Apache-2.0
//go:build windows

package main

import "errors"

// keychainRead on Windows is not yet implemented (Credential Manager / DPAPI is the target). The
// 0600 file fallback applies until a native impl lands; returning an error routes resolveDSN there.
func keychainRead(service string) (string, error) {
	return "", errors.New("windows keychain read not implemented; using 0600 fallback")
}
