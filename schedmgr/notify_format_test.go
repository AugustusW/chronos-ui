package main

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestFormatImmediateFailure(t *testing.T) {
	code := int64(1)
	msg := formatImmediate("backup", "failure", &code, 1300*time.Millisecond,
		time.Date(2026, 6, 28, 15, 4, 0, 0, time.UTC), "boom\ntrace")
	if !strings.Contains(msg, "🔴 ChronosUI: backup failed") ||
		!strings.Contains(msg, "exit 1") || !strings.Contains(msg, "boom") {
		t.Fatalf("immediate msg:\n%s", msg)
	}
}

func TestFormatImmediateTimeoutOmitsExit(t *testing.T) {
	msg := formatImmediate("scrape", "timeout", nil, 0, time.Now(), "")
	if !strings.Contains(msg, "timed out") || strings.Contains(msg, "exit ") {
		t.Fatalf("timeout msg:\n%s", msg)
	}
}

func TestFormatDigestLists(t *testing.T) {
	c1 := int64(1)
	rows := []outboxRow{
		{jobName: "a", result: "failure", exitCode: &c1, occurredAt: time.Date(2026, 6, 28, 15, 1, 0, 0, time.UTC)},
		{jobName: "b", result: "timeout", occurredAt: time.Date(2026, 6, 28, 15, 3, 0, 0, time.UTC)},
	}
	msg := formatDigest(rows, 5)
	if !strings.Contains(msg, "2 job(s) failed") ||
		!strings.Contains(msg, "• a — failure (exit 1)") || !strings.Contains(msg, "• b — timeout") {
		t.Fatalf("digest msg:\n%s", msg)
	}
}

func TestStderrTailBounds(t *testing.T) {
	in := strings.Repeat("line\n", 50)
	out := stderrTail(in, 10, 1000)
	if strings.Count(out, "line") > 10 {
		t.Fatalf("expected ≤10 lines, got:\n%s", out)
	}
}

func TestStderrTailByteBoundIsRuneSafe(t *testing.T) {
	// 200 CJK runes (3 bytes each in UTF-8) = 600 bytes; cap at 100 bytes.
	in := strings.Repeat("日", 200)
	out := stderrTail(in, 10000, 100)
	if len(out) > 100 {
		t.Fatalf("expected ≤100 bytes, got %d", len(out))
	}
	if !utf8.ValidString(out) {
		t.Fatalf("output is not valid UTF-8: %q", out)
	}
}
