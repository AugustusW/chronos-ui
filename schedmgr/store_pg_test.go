// SPDX-License-Identifier: Apache-2.0
package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// applyPgSchema executes the REAL pg migration SQL the GUI owns (migrations.pg) so the Go writer is
// verified against the exact schema the TS/Drizzle side generates (cross-language contract).
func applyPgSchema(t *testing.T, db *sql.DB) {
	t.Helper()
	matches, err := filepath.Glob("../src/main/db/migrations.pg/0000_*.sql")
	if err != nil || len(matches) == 0 {
		t.Fatalf("could not find pg migration SQL: %v (matches=%v)", err, matches)
	}
	sqlBytes, err := os.ReadFile(matches[0])
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	for _, stmt := range splitMigration(string(sqlBytes)) {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("apply stmt: %v\n%s", err, stmt)
		}
	}
}

func newPgJob(t *testing.T, db *sql.DB) int64 {
	t.Helper()
	now := time.Now() // pg createdAt/updatedAt are timestamptz NOT NULL — must be time.Time, not UnixMilli
	var id int64
	err := db.QueryRow(
		`INSERT INTO jobs (name, source, platform, "scheduleExpr", command, enabled, adopted, "createdAt", "updatedAt") `+
			`VALUES ('j','native_cron','darwin','* * * * *','echo hi',true,true,$1,$2) RETURNING id`,
		now, now).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// TestPgStoreRecordsRun runs only when TEST_PG_URL is set (CI service / local docker), mirroring the
// GUI's Plan-1 TEST_PG_URL gate. It proves the pg store writes the run row + job cache correctly.
func TestPgStoreRecordsRun(t *testing.T) {
	dsn := os.Getenv("TEST_PG_URL")
	if dsn == "" {
		t.Skip("TEST_PG_URL not set; skipping postgres store test")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	// Fresh schema. The node-postgres migrator keeps its journal in the `drizzle` schema; the tables
	// live in `public`. Drop both (CASCADE handles the run_logs→jobs FK order) so applyPgSchema re-runs.
	if _, err := admin.Exec(`DROP SCHEMA IF EXISTS drizzle CASCADE; DROP TABLE IF EXISTS run_logs, jobs CASCADE`); err != nil {
		t.Fatal(err)
	}
	applyPgSchema(t, admin)
	jobID := newPgJob(t, admin)

	st, err := openPgStore(dsn)
	if err != nil {
		t.Fatalf("openPgStore: %v", err)
	}
	defer st.close()

	started := time.Now().Add(-1200 * time.Millisecond)
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

	var result, stdout, lastResult string
	var dur, exit int64
	if err := admin.QueryRow(`SELECT result, "durationMs", "exitCode", stdout FROM run_logs WHERE id=$1`, runID).
		Scan(&result, &dur, &exit, &stdout); err != nil {
		t.Fatal(err)
	}
	if result != "success" || dur != 1200 || exit != 0 || stdout != "out" {
		t.Fatalf("run_logs wrong: %s %d %d %q", result, dur, exit, stdout)
	}
	if err := admin.QueryRow(`SELECT "lastResult" FROM jobs WHERE id=$1`, jobID).Scan(&lastResult); err != nil {
		t.Fatal(err)
	}
	if lastResult != "success" {
		t.Fatalf("job cache wrong: %s", lastResult)
	}
}

// TestOpenStoreWithPgDescriptor exercises the full glue: a "pg:keychain:<svc>" descriptor →
// resolveDSN (keychain miss → 0600 fallback) → openPgStore → a real Postgres write. The keychain is
// mocked (fakeReader); the DSN rides the 0600 fallback file, proving the descriptor path end-to-end.
func TestOpenStoreWithPgDescriptor(t *testing.T) {
	dsn := os.Getenv("TEST_PG_URL")
	if dsn == "" {
		t.Skip("TEST_PG_URL not set; skipping postgres descriptor glue test")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if _, err := admin.Exec(`DROP SCHEMA IF EXISTS drizzle CASCADE; DROP TABLE IF EXISTS run_logs, jobs CASCADE`); err != nil {
		t.Fatal(err)
	}
	applyPgSchema(t, admin)
	jobID := newPgJob(t, admin)

	dir := t.TempDir()
	fp := filepath.Join(dir, sanitizeService("pgtest")+".dsn")
	if err := os.WriteFile(fp, []byte(dsn), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := openStoreWith(fakeReader{err: os.ErrNotExist}, dir, "pg:keychain:pgtest")
	if err != nil {
		t.Fatalf("openStoreWith pg descriptor: %v", err)
	}
	defer st.close()
	if st.dialect != dialectPostgres {
		t.Fatalf("expected postgres dialect, got %d", st.dialect)
	}
	if _, err := st.startRun(jobID, "manual", time.Now()); err != nil {
		t.Fatalf("startRun via descriptor: %v", err)
	}
}
