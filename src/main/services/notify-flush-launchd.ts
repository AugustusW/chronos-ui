// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path'
import type { WriteResult } from '../scheduler/types'

/** Platform-agnostic install/remove of ChronosUI's own notify-flush scheduled entry. notify.service
 *  depends on this, not on a specific scheduler — so macOS can use a LaunchAgent while linux/win use
 *  the crontab / Task Scheduler adapters. */
export interface FlushScheduler {
  install(windowMin: number): Promise<WriteResult>
  remove(): Promise<WriteResult>
}

export interface LaunchdFlushDeps {
  schedmgrPath: string
  dbDescriptor: string
  /** ~/Library/LaunchAgents (injectable for tests). */
  launchAgentsDir: string
  /** The GUI session uid (process.getuid()). */
  uid: number
  /** Runs `launchctl …`; returns its exit code. Injectable so tests never touch real launchctl. */
  exec: (cmd: string, args: string[]) => Promise<{ exitCode: number; stdout: string }>
  writeFile: (path: string, content: string) => void
  rmFile: (path: string) => void
}

export const LAUNCHD_FLUSH_LABEL = 'com.augustusw.chronos-ui.notify-flush'

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function buildPlist(schedmgrPath: string, dbDescriptor: string, intervalSec: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_FLUSH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(schedmgrPath)}</string>
    <string>notify-flush</string>
    <string>--db</string>
    <string>${xmlEscape(dbDescriptor)}</string>
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

  return {
    async install(windowMin) {
      if (!Number.isInteger(windowMin) || windowMin < 1) {
        return { ok: false, reason: 'error', error: `installFlush: windowMin must be ≥1, got ${windowMin}` }
      }
      deps.writeFile(plistPath, buildPlist(deps.schedmgrPath, deps.dbDescriptor, windowMin * 60))
      // bootout first so a re-install (e.g. window change) is idempotent; ignore failure (not loaded yet).
      await deps.exec('launchctl', ['bootout', serviceTarget])
      const { exitCode, stdout } = await deps.exec('launchctl', ['bootstrap', guiDomain, plistPath])
      if (exitCode !== 0) {
        return { ok: false, reason: 'error', error: `launchctl bootstrap exited ${exitCode}: ${stdout}`.trim() }
      }
      return { ok: true }
    },

    async remove() {
      // Best-effort: bootout (ignore "not loaded") then drop the plist (ignore "already gone").
      await deps.exec('launchctl', ['bootout', serviceTarget])
      try {
        deps.rmFile(plistPath)
      } catch {
        /* best-effort: plist already absent or unremovable */
      }
      return { ok: true }
    }
  }
}
