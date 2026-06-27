// SPDX-License-Identifier: Apache-2.0
//go:build !windows

package main

import (
	"context"
	"os/exec"
	"syscall"
	"time"
)

// shellCommand runs the command through the same shell cron uses (spec §5.2).
//
// The shell runs in its own process group (Setpgid) so a timeout reliably kills the
// whole command tree: /bin/sh may fork children (pipelines, backgrounded jobs) that
// would otherwise be orphaned by a kill aimed only at the shell — and an orphan that
// inherited the stdout/stderr pipe keeps it open, so cmd.Wait() blocks until that child
// exits (the timeout silently never fires; observed on Linux, not macOS). On cancel we
// SIGKILL the negative pid (the whole group); WaitDelay is a backstop that forces Wait
// to return and close the pipes if any descendant still lingers.
func shellCommand(ctx context.Context, command string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", command)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = 2 * time.Second
	return cmd
}
