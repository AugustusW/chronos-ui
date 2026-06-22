// SPDX-License-Identifier: Apache-2.0
package main

import "unicode/utf8"

// keepLastBytes returns the last maxBytes bytes of s, advanced forward to the next UTF-8
// character boundary so the result never starts mid-codepoint and never exceeds maxBytes
// (mirrors the TS keepLastBytes in chronos-ui/src/main/db/output.ts; spec §5.5: last 64 KB).
func keepLastBytes(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	start := len(s) - maxBytes
	// Advance past UTF-8 continuation bytes (0b10xxxxxx) to a rune boundary.
	for start < len(s) && !utf8.RuneStart(s[start]) {
		start++
	}
	return s[start:]
}
