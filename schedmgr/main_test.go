// SPDX-License-Identifier: Apache-2.0
//go:build !windows

package main

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestRunSubcommandEndToEnd(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "chronos.db")
	applyPlan2Schema(t, dbPath)
	jobID := newJob(t, dbPath)

	// The original command arrives as a single arg after '--' (the canonical adopted form);
	// schedmgr runs it via /bin/sh -c (spec §5.2), preserving shell semantics + exit code.
	code := runMain([]string{
		"run", itoa(jobID), "--db", dbPath, "--triggered-by", "schedule", "--",
		"echo hi; exit 3",
	})
	if code != 3 {
		t.Fatalf("want exit code 3 (child fidelity), got %d", code)
	}

	db, _ := sql.Open("sqlite", dbPath)
	defer db.Close()
	var result string
	var exit int64
	var stdout, triggeredBy string
	if err := db.QueryRow(
		`SELECT result, exitCode, stdout, triggeredBy FROM run_logs WHERE jobId=? ORDER BY id DESC LIMIT 1`, jobID).
		Scan(&result, &exit, &stdout, &triggeredBy); err != nil {
		t.Fatal(err)
	}
	if result != "failure" || exit != 3 || triggeredBy != "schedule" || !strings.Contains(stdout, "hi") {
		t.Fatalf("run_logs wrong: result=%s exit=%d trig=%s stdout=%q", result, exit, triggeredBy, stdout)
	}
}

func TestRunSubcommandDbFailureDoesNotBlock(t *testing.T) {
	// A bad --db path must NOT change the child's exit code (best-effort logging).
	code := runMain([]string{
		"run", "1", "--db", "/nonexistent-dir/x.db", "--triggered-by", "manual", "--",
		"exit 5",
	})
	if code != 5 {
		t.Fatalf("db failure changed exit code: got %d, want 5", code)
	}
}

func TestRunSubcommandMultiArgViaShell(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "chronos.db")
	applyPlan2Schema(t, dbPath)
	jobID := newJob(t, dbPath)

	// A pre-split argv (e.g. cron splitting `-- /bin/echo hello world` into argv) is best-effort
	// space-joined and still run via the shell (spec §5.2) — a simple program works either way.
	code := runMain([]string{
		"run", itoa(jobID), "--db", dbPath, "--", "/bin/echo", "hello", "world",
	})
	if code != 0 {
		t.Fatalf("want exit 0, got %d", code)
	}
	db, _ := sql.Open("sqlite", dbPath)
	defer db.Close()
	var stdout, result string
	if err := db.QueryRow(
		`SELECT stdout, result FROM run_logs WHERE jobId=? ORDER BY id DESC LIMIT 1`, jobID).
		Scan(&stdout, &result); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout, "hello world") || result != "success" {
		t.Fatalf("multi-arg via shell wrong: stdout=%q result=%s", stdout, result)
	}
}

func TestRunSubcommandManualTriggeredBy(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "chronos.db")
	applyPlan2Schema(t, dbPath)
	jobID := newJob(t, dbPath)

	code := runMain([]string{
		"run", itoa(jobID), "--db", dbPath, "--triggered-by", "manual", "--", "true",
	})
	if code != 0 {
		t.Fatalf("want exit 0, got %d", code)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var triggeredBy, result string
	if err := db.QueryRow(
		`SELECT triggeredBy, result FROM run_logs WHERE jobId=? ORDER BY id DESC LIMIT 1`, jobID).
		Scan(&triggeredBy, &result); err != nil {
		t.Fatal(err)
	}
	if triggeredBy != "manual" || result != "success" {
		t.Fatalf("manual run_logs wrong: trig=%s result=%s", triggeredBy, result)
	}
}

func TestRunSubcommandTimeoutRecorded(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "chronos.db")
	applyPlan2Schema(t, dbPath)
	jobID := newJob(t, dbPath)

	// --timeout 1 against a 5s sleep: the run is killed and recorded as result=timeout, with
	// endedAt set (exercises finishRun's client-side duration on the timeout path).
	code := runMain([]string{
		"run", itoa(jobID), "--db", dbPath, "--timeout", "1", "--", "sleep 5",
	})
	if code == 0 {
		t.Fatalf("timed-out run should not exit 0")
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var result string
	var endedAt int64
	if err := db.QueryRow(
		`SELECT result, endedAt FROM run_logs WHERE jobId=? ORDER BY id DESC LIMIT 1`, jobID).
		Scan(&result, &endedAt); err != nil {
		t.Fatal(err)
	}
	if result != "timeout" {
		t.Fatalf("want result=timeout, got %s", result)
	}
	if endedAt == 0 {
		t.Fatalf("timeout run left endedAt unset")
	}
}
