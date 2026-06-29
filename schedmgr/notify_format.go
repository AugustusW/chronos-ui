package main

import (
	"fmt"
	"strings"
	"time"
)

const timeLayout = "2006-01-02 15:04"
const shortTime = "15:04"

func formatImmediate(jobName, result string, exitCode *int64, dur time.Duration, when time.Time, tail string) string {
	var b strings.Builder
	verb := "failed"
	if result == "timeout" {
		verb = "timed out"
	}
	fmt.Fprintf(&b, "🔴 ChronosUI: %s %s\n", jobName, verb)
	meta := []string{}
	if result != "timeout" && exitCode != nil {
		meta = append(meta, fmt.Sprintf("exit %d", *exitCode))
	}
	if dur > 0 {
		meta = append(meta, dur.Round(time.Millisecond).String())
	}
	meta = append(meta, when.Format(timeLayout))
	b.WriteString(strings.Join(meta, " · "))
	if t := strings.TrimSpace(tail); t != "" {
		b.WriteString("\n")
		b.WriteString(t)
	}
	return b.String()
}

func formatDigest(rows []outboxRow, windowMin int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "🔴 ChronosUI: %d job(s) failed (last %dmin)\n", len(rows), windowMin)
	for _, r := range rows {
		if r.result == "timeout" {
			fmt.Fprintf(&b, "• %s — timeout %s\n", r.jobName, r.occurredAt.Format(shortTime))
		} else if r.exitCode != nil {
			fmt.Fprintf(&b, "• %s — failure (exit %d) %s\n", r.jobName, *r.exitCode, r.occurredAt.Format(shortTime))
		} else {
			fmt.Fprintf(&b, "• %s — failure %s\n", r.jobName, r.occurredAt.Format(shortTime))
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

func stderrTail(s string, maxLines, maxBytes int) string {
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return ""
	}
	lines := strings.Split(s, "\n")
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	out := strings.Join(lines, "\n")
	if len(out) > maxBytes {
		out = strings.ToValidUTF8(out[len(out)-maxBytes:], "")
	}
	return out
}
