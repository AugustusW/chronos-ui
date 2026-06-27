// SPDX-License-Identifier: Apache-2.0
package main

import "strings"

const pgKeychainPrefix = "pg:keychain:"

// parseDBDescriptor classifies the --db value. The canonical Postgres descriptor is
// "pg:keychain:<service>" — a NON-secret reference resolved against the OS keychain at runtime
// (spec §3.3; the crontab line must never carry the DSN). Anything else is a SQLite file path.
func parseDBDescriptor(s string) (isPg bool, pgService string) {
	if strings.HasPrefix(s, pgKeychainPrefix) {
		return true, strings.TrimPrefix(s, pgKeychainPrefix)
	}
	return false, ""
}
