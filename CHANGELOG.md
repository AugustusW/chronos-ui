# Changelog

All notable changes to ChronosUI are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
