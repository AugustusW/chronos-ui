// SPDX-License-Identifier: Apache-2.0
package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func depsWith(st *store, sent *[]string, tokErr error) notifyDeps {
	return notifyDeps{
		st:         st,
		resolveTok: func() (string, error) { if tokErr != nil { return "", tokErr }; return "TOK", nil },
		send:       func(_, chat, text string) error { *sent = append(*sent, chat+"|"+text); return nil },
		now:        func() time.Time { return time.UnixMilli(2000) },
	}
}

func TestNotifyImmediateSendsWhenEligible(t *testing.T) {
	st := newTestSqliteStore(t)
	mustExec(t, st, `INSERT INTO notify_settings (id,enabled,chatId,windowMin,updatedAt) VALUES (1,1,'42',0,0)`)
	jobID := insertTestJob(t, st, "backup", true)
	var sent []string
	notifyAfterRun(depsWith(st, &sent, nil), jobID, "failure", 1, time.UnixMilli(1000), "oops")
	if len(sent) != 1 {
		t.Fatalf("expected 1 immediate send, got %d", len(sent))
	}
	if !strings.HasPrefix(sent[0], "42|") {
		t.Fatalf("expected sent[0] to start with '42|', got %q", sent[0])
	}
	if !strings.Contains(sent[0], "backup failed") {
		t.Fatalf("expected sent[0] to contain 'backup failed', got %q", sent[0])
	}
}

func TestNotifyBatchedEnqueuesNoSend(t *testing.T) {
	st := newTestSqliteStore(t)
	mustExec(t, st, `INSERT INTO notify_settings (id,enabled,chatId,windowMin,updatedAt) VALUES (1,1,'42',5,0)`)
	jobID := insertTestJob(t, st, "backup", true)
	var sent []string
	notifyAfterRun(depsWith(st, &sent, nil), jobID, "failure", 1, time.UnixMilli(1000), "oops")
	if len(sent) != 0 {
		t.Fatalf("batched mode must not send immediately")
	}
	pending, _ := st.listPendingOutbox(100)
	if len(pending) != 1 {
		t.Fatalf("expected 1 outbox row, got %d", len(pending))
	}
}

func TestNotifySkippedWhenOptedOutOrDisabled(t *testing.T) {
	for _, tc := range []struct{ name string; settingsSQL string; notify bool }{
		{"job opted out", `INSERT INTO notify_settings (id,enabled,chatId,windowMin,updatedAt) VALUES (1,1,'42',0,0)`, false},
		{"globally disabled", `INSERT INTO notify_settings (id,enabled,chatId,windowMin,updatedAt) VALUES (1,0,'42',0,0)`, true},
		{"no chat id", `INSERT INTO notify_settings (id,enabled,chatId,windowMin,updatedAt) VALUES (1,1,NULL,0,0)`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := newTestSqliteStore(t)
			mustExec(t, st, tc.settingsSQL)
			jobID := insertTestJob(t, st, "j", tc.notify)
			var sent []string
			notifyAfterRun(depsWith(st, &sent, nil), jobID, "failure", 1, time.UnixMilli(1000), "")
			pending, _ := st.listPendingOutbox(100)
			if len(sent) != 0 || len(pending) != 0 {
				t.Fatalf("expected no send/enqueue; sent=%d pending=%d", len(sent), len(pending))
			}
		})
	}
}

func TestNotifyBestEffortOnTokenError(t *testing.T) {
	st := newTestSqliteStore(t)
	mustExec(t, st, `INSERT INTO notify_settings (id,enabled,chatId,windowMin,updatedAt) VALUES (1,1,'42',0,0)`)
	jobID := insertTestJob(t, st, "j", true)
	var sent []string
	// must not panic / must simply skip when token can't be resolved
	notifyAfterRun(depsWith(st, &sent, errors.New("no token")), jobID, "failure", 1, time.UnixMilli(1000), "")
	if len(sent) != 0 {
		t.Fatalf("token error must skip send")
	}
}
