// SPDX-License-Identifier: Apache-2.0
//go:build windows

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunCommandWindows(t *testing.T) {
	var out bytes.Buffer
	res := runCommand("echo hello & exit 4", &out, nil, 0)
	if res.exitCode != 4 {
		t.Fatalf("want exit 4 (cmd /c fidelity), got %d (err=%v)", res.exitCode, res.err)
	}
	if !strings.Contains(res.stdout, "hello") {
		t.Fatalf("stdout=%q", res.stdout)
	}
	if !strings.Contains(out.String(), "hello") {
		t.Fatalf("tee missing: %q", out.String())
	}
}

// Regression for the Plan 4b D4-chain bug (found by the Windows manual test):
// a wrapped command with EMBEDDED double quotes (around a SPACED path) plus a
// redirect and && must run verbatim through cmd /c. The old
// exec.Command("cmd","/c",command) let Go escape the quotes as \" , which cmd.exe
// does not understand, so the redirect target was corrupted and the output file
// was never written ("The filename, directory name, or volume label syntax is
// incorrect."). The SysProcAttr `cmd /s /c "<command>"` fix passes the raw line so
// the inner quotes survive. (winQuoteArg is correct for the schedmgr-argv layer;
// this is the next layer down — cmd's own parser.)
func TestRunCommandWindowsEmbeddedQuotes(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "sub dir") // a path WITH a space
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(sub, "out.txt")
	// echo a token, redirected to a QUOTED spaced path, then && a second step.
	command := `echo D4_OK> "` + out + `" && echo second-step`
	res := runCommand(command, nil, nil, 0)
	if res.exitCode != 0 {
		t.Fatalf("exit=%d err=%v stderr=%q", res.exitCode, res.err, res.stderr)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("output file not written -> embedded-quote quoting chain broke: %v", err)
	}
	if !strings.Contains(string(data), "D4_OK") {
		t.Fatalf("output content=%q (want D4_OK)", string(data))
	}
}
