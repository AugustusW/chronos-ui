// SPDX-License-Identifier: Apache-2.0
//
// The only tests here that spawn a real powershell.exe. Everything else in the suite uses a fake
// ExecFn, which can confirm what the adapter sends and never what PowerShell does with it — and
// every defect this file guards against lived entirely in the latter.
//
// CI runs windows-latest, so these run on every push rather than once per manual round.
import { describe, it, expect } from 'vitest'
import {
  makePowerShellExec,
  encodePwshScript,
  wrapPwshScript,
  PWSH_ERROR_MARKER
} from '../../src/main/scheduler/task-scheduler.adapter'

const onWindows = describe.runIf(process.platform === 'win32')

// Goes through the adapter's own wrapper rather than a copy of it, so a change there cannot leave
// these passing against the old shape.
function run(body: string) {
  return makePowerShellExec()('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodePwshScript(wrapPwshScript(body))
  ])
}

onWindows('real powershell.exe, -EncodedCommand delivery', () => {
  it('runs a multi-line script and returns its output', async () => {
    // Multi-line is the exact shape stdin delivery silently truncated: PowerShell stayed in
    // line-continuation and discarded the buffer at EOF, exiting 0 with nothing done.
    const r = await run('$a = 40\n$b = 2\nWrite-Output ($a + $b)')
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('42')
  }, 30_000)

  it('reports a failing cmdlet as a non-zero exit', async () => {
    // Measured false under `-Command -`: the adapter decides success by reading exit 0, so if a
    // failure can come back as 0 then every "ok" it has ever returned is unfalsifiable.
    const r = await run("Get-ScheduledTask -TaskName 'chronos-definitely-not-a-task-xyz'")
    expect(r.exitCode).not.toBe(0)
  }, 30_000)

  it('and a succeeding cmdlet still exits 0 — so the check above is measuring something', async () => {
    // Without this, a non-zero exit could just mean this way of invoking PowerShell never works.
    const r = await run("Get-Date | Out-Null\nWrite-Output 'ok'")
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('ok')
  }, 30_000)

  it('brings non-ASCII back intact THROUGH THE ERROR PATH', async () => {
    // Round 3 (2026-09-05) failed here, and the reason the previous version of this test missed it
    // is worth keeping: it asserted on `Write-Output`, which travels on stdout — the channel that
    // was already working. The bytes that arrived as cp950 were on stderr. A test aimed at the
    // wrong channel passes while the thing it was written for stays broken.
    //
    // The non-ASCII is supplied by us rather than taken from the system's localized text, so this
    // means the same thing on an en-US CI runner as on the zh-TW machine that found the bug.
    //
    // WHAT THIS CANNOT COVER, and nothing in CI can: the bug found in round 3 was in PowerShell's
    // OWN localized text, and an en-US runner never produces any. Sending our own characters is
    // what makes the test portable and is also exactly why it cannot reach that case. It was
    // checked by hand on a zh-TW machine (2026-09-05 round 4: a full Chinese system message came
    // back with no replacement characters), and that is the only place it has ever been checked.
    // If that machine stops taking part, this case stops being looked at by anyone — noted here
    // rather than left to be rediscovered.
    const name = '排程 テスト naïve'
    const r = await run(`Get-ScheduledTask -TaskName '${name}'`)
    expect(r.exitCode).not.toBe(0)
    expect(r.stdout).toContain(name) // the characters, not merely "no mojibake"
    expect(r.stdout).not.toContain('�')
  }, 30_000)

  it('reports the failure as a plain message: no CLIXML, no echo of the script', async () => {
    // The wrapper writes the reason itself, so none of PowerShell's error formatting is involved.
    const r = await run("Get-ScheduledTask -TaskName 'chronos-definitely-not-a-task-xyz'")
    expect(r.stdout).not.toContain('CLIXML')
    expect(r.stdout).not.toContain('<Objs')
    expect(r.stdout).not.toContain(PWSH_ERROR_MARKER) // the marker is consumed, not shown
    expect(r.stdout).not.toContain('ErrorActionPreference')
    expect(r.stdout).not.toContain('OutputEncoding')
    // The width-truncated `+ …` fragment that survived the previous fix.
    expect(r.stdout).not.toMatch(/^\s*\+ /m)
  }, 30_000)
})
