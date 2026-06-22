// SPDX-License-Identifier: Apache-2.0
//go:build !windows

package main

import (
	"context"
	"os/exec"
)

// shellCommand runs the command through the same shell cron uses (spec §5.2).
func shellCommand(ctx context.Context, command string) *exec.Cmd {
	return exec.CommandContext(ctx, "/bin/sh", "-c", command)
}
