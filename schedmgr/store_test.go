// SPDX-License-Identifier: Apache-2.0
package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// applyPlan2Schema builds a test DB by executing the REAL Plan 2 migration SQL, so the Go writer
// is verified against the exact schema the TS/Drizzle side owns (cross-language contract).
func applyPlan2Schema(t *testing.T, dbPath string) {
	t.Helper()
	matches, err := filepath.Glob("../src/main/db/migrations/0000_*.sql")
	if err != nil || len(matches) == 0 {
		t.Fatalf("could not find Plan 2 migration SQL: %v (matches=%v)", err, matches)
	}
	sqlBytes, err := os.ReadFile(matches[0])
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	// Drizzle migration files use "--> statement-breakpoint" between statements.
	for _, stmt := range splitMigration(string(sqlBytes)) {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("apply stmt: %v\n%s", err, stmt)
		}
	}
}

func newJob(t *testing.T, dbPath string) int64 {
	t.Helper()
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	res, err := db.Exec(
		`INSERT INTO jobs (name, source, platform, scheduleExpr, command, enabled, adopted, createdAt, updatedAt) `+
			`VALUES ('j','native_cron','darwin','* * * * *','echo hi',1,1,?,?)`,
		time.Now().UnixMilli(), time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	return id
}

func TestStoreRecordsRunAndCache(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "chronos.db")
	applyPlan2Schema(t, dbPath)
	jobID := newJob(t, dbPath)

	// Capture updatedAt before the run so we can assert a run does NOT change it (architect L2).
	var initialUpdatedAt int64
	if db0, e := sql.Open("sqlite", dbPath); e == nil {
		_ = db0.QueryRow(`SELECT updatedAt FROM jobs WHERE id=?`, jobID).Scan(&initialUpdatedAt)
		db0.Close()
	}

	st, err := openStore(dbPath)
	if err != nil {
		t.Fatalf("openStore: %v", err)
	}
	defer st.close()

	started := time.UnixMilli(1_000_000)
	runID, err := st.startRun(jobID, "schedule", started)
	if err != nil {
		t.Fatalf("startRun: %v", err)
	}
	if runID <= 0 {
		t.Fatalf("bad runID %d", runID)
	}

	ended := started.Add(1200 * time.Millisecond)
	if err := st.finishRun(runID, "success", started, ended, 0, "out", "err"); err != nil {
		t.Fatalf("finishRun: %v", err)
	}
	if err := st.updateJobCache(jobID, ended, "success"); err != nil {
		t.Fatalf("updateJobCache: %v", err)
	}

	// Verify via a fresh connection.
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var result string
	var dur, exit int64
	var stdout string
	if err := db.QueryRow(`SELECT result, durationMs, exitCode, stdout FROM run_logs WHERE id=?`, runID).
		Scan(&result, &dur, &exit, &stdout); err != nil {
		t.Fatal(err)
	}
	if result != "success" || dur != 1200 || exit != 0 || stdout != "out" {
		t.Fatalf("run_logs wrong: %s %d %d %q", result, dur, exit, stdout)
	}

	// Job cache updated; updatedAt must NOT change (architect L2 / Plan 2 semantics).
	var lastResult string
	var lastRunAt, updatedAt int64
	if err := db.QueryRow(`SELECT lastResult, lastRunAt, updatedAt FROM jobs WHERE id=?`, jobID).
		Scan(&lastResult, &lastRunAt, &updatedAt); err != nil {
		t.Fatal(err)
	}
	if lastResult != "success" || lastRunAt != ended.UnixMilli() {
		t.Fatalf("job cache wrong: %s %d", lastResult, lastRunAt)
	}
	if updatedAt != initialUpdatedAt {
		t.Fatalf("updatedAt must NOT change on a run (architect L2): initial=%d after=%d", initialUpdatedAt, updatedAt)
	}
}
