// SPDX-License-Identifier: Apache-2.0
package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

func main() { os.Exit(runMain(os.Args[1:])) }

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// runMain parses args and runs the wrapped command, returning the exit code to propagate.
// Layout: run <jobId> --db <path> [--triggered-by schedule|manual] [--timeout <sec>] -- <cmd...>
func runMain(args []string) int {
	if len(args) < 1 || args[0] != "run" {
		fmt.Fprintln(os.Stderr, "schedmgr: usage: schedmgr run <jobId> --db <path> [--triggered-by schedule|manual] [--timeout <sec>] -- <cmd...>")
		return 2
	}
	args = args[1:]
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "schedmgr: missing <jobId>")
		return 2
	}
	jobID, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil {
		fmt.Fprintf(os.Stderr, "schedmgr: bad jobId %q\n", args[0])
		return 2
	}
	args = args[1:]

	var dbPath, triggeredBy string = "", "schedule"
	var timeout time.Duration
	for len(args) > 0 {
		switch args[0] {
		case "--db":
			if len(args) < 2 {
				fmt.Fprintln(os.Stderr, "schedmgr: --db needs a value")
				return 2
			}
			dbPath, args = args[1], args[2:]
		case "--triggered-by":
			if len(args) < 2 {
				fmt.Fprintln(os.Stderr, "schedmgr: --triggered-by needs a value")
				return 2
			}
			triggeredBy, args = args[1], args[2:]
		case "--timeout":
			if len(args) < 2 {
				fmt.Fprintln(os.Stderr, "schedmgr: --timeout needs a value")
				return 2
			}
			secs, e := strconv.Atoi(args[1])
			if e != nil {
				fmt.Fprintf(os.Stderr, "schedmgr: bad --timeout %q\n", args[1])
				return 2
			}
			timeout, args = time.Duration(secs)*time.Second, args[2:]
		case "--":
			args = args[1:]
			return runWrapped(jobID, dbPath, triggeredBy, timeout, args)
		default:
			fmt.Fprintf(os.Stderr, "schedmgr: unknown flag %q\n", args[0])
			return 2
		}
	}
	fmt.Fprintln(os.Stderr, "schedmgr: missing '-- <cmd>'")
	return 2
}

// runWrapped runs the command and records it best-effort. The command always runs; DB errors
// are logged to stderr and never change the exit code (spec §5.4 best-effort).
func runWrapped(jobID int64, dbPath, triggeredBy string, timeout time.Duration, cmdArgs []string) int {
	if len(cmdArgs) == 0 {
		fmt.Fprintln(os.Stderr, "schedmgr: empty command after '--'")
		return 2
	}
	command := joinArgs(cmdArgs)

	var st *store
	if dbPath != "" {
		s, err := openStore(dbPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "schedmgr: db open failed (continuing best-effort): %v\n", err)
		} else {
			st = s
			defer st.close()
		}
	}

	started := time.Now()
	var runID int64
	if st != nil {
		if id, err := st.startRun(jobID, triggeredBy, started); err != nil {
			fmt.Fprintf(os.Stderr, "schedmgr: startRun failed (continuing): %v\n", err)
		} else {
			runID = id
		}
	}

	// Always run via the OS shell (spec §5.2: the same shell cron uses) so pipes, &&, redirects,
	// and globs behave identically. The canonical adopted form passes the original command as a
	// single quoted arg; joinArgs also best-effort space-joins a pre-split argv for simple commands.
	res := runCommand(command, os.Stdout, os.Stderr, timeout)
	ended := time.Now()

	if st != nil && runID > 0 {
		result := "success"
		if res.timedOut {
			result = "timeout"
		} else if res.exitCode != 0 {
			result = "failure"
		}
		if err := st.finishRun(runID, result, started, ended, res.exitCode, res.stdout, res.stderr); err != nil {
			fmt.Fprintf(os.Stderr, "schedmgr: finishRun failed: %v\n", err)
		}
		if err := st.updateJobCache(jobID, ended, result); err != nil {
			fmt.Fprintf(os.Stderr, "schedmgr: updateJobCache failed: %v\n", err)
		}
	}
	return res.exitCode
}

// joinArgs rebuilds a shell command line from the post-'--' args. A single arg (the canonical
// adopted form: the original command line passed as one quoted string) is returned verbatim;
// a pre-split argv is space-joined as a best-effort for simple commands.
func joinArgs(args []string) string {
	return strings.Join(args, " ")
}
