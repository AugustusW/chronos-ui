// SPDX-License-Identifier: Apache-2.0
// LaunchAgents are a macOS-only concept, so the plist path is always POSIX — use node:path/posix's
// join (not the ambient node:path, which is win32 on a Windows host) so the path is forward-slash
// regardless of the OS the process/test runs on.
import { join } from 'node:path/posix'
import { shellQuote } from '../scheduler/shell-quote'
import type { WriteResult } from '../scheduler/types'

/** Platform-agnostic install/remove of ChronosUI's own notify-flush scheduled entry. notify.service
 *  depends on this, not on a specific scheduler — so macOS can use a LaunchAgent while linux/win use
 *  the crontab / Task Scheduler adapters. */
export interface FlushScheduler {
  install(windowMin: number): Promise<WriteResult>
  remove(): Promise<WriteResult>
  /**
   * Bring an ALREADY-INSTALLED entry up to date with this build, and do nothing else.
   *
   * Why this exists: `install` runs only when the user saves notification settings, so an agent
   * written by an older build survives every upgrade untouched. The self-clean added in the teardown
   * work would then reach new installs only — never the upgraders it was written for, whose stale
   * agent keeps invoking a deleted binary every StartInterval, forever.
   *
   * Returns null when nothing was done: the entry is already current, or there is no entry at all.
   * "No entry" must stay a no-op — creating one here would resurrect what teardown just removed.
   */
  refreshIfStale(windowMin: number): Promise<WriteResult | null>
}

export interface LaunchdFlushDeps {
  schedmgrPath: string
  dbDescriptor: string
  /** ~/Library/LaunchAgents (injectable for tests). */
  launchAgentsDir: string
  /** The GUI session uid (process.getuid()). */
  uid: number
  /**
   * Absolute path to the .app bundle in a packaged build; null/absent in dev.
   * Present ⇒ the agent self-cleans once the bundle is gone (teardown spec §3). We test the BUNDLE
   * DIRECTORY, not the schedmgr binary: during an app update the binary can be briefly missing while
   * the bundle is being replaced, and a binary check would self-destruct on that window.
   */
  appBundlePath?: string | null
  /** Where the consecutive-miss counter lives. Required for self-clean; ignored in dev. */
  missCounterPath?: string
  /** Runs `launchctl …`; returns its exit code. Injectable so tests never touch real launchctl. */
  exec: (cmd: string, args: string[]) => Promise<{ exitCode: number; stdout: string }>
  writeFile: (path: string, content: string) => void
  rmFile: (path: string) => void
  /** Reads a file, returning null when it does not exist. Absent ⇒ refreshIfStale is a no-op. */
  readFile?: (path: string) => string | null
}

export const LAUNCHD_FLUSH_LABEL = 'com.augustusw.chronos-ui.notify-flush'

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** How many consecutive "bundle is gone" observations before the agent removes itself. */
const MISS_THRESHOLD = 3

/**
 * The shell body launchd runs. Two shapes:
 *
 *  - dev (no bundle path): just exec schedmgr. Still routed through /bin/sh -c so dev exercises the
 *    same execution path as production — a bug in the wrapper should surface in dev, not only after
 *    someone ships.
 *  - packaged: check the bundle first. Present ⇒ reset the counter and exec as usual. Absent ⇒ count
 *    the miss, and on the third one delete the counter file and the plist and THEN bootout.
 *
 * The order of those last two lines is not stylistic. Measured on 2026-09-04: launchd terminates the
 * script the moment `launchctl bootout` takes effect, so anything after it never runs — the removals
 * must come first, and nothing may follow the bootout.
 */
function buildScript(deps: LaunchdFlushDeps, plistPath: string): string {
  const run = `exec ${shellQuote(deps.schedmgrPath)} notify-flush --db ${shellQuote(deps.dbDescriptor)}`
  if (!deps.appBundlePath || !deps.missCounterPath) return run

  const miss = shellQuote(deps.missCounterPath)
  return [
    `if [ -d ${shellQuote(deps.appBundlePath)} ]; then`,
    `  rm -f ${miss}`,
    `  ${run}`,
    `fi`,
    `n=$(cat ${miss} 2>/dev/null || echo 0)`,
    `n=$((n + 1))`,
    `echo "$n" > ${miss}`,
    `[ "$n" -lt ${MISS_THRESHOLD} ] && exit 0`,
    `rm -f ${miss} ${shellQuote(plistPath)}`,
    `launchctl bootout gui/${deps.uid}/${LAUNCHD_FLUSH_LABEL}`
  ].join('\n')
}

function buildPlist(script: string, intervalSec: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_FLUSH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${xmlEscape(script)}</string>
  </array>
  <key>StartInterval</key><integer>${intervalSec}</integer>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`
}

/** macOS FlushScheduler: a per-user LaunchAgent in ~/Library/LaunchAgents — NOT a crontab line, so
 *  it never touches the TCC-protected /var/at/tabs and never triggers the SysAdminFiles prompt. */
export function createLaunchdFlush(deps: LaunchdFlushDeps): FlushScheduler {
  const plistPath = join(deps.launchAgentsDir, `${LAUNCHD_FLUSH_LABEL}.plist`)
  const serviceTarget = `gui/${deps.uid}/${LAUNCHD_FLUSH_LABEL}`
  const guiDomain = `gui/${deps.uid}`

  const plistFor = (windowMin: number): string => buildPlist(buildScript(deps, plistPath), windowMin * 60)

  async function install(windowMin: number): Promise<WriteResult> {
    if (!Number.isInteger(windowMin) || windowMin < 1) {
      return { ok: false, reason: 'error', error: `installFlush: windowMin must be ≥1, got ${windowMin}` }
    }
    deps.writeFile(plistPath, plistFor(windowMin))
    // bootout first so a re-install (e.g. window change) is idempotent; ignore failure (not loaded yet).
    await deps.exec('launchctl', ['bootout', serviceTarget])
    const { exitCode, stdout } = await deps.exec('launchctl', ['bootstrap', guiDomain, plistPath])
    if (exitCode !== 0) {
      return { ok: false, reason: 'error', error: `launchctl bootstrap exited ${exitCode}: ${stdout}`.trim() }
    }
    return { ok: true }
  }

  return {
    install,

    async refreshIfStale(windowMin) {
      if (!deps.readFile) return null
      if (!Number.isInteger(windowMin) || windowMin < 1) return null
      const current = deps.readFile(plistPath)
      // Not installed: notifications are off, or teardown removed it. Either way, not ours to create.
      if (current === null) return null
      // Compare, don't just rewrite. An unconditional reinstall on every launch restarts the
      // StartInterval countdown, so an app opened and closed more often than the flush window would
      // never flush at all.
      if (current === plistFor(windowMin)) return null
      return install(windowMin)
    },

    async remove() {
      // Best-effort: bootout (ignore "not loaded") then drop the plist (ignore "already gone").
      await deps.exec('launchctl', ['bootout', serviceTarget])
      // Both files, or the "leaves nothing behind" feature leaves the counter behind (architect H2).
      for (const p of [plistPath, deps.missCounterPath].filter((x): x is string => !!x)) {
        try {
          deps.rmFile(p)
        } catch {
          /* best-effort: already absent or unremovable */
        }
      }
      return { ok: true }
    }
  }
}
