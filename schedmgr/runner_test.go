// SPDX-License-Identifier: Apache-2.0
//go:build !windows

package main

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestRunCommandCapturesAndExits(t *testing.T) {
	var out, errb bytes.Buffer
	res := runCommand("echo hello && echo oops 1>&2", &out, &errb, 0)
	if res.exitCode != 0 {
		t.Fatalf("exit=%d err=%v", res.exitCode, res.err)
	}
	if !strings.Contains(res.stdout, "hello") {
		t.Fatalf("stdout=%q", res.stdout)
	}
	if !strings.Contains(res.stderr, "oops") {
		t.Fatalf("stderr=%q", res.stderr)
	}
	if !strings.Contains(out.String(), "hello") || !strings.Contains(errb.String(), "oops") {
		t.Fatalf("tee missing: out=%q err=%q", out.String(), errb.String())
	}
}

func TestRunCommandExitCodeFidelity(t *testing.T) {
	res := runCommand("exit 7", nil, nil, 0)
	if res.exitCode != 7 {
		t.Fatalf("want exit 7, got %d", res.exitCode)
	}
}

func TestRunCommandTimeout(t *testing.T) {
	start := time.Now()
	res := runCommand("sleep 10", nil, nil, 200*time.Millisecond)
	if time.Since(start) > 3*time.Second {
		t.Fatalf("timeout did not fire")
	}
	if res.exitCode == 0 {
		t.Fatalf("timed-out run should not report success")
	}
	if !res.timedOut {
		t.Fatalf("timedOut flag not set")
	}
}
