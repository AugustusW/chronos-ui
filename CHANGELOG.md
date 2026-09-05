# Changelog

All notable changes to ChronosUI are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.1] — 2026-09-05

Windows fixes, plus one that turned out to affect every platform.

### Fixed
- Creating a job on Windows could report success while Task Scheduler never received it, leaving a
  job in ChronosUI that the system had never been told about. The scheduler script was delivered on
  standard input, where a multi-line argument left PowerShell waiting for more and it discarded the
  script at end of input — exiting successfully. Error detection was affected generally, not only
  when creating a job: a failing command could come back as a success.
- The schedule field asked for a cron expression on Windows, which Windows does not use. It now
  asks for the format the machine actually accepts (`daily 03:00`, `hourly 2`, `weekly MON,FRI
  07:30`, and so on), previews it in plain language, and explains the difference if a cron
  expression is entered instead of failing afterwards with `trigger: unknown kind 0`.
- Failures on Windows reported themselves as a page of XML with the reason at the end and the
  script — including the job's own command — repeated inside it. The message is now the reason.
- Text outside the ASCII range came back garbled from Windows: a Chinese, Japanese or accented
  European path, or any error message in those languages. English-only setups never saw this.
- **Any platform:** when saving a job or adopting one failed, the reason was written to the page
  underneath the dialog that caused it — and the dialog stays open on failure so the entry is not
  lost, so it covered the explanation. The dialogs now show it themselves.
- Dialogs and prompts no longer refer to crontab on Windows, which has none.

### Known
- Adopting an existing scheduled task does not work on Windows. It reports `no job N`. This is
  being worked on separately; jobs created in ChronosUI are unaffected.


## [0.5.0] — 2026-09-05

### Added
- **Remove ChronosUI** — a Settings action that hands every job back to the native scheduler before
  you delete the app. Adopted jobs return to their original crontab lines with schedules unchanged;
  jobs created in ChronosUI keep running and only lose the `# chronos:` marker; the notification
  entry ChronosUI installed is removed. Deleting the app without this leaves adopted jobs pointing
  at a wrapper that no longer exists — they stop running and nothing says so. Deleting the local
  run history and settings is a separate checkbox, off by default. If any part cannot be completed
  (a job the scheduler no longer knows about, a file that will not delete), the dialog says which
  and the app stays open instead of quitting on a cleanup that did not finish.

### Fixed
- Quitting could leave the app running with no window on Windows and Linux. The window-close
  handler hides the window instead of closing, and the flag that suppressed that was set on only
  one of the three exit paths — so quitting from anywhere else tore down the tray, timers and
  database and then left a process only Task Manager could end. macOS never runs that interception,
  which is why it showed no symptom there.
- The self-cleaning notification agent (macOS) never reached installs upgraded from an earlier
  version. It is written only when notification settings are saved, so an agent from an older build
  survived every upgrade unchanged and would keep invoking a deleted binary after the app was
  removed. It is now brought up to date at startup, but only when its content actually differs —
  rewriting it on every launch would restart the flush countdown.
- Scheduled runs recorded no history when the database is PostgreSQL (macOS and Linux). The
  connection string was stored in the OS keychain only, and the scheduler process reads it from
  cron, outside the desktop login session, where the keychain is unreachable. The 0600 fallback
  file is now always written alongside the keychain item. Existing installs need the PostgreSQL
  connection saved once in Settings to create that file. Jobs themselves always ran; only the run
  history was lost.

## [0.4.0] — 2026-08-11

### Added
- Tray menu now shows a live Dashboard summary: today's succeeded/failed counts, up to 5 recent
  failed jobs (click one to open the app), and the next upcoming run — no more digging through the
  window just to check whether anything broke overnight. The menu bar icon itself (macOS) picks up
  a compact "✓N ✗N" status once there's at least one failure today, and stays quiet the rest of the
  time. Refreshes on every run outcome / schedule change, plus a best-effort refresh right before
  the menu opens.
