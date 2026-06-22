// SPDX-License-Identifier: Apache-2.0
package main

import (
	"database/sql"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type store struct{ db *sql.DB }

// openStore opens the shared SQLite file with per-connection pragmas. It does NOT set
// journal_mode/journal_size_limit — those are the GUI's responsibility (spec §7, architect L4);
// the file is already in WAL mode. SetMaxOpenConns(1): modernc.org/sqlite is built
// SQLITE_MUTEX_NOOP, so a single connection / single-threaded access is required (architect M1).
func openStore(dbPath string) (*store, error) {
	dsn := dbPath + "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(on)&_pragma=synchronous(normal)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return &store{db: db}, nil
}

func (s *store) close() error { return s.db.Close() }

// startRun inserts an in-progress run_log (result + endedAt stay NULL) and returns its id.
func (s *store) startRun(jobID int64, triggeredBy string, started time.Time) (int64, error) {
	res, err := s.db.Exec(
		`INSERT INTO run_logs (jobId, triggeredBy, startedAt, createdAt) VALUES (?,?,?,?)`,
		jobID, triggeredBy, started.UnixMilli(), time.Now().UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// finishRun completes a run_log. durationMs is computed from the caller's in-memory `started`
// time — NOT a SELECT round-trip: a read that fails under WAL contention must never leave an
// already-finished run permanently incomplete (result/endedAt NULL). stdout/stderr are
// tail-truncated to 64 KB (spec §5.5).
func (s *store) finishRun(runID int64, result string, started, ended time.Time, exitCode int, stdout, stderr string) error {
	const maxBytes = 64 * 1024
	_, err := s.db.Exec(
		`UPDATE run_logs SET result=?, endedAt=?, durationMs=?, exitCode=?, stdout=?, stderr=? WHERE id=?`,
		result, ended.UnixMilli(), ended.Sub(started).Milliseconds(), exitCode,
		keepLastBytes(stdout, maxBytes), keepLastBytes(stderr, maxBytes), runID)
	return err
}

// updateJobCache refreshes the job's cached last-run fields. It explicitly lists ONLY
// lastRunAt + lastResult and never touches updatedAt (architect L2 / Plan 2: a run is not a
// config change; updatedAt = config last-changed).
func (s *store) updateJobCache(jobID int64, lastRunAt time.Time, lastResult string) error {
	_, err := s.db.Exec(
		`UPDATE jobs SET lastRunAt=?, lastResult=? WHERE id=?`,
		lastRunAt.UnixMilli(), lastResult, jobID)
	return err
}

// splitMigration splits Drizzle's generated SQL on its statement-breakpoint markers.
func splitMigration(sql string) []string {
	var out []string
	for _, part := range strings.Split(sql, "--> statement-breakpoint") {
		if s := strings.TrimSpace(part); s != "" {
			out = append(out, s)
		}
	}
	return out
}
