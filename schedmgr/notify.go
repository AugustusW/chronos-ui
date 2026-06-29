// SPDX-License-Identifier: Apache-2.0
package main

import (
	"fmt"
	"os"
	"time"
)

type notifyDeps struct {
	st         *store
	resolveTok func() (string, error)
	send       func(token, chatID, text string) error
	now        func() time.Time
}

// notifyAfterRun is best-effort: every failure path logs to stderr and returns; the caller's exit
// code is unaffected. Called only for non-success, schedule-triggered runs.
func notifyAfterRun(d notifyDeps, jobID int64, result string, exitCode int, ended time.Time, stderr string) {
	if d.st == nil {
		return
	}
	name, notify, err := d.st.readJobNotify(jobID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "schedmgr: notify readJobNotify failed: %v\n", err)
		return
	}
	if !notify {
		return
	}
	ns, found, err := d.st.readNotifySettings()
	if err != nil {
		fmt.Fprintf(os.Stderr, "schedmgr: notify readSettings failed: %v\n", err)
		return
	}
	if !found || !ns.enabled || ns.chatID == "" {
		return
	}
	if ns.windowMin >= 1 {
		var ec *int64
		if result != "timeout" {
			v := int64(exitCode)
			ec = &v
		}
		if err := d.st.insertOutbox(jobID, name, result, ec, ended); err != nil {
			fmt.Fprintf(os.Stderr, "schedmgr: notify insertOutbox failed: %v\n", err)
		}
		return
	}
	// immediate
	token, err := d.resolveTok()
	if err != nil {
		fmt.Fprintf(os.Stderr, "schedmgr: notify token unavailable: %v\n", err)
		return
	}
	var ec *int64
	if result != "timeout" {
		v := int64(exitCode)
		ec = &v
	}
	text := formatImmediate(name, result, ec, 0, ended, stderrTail(stderr, 10, 600))
	if err := d.send(token, ns.chatID, text); err != nil {
		fmt.Fprintf(os.Stderr, "schedmgr: notify send failed: %v\n", err)
	}
}
