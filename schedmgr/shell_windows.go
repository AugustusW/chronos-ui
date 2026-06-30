// SPDX-License-Identifier: Apache-2.0
//go:build windows

package main

import (
	"context"
	"os/exec"
	"strconv"
	"syscall"
	"time"
)

// shellCommand runs the wrapped command through cmd.exe.
//
// cmd.exe does NOT parse its command line with CommandLineToArgvW rules — it has
// its own parser that does not understand the \" escape that Go's os/exec
// (syscall.EscapeArg) emits for an argument containing embedded double quotes. So
// passing the command as a normal exec arg (exec.Command("cmd","/c",command))
// corrupts any command that contains quotes — e.g. a redirect to a quoted spaced
// path like `foo > "C:\My Dir\out.txt"`: the \" reaches cmd verbatim and it
// misreads the redirect target ("The filename, directory name, or volume label
// syntax is incorrect."). Found by the Plan 4b Windows manual test; the adapter's
// winQuoteArg is correct for the schedmgr-argv layer — this break is one layer
// further down, in cmd's own parser.
//
// Fix: build the raw command line ourselves via SysProcAttr.CmdLine so Go does NOT
// re-escape it, and use `cmd /s /c "<command>"`. With /s, cmd strips exactly the
// first and last quote (the outer pair we add) and runs everything in between
// verbatim — so inner quotes around spaced paths, plus &&, |, > operators, all
// survive unchanged.
//
// Invariant: this assumes `command` is a balanced shell line (the adopt path's
// winQuoteArg always emits balanced quotes; the unadopted path is the user's own
// shell text). A trailing UNBALANCED double quote in `command` would be mis-stripped
// by /s — pathological and not produced by either upstream path.
func shellCommand(ctx context.Context, command string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "cmd")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `cmd /s /c "` + command + `"`}
	// On timeout/cancel, kill the WHOLE process tree — not just the top cmd.exe. The default
	// CommandContext cancel kills only cmd.Process, orphaning the command's children (e.g. a script
	// cmd launches), and an orphan holding the stdout/stderr pipe keeps Wait() blocked. This mirrors
	// the unix Setpgid group-kill: `taskkill /T` walks the tree from the pid, `/F` forces it, and
	// WaitDelay is a backstop that forces Wait to return + close the pipes if a descendant lingers
	// (review #8).
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
	}
	cmd.WaitDelay = 2 * time.Second
	return cmd
}
