// SPDX-License-Identifier: Apache-2.0
package main

import (
	"errors"
	"testing"
	"time"
)

func errAny() error { return errors.New("send fail") }

func TestFlushSendsDigestAndMarksSent(t *testing.T) {
	st := newTestSqliteStore(t)
	mustExec(t, st, `INSERT INTO notify_settings (id,enabled,chatId,windowMin,updatedAt) VALUES (1,1,'42',5,0)`)
	job := insertTestJob(t, st, "a", true)
	c := int64(1)
	_ = st.insertOutbox(job, "a", "failure", &c, time.UnixMilli(1000))
	_ = st.insertOutbox(job, "a", "timeout", nil, time.UnixMilli(2000))

	var sent []string
	err := flushOutbox(flushDeps{
		st:         st,
		resolveTok: func() (string, error) { return "TOK", nil },
		send:       func(_, chat, text string) error { sent = append(sent, chat+"|"+text); return nil },
		limit:      100,
	})
	if err != nil || len(sent) != 1 {
		t.Fatalf("expected 1 digest send, got %d err=%v", len(sent), err)
	}
	pending, _ := st.listPendingOutbox(100)
	if len(pending) != 0 {
		t.Fatalf("expected outbox drained, %d remain", len(pending))
	}
}

func TestFlushNoopWhenEmptyOrDisabled(t *testing.T) {
	st := newTestSqliteStore(t)
	mustExec(t, st, `INSERT INTO notify_settings (id,enabled,chatId,windowMin,updatedAt) VALUES (1,0,'42',5,0)`)
	var sent []string
	if err := flushOutbox(flushDeps{st: st, resolveTok: func() (string, error) { return "T", nil },
		send: func(_, _, _ string) error { sent = append(sent, "x"); return nil }, limit: 100}); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 0 {
		t.Fatal("disabled settings must not send")
	}
}

func TestFlushKeepsPendingOnSendFailure(t *testing.T) {
	st := newTestSqliteStore(t)
	mustExec(t, st, `INSERT INTO notify_settings (id,enabled,chatId,windowMin,updatedAt) VALUES (1,1,'42',5,0)`)
	job := insertTestJob(t, st, "a", true)
	c := int64(1)
	_ = st.insertOutbox(job, "a", "failure", &c, time.UnixMilli(1000))
	_ = flushOutbox(flushDeps{st: st, resolveTok: func() (string, error) { return "T", nil },
		send: func(_, _, _ string) error { return errAny() }, limit: 100})
	pending, _ := st.listPendingOutbox(100)
	if len(pending) != 1 {
		t.Fatalf("send failure must leave row pending, got %d", len(pending))
	}
}
