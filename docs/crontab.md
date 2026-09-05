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

To do this for every job at once, see [Uninstalling](#uninstalling) below.

## Uninstalling

Deleting ChronosUI does not delete your cron jobs, but it does stop the adopted ones from running.
The wrapped line points at `schedmgr` inside the app bundle, so once the app is gone cron still
fires on schedule and gets `No such file or directory`. The schedule is intact; the job fails.

Nothing is lost: your original command is still in the crontab line, after the `--`.

### The clean way

**Settings → Remove ChronosUI** does all of it in one step: every adopted job goes back to its
original crontab line, every job created here keeps running with only the `# chronos:` marker
removed, and the notification entry is removed. It also offers to delete the local database and
settings; leaving that unchecked keeps your run history for a reinstall.

It cannot be undone, so it asks first. Do it before dragging the app to the trash.

### If the app is already gone

Edit your crontab by hand with `crontab -e`. What to do depends on which kind of line it is, and the
two are not the same:

**An adopted job** has a wrapper. Delete the `# chronos:<id>` marker line and replace the wrapped
line with the schedule plus your original command, which is the single-quoted argument after `--`:

```cron
# chronos:42
*/5 * * * * '/path/to/schedmgr' run 42 --db '/path/to/chronos.db' -- '/usr/bin/python3 backup.py'
```

becomes:

```cron
*/5 * * * * /usr/bin/python3 backup.py
```

**A job created in ChronosUI** was never wrapped. Its command line is already the plain one, so
there is nothing to unwrap: delete the `# chronos:<id>` marker line above it and leave the rest
alone. Such a job keeps running normally even if you do nothing at all.

A line starting with `#` before the schedule means the job was disabled; keep that `#` if you want
it to stay disabled.

### What deleting the app leaves behind

| What | Where | Status |
|---|---|---|
| Notification LaunchAgent (macOS) | `~/Library/LaunchAgents/com.augustusw.chronos-ui.notify-flush.plist` | Removes itself. The agent checks whether the app bundle is still there and, after three consecutive misses, deletes its own plist and unloads. Allow up to 15 minutes. |
| notify-flush entry (Linux) | your crontab, under the `# chronos:notify-flush` marker | Manual: `crontab -e` and delete the marker together with the `schedmgr notify-flush` line under it. |
| Scheduled task (Windows) | the `\ChronosUI\` task folder | Manual: remove it in Task Scheduler. Windows has no self-clean yet. |
| Database and settings | the app's user-data directory (`~/Library/Application Support/` on macOS) | Kept unless teardown was told to delete it. Keep it if you plan to reinstall. |

If you want the macOS LaunchAgent gone immediately rather than waiting:

```bash
launchctl bootout gui/$(id -u)/com.augustusw.chronos-ui.notify-flush
rm ~/Library/LaunchAgents/com.augustusw.chronos-ui.notify-flush.plist
```

## Backward compatibility

Crontab lines written by an older ChronosUI used an unquoted `schedmgr` path. ChronosUI still
recognizes those lines; the next time it rewrites a managed line, it is emitted in the quoted form
above.
