// SPDX-License-Identifier: Apache-2.0
package main

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestKeepLastBytes(t *testing.T) {
	if got := keepLastBytes("hello", 64*1024); got != "hello" {
		t.Fatalf("short string changed: %q", got)
	}
	if got := keepLastBytes(strings.Repeat("a", 100), 10); got != strings.Repeat("a", 10) {
		t.Fatalf("ascii tail wrong: %q", got)
	}
	// Multibyte: '中' is 3 bytes. Keep the last <=10 bytes on a char boundary: 3 whole chars = 9 bytes.
	out := keepLastBytes(strings.Repeat("中", 30), 10)
	if len(out) > 10 {
		t.Fatalf("exceeded maxBytes: %d", len(out))
	}
	if !utf8.ValidString(out) {
		t.Fatalf("produced invalid utf8: %q", out)
	}
	if out != strings.Repeat("中", 3) {
		t.Fatalf("multibyte tail wrong: %q", out)
	}
}
