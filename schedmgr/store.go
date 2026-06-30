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

// notifySettings holds the single row from notify_settings (id=1).
type notifySettings struct {
	enabled       bool
	chatID        string
	windowMin     int
	includeStderr bool
}

// outboxRow is a pending-outbox record to be sent via Telegram.
type outboxRow struct {
	id         int64
	jobName    string
	result     string
	exitCode   *int64
	occurredAt time.Time
}

// readNotifySettings reads the singleton notify_settings row (id=1).
// Returns (settings, false, nil) when no row exists yet.
func (s *store) readNotifySettings() (notifySettings, bool, error) {
	var ns notifySettings
	var chat sql.NullString
	q := `SELECT enabled, chatId, windowMin, includeStderr FROM notify_settings WHERE id = 1`
	if s.dialect == dialectPostgres {
		q = `SELECT enabled, "chatId", "windowMin", "includeStderr" FROM notify_settings WHERE id = 1`
	}
	row := s.db.QueryRow(q)
	if err := row.Scan(&ns.enabled, &chat, &ns.windowMin, &ns.includeStderr); err != nil {
		if err == sql.ErrNoRows {
			return notifySettings{}, false, nil
		}
		return notifySettings{}, false, err
	}
	ns.chatID = chat.String
	return ns, true, nil
}

// readJobNotify returns the job's name and notifyOnFailure flag.
// Returns ("", false, nil) when the job does not exist.
func (s *store) readJobNotify(jobID int64) (string, bool, error) {
	var name string
	var notify bool
	q := `SELECT name, notifyOnFailure FROM jobs WHERE id = ?`
	if s.dialect == dialectPostgres {
		q = `SELECT name, "notifyOnFailure" FROM jobs WHERE id = $1`
	}
	if err := s.db.QueryRow(q, jobID).Scan(&name, &notify); err != nil {
		if err == sql.ErrNoRows {
			return "", false, nil
		}
		return "", false, err
	}
	return name, notify, nil
}

// insertOutbox adds a new pending notification to notify_outbox.
func (s *store) insertOutbox(jobID int64, jobName, result string, exitCode *int64, occurredAt time.Time) error {
	now := time.Now()
	if s.dialect == dialectPostgres {
		_, err := s.db.Exec(
			`INSERT INTO notify_outbox ("jobId","jobName",result,"exitCode","occurredAt","createdAt") VALUES ($1,$2,$3,$4,$5,$6)`,
			jobID, jobName, result, exitCode, occurredAt, now)
		return err
	}
	var ec interface{}
	if exitCode != nil {
		ec = *exitCode
	}
	_, err := s.db.Exec(
		`INSERT INTO notify_outbox (jobId,jobName,result,exitCode,occurredAt,createdAt) VALUES (?,?,?,?,?,?)`,
		jobID, jobName, result, ec, occurredAt.UnixMilli(), now.UnixMilli())
	return err
}

// listPendingOutbox returns up to limit unsent outbox rows ordered by occurredAt ascending.
func (s *store) listPendingOutbox(limit int) ([]outboxRow, error) {
	q := `SELECT id, jobName, result, exitCode, occurredAt FROM notify_outbox WHERE sentAt IS NULL ORDER BY occurredAt LIMIT ?`
	if s.dialect == dialectPostgres {
		q = `SELECT id, "jobName", result, "exitCode", "occurredAt" FROM notify_outbox WHERE "sentAt" IS NULL ORDER BY "occurredAt" LIMIT $1`
	}
	rows, err := s.db.Query(q, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []outboxRow
	for rows.Next() {
		var r outboxRow
		var ec sql.NullInt64
		if s.dialect == dialectPostgres {
			var t time.Time
			if err := rows.Scan(&r.id, &r.jobName, &r.result, &ec, &t); err != nil {
				return nil, err
			}
			r.occurredAt = t
		} else {
			var ms int64
			if err := rows.Scan(&r.id, &r.jobName, &r.result, &ec, &ms); err != nil {
				return nil, err
			}
			r.occurredAt = time.UnixMilli(ms)
		}
		if ec.Valid {
			v := ec.Int64
			r.exitCode = &v
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// markOutboxSent stamps sentAt = now for each id. Per-id loop keeps placeholder
// handling trivial and dialect-uniform (see brief decision note).
func (s *store) markOutboxSent(ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	now := time.Now()
	for _, id := range ids {
		q := `UPDATE notify_outbox SET sentAt = ? WHERE id = ?`
		var arg interface{} = now.UnixMilli()
		if s.dialect == dialectPostgres {
			q = `UPDATE notify_outbox SET "sentAt" = $1 WHERE id = $2`
			arg = now
		}
		if _, err := s.db.Exec(q, arg, id); err != nil {
			return err
		}
	}
	return nil
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
