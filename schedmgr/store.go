// SPDX-License-Identifier: Apache-2.0
package main

import (
	"database/sql"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

type dialect int

const (
	dialectSQLite dialect = iota
	dialectPostgres
)

type store struct {
	db      *sql.DB
	dialect dialect
}

// openSqliteStore opens the shared SQLite file with per-connection pragmas. It does NOT set
// journal_mode/journal_size_limit — those are the GUI's responsibility (spec §7, architect L4);
// the file is already in WAL mode. SetMaxOpenConns(1): modernc.org/sqlite is built
// SQLITE_MUTEX_NOOP, so a single connection / single-threaded access is required (architect M1).
func openSqliteStore(dbPath string) (*store, error) {
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
	return &store{db: db, dialect: dialectSQLite}, nil
}

// openPgStore opens Postgres via the pgx stdlib driver (pure Go — CGO_ENABLED=0 holds). Postgres
// is safe for concurrent use, so the SQLITE_MUTEX_NOOP single-connection constraint does not apply.
func openPgStore(dsn string) (*store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return &store{db: db, dialect: dialectPostgres}, nil
}

// openStore dispatches on the --db descriptor: a "pg:keychain:<service>" reference resolves its DSN
// from the OS keychain (0600-file fallback) and opens Postgres; a path opens SQLite. A resolution or
// open error is returned to main, which records best-effort (the scheduled command still runs).
func openStore(descriptor string) (*store, error) {
	return openStoreWith(platformSecretReader{}, defaultFallbackDir(), descriptor)
}

// openStoreWith is openStore with the keychain reader + fallback dir injected (testable seam).
func openStoreWith(kc secretReader, fallbackDir, descriptor string) (*store, error) {
	if isPg, service := parseDBDescriptor(descriptor); isPg {
		dsn, err := resolveDSNWith(kc, fallbackDir, service)
		if err != nil {
			return nil, err
		}
		return openPgStore(dsn)
	}
	return openSqliteStore(descriptor)
}

func (s *store) close() error { return s.db.Close() }

// startRun inserts an in-progress run_log (result + endedAt stay NULL) and returns its id. SQLite
// uses '?' placeholders + LastInsertId and stores timestamps as UnixMilli integers; Postgres uses
// '$N' placeholders + RETURNING id and writes time.Time into its timestamptz columns.
func (s *store) startRun(jobID int64, triggeredBy string, started time.Time) (int64, error) {
	now := time.Now()
	if s.dialect == dialectPostgres {
		var id int64
		err := s.db.QueryRow(
			`INSERT INTO run_logs ("jobId", "triggeredBy", "startedAt", "createdAt") VALUES ($1,$2,$3,$4) RETURNING id`,
			jobID, triggeredBy, started, now).Scan(&id)
		return id, err
	}
	res, err := s.db.Exec(
		`INSERT INTO run_logs (jobId, triggeredBy, startedAt, createdAt) VALUES (?,?,?,?)`,
		jobID, triggeredBy, started.UnixMilli(), now.UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// finishRun completes a run_log. durationMs is computed from the caller's in-memory `started` time
// — NOT a SELECT round-trip: a read that fails under contention must never leave an already-finished
// run permanently incomplete. stdout/stderr are tail-truncated to 64 KB (spec §5.5).
func (s *store) finishRun(runID int64, result string, started, ended time.Time, exitCode int, stdout, stderr string) error {
	const maxBytes = 64 * 1024
	durMs := ended.Sub(started).Milliseconds()
	out := keepLastBytes(stdout, maxBytes)
	errOut := keepLastBytes(stderr, maxBytes)
	if s.dialect == dialectPostgres {
		_, err := s.db.Exec(
			`UPDATE run_logs SET result=$1, "endedAt"=$2, "durationMs"=$3, "exitCode"=$4, stdout=$5, stderr=$6 WHERE id=$7`,
			result, ended, durMs, exitCode, out, errOut, runID)
		return err
	}
	_, err := s.db.Exec(
		`UPDATE run_logs SET result=?, endedAt=?, durationMs=?, exitCode=?, stdout=?, stderr=? WHERE id=?`,
		result, ended.UnixMilli(), durMs, exitCode, out, errOut, runID)
	return err
}

// updateJobCache refreshes the job's cached last-run fields. It explicitly lists ONLY lastRunAt +
// lastResult and never touches updatedAt (architect L2 / Plan 2: a run is not a config change).
func (s *store) updateJobCache(jobID int64, lastRunAt time.Time, lastResult string) error {
	if s.dialect == dialectPostgres {
		_, err := s.db.Exec(
			`UPDATE jobs SET "lastRunAt"=$1, "lastResult"=$2 WHERE id=$3`,
			lastRunAt, lastResult, jobID)
		return err
	}
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
