// SPDX-License-Identifier: Apache-2.0
package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

// newTestSqliteStore opens an :memory: SQLite store with ALL migrations applied.
// Unlike applyPlan2Schema (which only applies 0000_*.sql), this applies every
// migration in order so that notify_settings / notify_outbox are present.
func newTestSqliteStore(t *testing.T) *store {
	t.Helper()

	// Write to a temp file instead of :memory: so we can open it via openSqliteStore.
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	// Apply all migrations in lexicographic order (Drizzle guarantees 0000, 0001, …).
	matches, err := filepath.Glob("../src/main/db/migrations/*.sql")
	if err != nil {
		t.Fatalf("glob migrations: %v", err)
	}
	if len(matches) == 0 {
		t.Fatal("no migration SQL files found")
	}
	sort.Strings(matches)

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open seed db: %v", err)
	}
	for _, f := range matches {
		raw, err := os.ReadFile(f)
		if err != nil {
			db.Close()
			t.Fatalf("read %s: %v", f, err)
		}
		for _, stmt := range splitMigration(string(raw)) {
			if _, err := db.Exec(stmt); err != nil {
				db.Close()
				t.Fatalf("apply stmt from %s: %v\n%s", f, err, stmt)
			}
		}
	}
	db.Close()

	st, err := openSqliteStore(dbPath)
	if err != nil {
		t.Fatalf("openSqliteStore: %v", err)
	}
	t.Cleanup(func() { st.close() })
	return st
}

// mustExec runs a raw SQL statement on the store's DB, failing the test on error.
func mustExec(t *testing.T, st *store, query string, args ...interface{}) {
	t.Helper()
	if _, err := st.db.Exec(query, args...); err != nil {
		t.Fatalf("mustExec %q: %v", query, err)
	}
}

// insertTestJob inserts a job row and returns its id.
func insertTestJob(t *testing.T, st *store, name string, notifyOnFailure bool) int64 {
	t.Helper()
	notify := 0
	if notifyOnFailure {
		notify = 1
	}
	now := time.Now().UnixMilli()
	res, err := st.db.Exec(
		`INSERT INTO jobs (name, source, platform, scheduleExpr, command, enabled, adopted, notifyOnFailure, createdAt, updatedAt) `+
			`VALUES (?,?,?,?,?,1,1,?,?,?)`,
		name, "native_cron", "darwin", "* * * * *", "echo hi", notify, now, now)
	if err != nil {
		t.Fatalf("insertTestJob %q: %v", name, err)
	}
	id, _ := res.LastInsertId()
	return id
}

func TestNotifyStoreRoundTrip(t *testing.T) {
	st := newTestSqliteStore(t)
	mustExec(t, st, `INSERT INTO notify_settings (id, enabled, chatId, windowMin, updatedAt) VALUES (1,1,'42',5,0)`)
	ns, found, err := st.readNotifySettings()
	if err != nil || !found {
		t.Fatalf("readNotifySettings: found=%v err=%v", found, err)
	}
	if !ns.enabled || ns.chatID != "42" || ns.windowMin != 5 {
		t.Fatalf("unexpected settings: %+v", ns)
	}
	// A row inserted without the includeStderr column must read back false (the migration's backfill
	// default) — the security-critical "stderr off by default" contract for pre-migration rows.
	if ns.includeStderr {
		t.Fatal("includeStderr must default to false for a row created without the column")
	}

	jobID := insertTestJob(t, st, "backup", true /*notifyOnFailure*/)
	name, notify, err := st.readJobNotify(jobID)
	if err != nil || name != "backup" || !notify {
		t.Fatalf("readJobNotify: name=%q notify=%v err=%v", name, notify, err)
	}

	code := int64(1)
	if err := st.insertOutbox(jobID, "backup", "failure", &code, time.UnixMilli(1000)); err != nil {
		t.Fatal(err)
	}
	rows, err := st.listPendingOutbox(100)
	if err != nil || len(rows) != 1 || rows[0].jobName != "backup" || *rows[0].exitCode != 1 {
		t.Fatalf("listPendingOutbox: %+v err=%v", rows, err)
	}
	if err := st.markOutboxSent([]int64{rows[0].id}); err != nil {
		t.Fatal(err)
	}
	again, _ := st.listPendingOutbox(100)
	if len(again) != 0 {
		t.Fatalf("expected 0 pending after markSent, got %d", len(again))
	}
}
