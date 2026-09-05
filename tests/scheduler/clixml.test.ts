// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { readableStderr } from '../../src/main/scheduler/clixml'

// IMPORTANT — where this fixture comes from, and why the previous one was wrong.
//
// The first version of this file used a sample captured under the OLD `-Command -` delivery, where
// the script arrived as several lines and PowerShell's error record therefore contained
// "At line:N char:M" and "+ <that line>". The filter was written against that shape, the tests were
// green, and on Windows the entire script still came through: under `-EncodedCommand` the script is
// ONE line, so PowerShell puts the whole thing at the head of the record where neither prefix
// matches. The delivery mode changed and the sample did not.
//
// This fixture is reconstructed from the verbatim transcription in
// docs/superpowers/chronosUI/verification/ (2026-09-05 round 2), which recorded what a Windows 11
// zh-TW PowerShell 5.1 actually produced under -EncodedCommand. Two things it taught:
//   - records are console-WIDTH-WRAPPED fragments, not logical lines: 'exists' came back split as
//     'exist' + 's' across two <S> nodes
//   - the position line is localized ("位於 line:2 字元:102"), so it cannot be matched by prefix
const SCRIPT = `$ErrorActionPreference = 'Stop'
if (Get-ScheduledTask -TaskName 'chronos-1' -ErrorAction SilentlyContinue) { Write-Error 'exists'; exit 1 }
Register-ScheduledTask -TaskName 'chronos-1' -InputObject $task | Out-Null`

// Built by actually slicing at a width, because that is what wrapping does: every fragment except
// the last of a logical line is exactly the width. An earlier version of this fixture invented the
// split points and produced a short fragment in the middle — a shape the console never emits, which
// made the rejoin look broken when it was the sample that was wrong.
const ONE_LINE = SCRIPT.replace(/\s+/g, ' ') + ' : exists 位於 line:2 字元:102'
// Choose the width so the boundary lands inside the final "exists", reproducing the reported split.
const WIDTH = ONE_LINE.lastIndexOf('exists') + 5
const wrap = (line: string): string[] => {
  const out: string[] = []
  for (let i = 0; i < line.length; i += WIDTH) out.push(line.slice(i, i + WIDTH))
  return out
}
const FRAGMENTS = [
  ...wrap(ONE_LINE),
  '    + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException',
  '    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException'
]
const REAL =
  '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
  '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN></Obj>' +
  FRAGMENTS.map((f) => `<S S="Error">${f}_x000D__x000A_</S>`).join('') +
  '</Objs>'

describe('readableStderr', () => {
  it('removes the echoed script, which is the whole point', () => {
    const out = readableStderr(REAL, SCRIPT)
    expect(out).not.toContain('Register-ScheduledTask')
    expect(out).not.toContain('ErrorActionPreference')
    // The job's own command rides inside that script and can hold a token in an env assignment.
    expect(out).not.toContain('SilentlyContinue')
  })

  it('keeps the reason, un-split', () => {
    // Width wrapping cut 'exists' in half. Joining the fragments with a separator would leave
    // 'exist s' — readable to a person, but it breaks any later attempt to match on the text.
    expect(readableStderr(REAL, SCRIPT)).toContain('exists')
    expect(readableStderr(REAL, SCRIPT)).not.toContain('exist s')
  })

  it('keeps the diagnostics on their own lines', () => {
    const out = readableStderr(REAL, SCRIPT)
    expect(out).toMatch(/^\+ CategoryInfo/m)
    expect(out).toMatch(/^\+ FullyQualifiedErrorId/m)
  })

  it('strips no XML', () => {
    const out = readableStderr(REAL, SCRIPT)
    expect(out).not.toContain('CLIXML')
    expect(out).not.toContain('<Objs')
    expect(out).not.toContain('<S S="Error">')
  })

  it('decodes entities', () => {
    const x = `#< CLIXML\n<Objs><S S="Error">bad value: &lt;null&gt; &amp; empty_x000D__x000A_</S></Objs>`
    expect(readableStderr(x)).toBe('bad value: <null> & empty')
  })

  it('returns plain stderr untouched', () => {
    expect(readableStderr('plain: something broke')).toBe('plain: something broke')
    expect(readableStderr('')).toBe('')
  })

  it('falls back to the raw text when nothing survives', () => {
    // An error reported as "" is the same defect as an error reported as success.
    const noErrors = `#< CLIXML\n<Objs><Obj S="progress" RefId="0"></Obj></Objs>`
    expect(readableStderr(noErrors)).toBe(noErrors)
    // Echo removal leaving nothing behind must also fall back rather than return blank.
    const onlyEcho = `#< CLIXML\n<Objs><S S="Error">${SCRIPT.replace(/\n/g, ' ')}_x000D__x000A_</S></Objs>`
    expect(readableStderr(onlyEcho, SCRIPT)).toBe(onlyEcho)
  })

  it('leaves the message alone when no script is supplied', () => {
    expect(readableStderr(REAL)).toContain('Register-ScheduledTask')
  })
})
