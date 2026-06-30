# How ChronosUI rewrites your crontab

ChronosUI manages cron jobs on macOS and Linux by editing your **user** crontab. This page documents
exactly what it writes, so you can verify it (`crontab -l`) and trust it.

## What it touches

ChronosUI only ever runs two commands:

- `crontab -l` — read your current crontab.
- `crontab -` — write a new crontab (from stdin).

It never edits system settings, other users' crontabs, or the system crontab. Every write is the
result of an action you took in the app (adopt, edit, enable/disable, un-adopt, delete).

It only modifies lines **it created or adopted** — identified by a marker comment (below) and by the
`schedmgr` invocation shape. Your other crontab lines are copied through untouched, in place.

## Adopting a job

To record the output, last run, and exit code of a *scheduled* run, ChronosUI "adopts" the job by
wrapping its command with a small bundled binary, `schedmgr`. A line like:

```cron
*/5 * * * * /usr/bin/python3 backup.py
```

becomes a marker comment plus a wrapped line:

```cron
# chronos:42
*/5 * * * * '/path/to/schedmgr' run 42 --db '/path/to/chronos.db' -- '/usr/bin/python3 backup.py'
```

- `# chronos:42` — the marker that ties the line to job id 42 in ChronosUI's database.
- `'/path/to/schedmgr' run 42 …` — the wrapper. It runs at the same schedule, then executes your
  **original** command verbatim.
- `--db '…'` — the local SQLite database where the run (start, end, exit code, stdout/stderr tail) is
  recorded. No secrets are placed in the crontab line.
- `-- '<your original command>'` — your command, exactly as it was, shell-quoted as a single argument
  so `schedmgr` passes it to `/bin/sh -c` unchanged. The bundled path and the db path are quoted too,
  so a spaced install path stays a single shell word.

`schedmgr` is fully transparent: it runs your command with the same working directory, environment,
and exit code cron would have used. It only *also* records the run.

## The notify-flush line

If you enable batched Telegram notifications, ChronosUI adds one more managed line that periodically
sends any pending failure alerts:

```cron
# chronos:notify-flush
*/5 * * * * '/path/to/schedmgr' notify-flush --db '/path/to/chronos.db'
```

(On macOS this is a per-user LaunchAgent instead of a crontab line, to avoid an extra TCC prompt.)

## Un-adopting (reverting)

Un-adopt restores the bare original line and removes the marker — one click, fully reversible:

```cron
*/5 * * * * /usr/bin/python3 backup.py
```

## Backward compatibility

Crontab lines written by an older ChronosUI used an unquoted `schedmgr` path. ChronosUI still
recognizes those lines; the next time it rewrites a managed line, it is emitted in the quoted form
above.
