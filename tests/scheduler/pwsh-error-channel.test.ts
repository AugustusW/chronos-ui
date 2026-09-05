// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { TaskSchedulerAdapter, wrapPwshScript, PWSH_ERROR_MARKER, errorMessageFrom } from '../../src/main/scheduler/task-scheduler.adapter'
import type { ExecFn } from '../../src/main/scheduler/types'

// Windows round 3 (2026-09-05) measured the raw stderr bytes still arriving as cp950 even with
// [Console]::OutputEncoding set — that setting reaches stdout and not the error stream. Rather than
// keep chasing an encoding on a channel we do not control, the script now catches its own failure
// and writes the message to stdout, which is measurably UTF-8.
//
// That removes three problems at once: the encoding, the CLIXML envelope, and PowerShell's echo of
// the script — including the width-truncated "+ ..." fragment that survived matching against the
// full script text.

describe('wrapPwshScript', () => {
  it('runs the body inside a catch that reports on stdout and exits non-zero', () => {
    const s = wrapPwshScript('Get-ScheduledTask')
    expect(s).toContain('try {')
    expect(s).toContain('Get-ScheduledTask')
    expect(s).toContain('catch {')
    expect(s).toContain(PWSH_ERROR_MARKER)
    expect(s).toContain('[Console]::Out.WriteLine')
    expect(s).toContain('exit 1')
  })

  it('silences progress records, which are the other thing PowerShell puts on stderr', () => {
    // The cp950 bytes measured on Windows belonged to "正在準備模組以便第一次使用" — a progress
    // record, not an error. Nothing reads them and they only add noise to a failed run.
    expect(wrapPwshScript('x')).toContain("$ProgressPreference = 'SilentlyContinue'")
  })

  it('still sets Stop, which is what makes a failing cmdlet reach the catch at all', () => {
    expect(wrapPwshScript('x')).toContain("$ErrorActionPreference = 'Stop'")
  })
})

describe('errorMessageFrom', () => {
  it('prefers the marked line, and returns only the message', () => {
    const out = `some earlier output\n${PWSH_ERROR_MARKER}找不到內容 'TaskName' 等於 '排程 テスト'\n`
    expect(errorMessageFrom(out, 'ignored stderr', undefined)).toBe("找不到內容 'TaskName' 等於 '排程 テスト'")
  })

  it('falls back to stdout+stderr when nothing marked it', () => {
    // A failure that never reached the catch — a native exit code, say — still has to say something.
    // Silence here would be the defect this whole line of work started from.
    const msg = errorMessageFrom('partial output', '#< CLIXML\n<Objs><S S="Error">boom_x000D__x000A_</S></Objs>', undefined)
    expect(msg).toContain('partial output')
    expect(msg).toContain('boom')
  })

  it('never returns empty for a failure with no output at all', () => {
    expect(errorMessageFrom('', '', undefined)).not.toBe('')
  })
})

describe('the adapter sends the wrapped form', () => {
  it('every script it runs is wrapped', async () => {
    const seen: string[] = []
    const exec: ExecFn = async (_c, args) => {
      const i = args.indexOf('-EncodedCommand')
      seen.push(Buffer.from(args[i + 1], 'base64').toString('utf16le'))
      return { stdout: '[]', exitCode: 0 }
    }
    await new TaskSchedulerAdapter({ exec, schedmgrPath: 'C:\\s.exe', dbPath: 'C:\\d', taskFolder: '\\X\\' }).list()
    expect(seen[0]).toContain('try {')
    expect(seen[0]).toContain(PWSH_ERROR_MARKER)
  })
})
