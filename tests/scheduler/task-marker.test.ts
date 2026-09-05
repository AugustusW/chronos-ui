// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { buildDescription, parseDescription } from '../../src/main/scheduler/task-marker'

describe('task Description marker', () => {
  it('builds a stamped multi-line Description and round-trips it', () => {
    const d = buildDescription(42, 'daily 03:00')
    expect(d).toContain('chronos:42')
    expect(d).toContain('sched:daily 03:00')
    expect(parseDescription(d)).toEqual({ chronosId: 42, scheduleDescriptor: 'daily 03:00' })
  })

  it('returns null for an unmanaged (non-ChronosUI) Description', () => {
    expect(parseDescription('Some user task')).toBeNull()
    expect(parseDescription(null)).toBeNull()
    expect(parseDescription('')).toBeNull()
  })
})

describe('the marker carries the action it replaced', () => {
  it('round-trips the original Execute and Arguments verbatim', () => {
    // Un-adopt used to rebuild the action as `cmd.exe /c <flattened string>`, because toParsed
    // flattens Execute and Arguments into one. That is not what the task had: wrapping in cmd /c
    // changes how &, | and > are handled and how the exit code comes back. The dialog promises
    // "fully reversible", and un-adopt is the user's way out — one that quietly changes how the
    // command runs is not one.
    const d = buildDescription(7, 'daily 03:00', { execute: 'C:\\Backup\\backup.exe', args: '-full "a b"' })
    expect(parseDescription(d)?.original).toEqual({ execute: 'C:\\Backup\\backup.exe', args: '-full "a b"' })
  })

  it('survives an argument containing a newline', () => {
    // The marker is parsed line by line, so a raw multi-line value would corrupt it — the same
    // hazard that made buildDescription's output break the old stdin script delivery. Hence base64.
    const d = buildDescription(7, 'daily 03:00', { execute: 'x.exe', args: 'first\nsecond' })
    expect(parseDescription(d)?.original?.args).toBe('first\nsecond')
    expect(d.split('\n')).toHaveLength(5) // three human lines plus exec: and args:
  })

  it('keeps the first three lines readable', () => {
    // Task Scheduler has no metadata slot; Description is where a person looks. The encoded values
    // go after the part that is meant to be read.
    const d = buildDescription(7, 'daily 03:00', { execute: 'x.exe', args: '' })
    expect(d.split('\n').slice(0, 3)).toEqual(['ChronosUI managed job', 'chronos:7', 'sched:daily 03:00'])
  })

  it('a marker written before this change still parses', () => {
    // Tasks adopted by an earlier build have no exec:/args: lines at all.
    const m = parseDescription('ChronosUI managed job\nchronos:7\nsched:daily 03:00')
    expect(m?.chronosId).toBe(7)
    expect(m?.scheduleDescriptor).toBe('daily 03:00')
    expect(m?.original).toBeUndefined()
  })

  it('the OLD parser still reads the NEW format — this is what makes rollback safe', () => {
    // Rollback direction, the opposite of the test above. The two regexes are per-line anchored
    // and do not count lines, so extra lines are ignored. Asserting it here turns an architecture
    // argument into a regression test: reorder the lines later and this goes red.
    const OLD_CHRONOS_RE = /^chronos:(\d+)$/m
    const OLD_SCHED_RE = /^sched:(.+)$/m
    const d = buildDescription(7, 'daily 03:00', { execute: 'x.exe', args: '-a' })
    expect(OLD_CHRONOS_RE.exec(d)?.[1]).toBe('7')
    expect(OLD_SCHED_RE.exec(d)?.[1].trim()).toBe('daily 03:00')
  })

  it('omitting the original leaves the marker exactly as it was', () => {
    // createJob names and builds its own task; there is no prior action to preserve. Adding empty
    // exec:/args: lines would put unreadable noise in front of every user for no reason.
    expect(buildDescription(7, 'daily 03:00')).toBe('ChronosUI managed job\nchronos:7\nsched:daily 03:00')
  })
})
