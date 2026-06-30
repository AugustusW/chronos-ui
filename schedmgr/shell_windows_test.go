// SPDX-License-Identifier: Apache-2.0
//go:build windows

package main

import (
	"context"
	"testing"
	"time"
)

// shellCommand must wire a tree-kill on cancel (taskkill /T) + a WaitDelay backstop, otherwise a
// timeout only kills the top cmd.exe and orphans the command's children (review #8). Structural test
// — a full process-tree-kill integration test needs a real Windows process tree.
func TestShellCommandWindowsWiresTreeKill(t *testing.T) {
	cmd := shellCommand(context.Background(), `echo hi`)
	if cmd.Cancel == nil {
		t.Fatal("Cancel must be set so a timeout kills the whole tree, not just cmd.exe")
	}
	if cmd.WaitDelay != 2*time.Second {
		t.Fatalf("WaitDelay backstop = %v, want 2s", cmd.WaitDelay)
	}
	if cmd.SysProcAttr == nil || cmd.SysProcAttr.CmdLine != `cmd /s /c "echo hi"` {
		t.Fatalf("CmdLine = %q, want cmd /s /c \"echo hi\"", cmd.SysProcAttr.CmdLine)
	}
	// Cancel before the process is started must be a safe no-op (cmd.Process is nil).
	if err := cmd.Cancel(); err != nil {
		t.Fatalf("Cancel with no started process should be nil, got %v", err)
	}
}
