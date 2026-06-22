// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"time"
)

type runResult struct {
	exitCode int
	stdout   string
	stderr   string
	timedOut bool
	err      error
}

// runCommand executes command through the OS shell, tee-ing stdout/stderr to the provided
// writers (typically os.Stdout/os.Stderr, so cron MAILTO and shell chaining behave normally)
// while capturing them for the DB. It returns the child's exact exit code (architect R2/R3).
// timeout <= 0 means no timeout.
func runCommand(command string, outW, errW io.Writer, timeout time.Duration) runResult {
	ctx := context.Background()
	var cancel context.CancelFunc
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	cmd := shellCommand(ctx, command)
	return execCmd(ctx, cmd, outW, errW)
}

// execCmd wires stdout/stderr tee writers, runs the command, and maps the result.
func execCmd(ctx context.Context, cmd *exec.Cmd, outW, errW io.Writer) runResult {

	var outBuf, errBuf bytes.Buffer
	if outW != nil {
		cmd.Stdout = io.MultiWriter(outW, &outBuf)
	} else {
		cmd.Stdout = &outBuf
	}
	if errW != nil {
		cmd.Stderr = io.MultiWriter(errW, &errBuf)
	} else {
		cmd.Stderr = &errBuf
	}

	err := cmd.Run()
	res := runResult{stdout: outBuf.String(), stderr: errBuf.String()}
	res.timedOut = ctx.Err() == context.DeadlineExceeded

	switch {
	case err == nil:
		res.exitCode = 0
	default:
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			res.exitCode = exitErr.ExitCode() // exact child exit code
		} else {
			res.exitCode = 1
			res.err = err
		}
	}
	if res.timedOut && res.exitCode == 0 {
		res.exitCode = 1
	}
	return res
}
