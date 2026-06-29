// SPDX-License-Identifier: Apache-2.0
package main

import (
	"fmt"
	"net/http"
	"os"
	"time"
)

type flushDeps struct {
	st         *store
	resolveTok func() (string, error)
	send       func(token, chatID, text string) error
	limit      int
}

func flushOutbox(d flushDeps) error {
	ns, found, err := d.st.readNotifySettings()
	if err != nil {
		return err
	}
	if !found || !ns.enabled || ns.chatID == "" {
		return nil
	}
	rows, err := d.st.listPendingOutbox(d.limit)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	token, err := d.resolveTok()
	if err != nil {
		fmt.Fprintf(os.Stderr, "schedmgr: notify-flush token unavailable: %v\n", err)
		return nil // best-effort: leave rows pending
	}
	text := formatDigest(rows, ns.windowMin)
	if err := d.send(token, ns.chatID, text); err != nil {
		fmt.Fprintf(os.Stderr, "schedmgr: notify-flush send failed (left pending): %v\n", err)
		return nil
	}
	ids := make([]int64, len(rows))
	for i, r := range rows {
		ids[i] = r.id
	}
	return d.st.markOutboxSent(ids)
}

// runNotifyFlush parses `notify-flush --db <descriptor>` and drains the outbox once.
func runNotifyFlush(args []string) int {
	var dbPath string
	for len(args) > 0 {
		if args[0] == "--db" && len(args) >= 2 {
			dbPath, args = args[1], args[2:]
			continue
		}
		fmt.Fprintf(os.Stderr, "schedmgr: notify-flush: unknown arg %q\n", args[0])
		return 2
	}
	if dbPath == "" {
		fmt.Fprintln(os.Stderr, "schedmgr: notify-flush: --db is required")
		return 2
	}
	st, err := openStore(dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "schedmgr: notify-flush: db open failed: %v\n", err)
		return 0 // best-effort: never error the scheduler
	}
	defer st.close()
	d := flushDeps{
		st:         st,
		resolveTok: resolveNotifyToken,
		send: func(token, chatID, text string) error {
			return sendTelegram(&http.Client{Timeout: 10 * time.Second}, telegramBaseURL, token, chatID, text)
		},
		limit: 100,
	}
	if err := flushOutbox(d); err != nil {
		fmt.Fprintf(os.Stderr, "schedmgr: notify-flush failed: %v\n", err)
	}
	return 0
}