- macOS native notification when a scheduled job fails — a Notification Center banner titled with
  the job name (or "N jobs failed" when several complete around the same time) so you find out
  without having ChronosUI or Telegram open. Click it to bring the app forward. Independent of the
  existing Telegram alerts (its own "Native failure notifications" toggle in Settings, on by
  default); like Telegram, only background/scheduled runs trigger it — a run you started yourself
  is already visible live in the app.
- Run History can now be filtered by job, result, and date range (today / 7 days / 30 days / all
  time), plus a free-text search across job name and captured stdout/stderr. Results show which
  job each run belongs to; a "Load 50 more" button appears once a page fills up.
- A run-duration trend sparkline on each job's detail page — the last 20 completed runs at a
  glance, with failed/timed-out runs marked so a slow patch and a broken patch don't look the same.
- Import and export job definitions as YAML, from Settings (all jobs) or a job's own detail page
  (just that one). Importing shows a new/changed/unchanged preview — grouped by what will actually
  happen — before anything is applied; nothing is ever silently overwritten. See the README for the
  file format.

## [0.3.0] — 2026-08-01

### Added
- Dashboard: a new home view showing today's run stats at a glance (runs / succeeded / failed /
  active jobs, in your local timezone), the day's failures with one-click jump into the job, and
  the next 20 upcoming runs computed from your schedules. Schedules moved to its own nav entry.

## [0.2.0] — 2026-07-18

### Added
- Switch the app between SQLite and PostgreSQL right from Settings: enter a DSN, test the
  connection, and optionally migrate your existing jobs/run history/notification settings over in
  one step. The DSN is stored in the OS keychain (never in the config file or logs), and if the app
  can't reach the configured PostgreSQL database on boot, a dialog explains why and offers starting
  with SQLite for that session instead of silently running against the wrong (or no) database.

## [0.1.5] — 2026-06-30

### Security
- Store the Telegram bot token in the OS keychain (macOS Keychain / Linux Secret Service) instead of
  a plaintext file; Windows falls back to a `0600` file with a clear "unencrypted" warning in Settings.
- Validate the Telegram bot-token / chat-id format at the IPC boundary and again in the Go sidecar
  before building any request URL; reject a carriage return in scheduler expressions/commands.
- Add a strict Content-Security-Policy to the packaged renderer and lock down navigation
  (deny in-app `window.open`; block navigation away from the app's own page).
- The stderr tail of a failed job is no longer sent to Telegram unless you opt in (default off).
- Shell-quote the bundled `schedmgr` path in crontab lines so a spaced install path can't break them.
- Require TLS for a non-local PostgreSQL connection; add a `SECURITY.md` security policy + threat model.

### Performance / Reliability
- Index `run_logs (jobId, startedAt, id)` for the run-history queries; bound the otherwise unbounded
  run history with a 90-day retention sweep (on launch + daily).
- Kill the run on a UI timeout instead of leaving an orphan; kill the whole process tree on Windows.
- Make `finishRun` atomic (transaction-wrapped) on both database backends.

## [0.1.4] — 2026-06
- Forget action + Delete confirmation; Schedules view UX pass; animated hero demo.

## [0.1.3] — 2026-06
- Adopt confirm / name dialog; Un-adopt action.

## [0.1.2] — 2026-06
- Telegram failure notifications; macOS LaunchAgent-based notify flush.

## [0.1.1] — 2026-06
- Optional PostgreSQL backend; Run History; crash guards.

## [0.1.0] — 2026-06
- Initial public release: read your native scheduler (crontab on macOS/Linux, Task Scheduler on
  Windows) in a GUI, adopt jobs to record output, run-now with live output.

[Unreleased]: https://github.com/AugustusW/chronos-ui/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/AugustusW/chronos-ui/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/AugustusW/chronos-ui/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/AugustusW/chronos-ui/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/AugustusW/chronos-ui/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/AugustusW/chronos-ui/compare/e8dfdda67297558fc0b6a58f6abca09092eb5230...v0.1.1
[0.1.0]: https://github.com/AugustusW/chronos-ui/commit/e8dfdda67297558fc0b6a58f6abca09092eb5230
