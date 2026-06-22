// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { parseCrontab, serializeCrontab } from '../../src/main/scheduler/crontab-model'

const SAMPLE = `# my crontab
PATH=/usr/bin:/bin
MAILTO=me@example.com

0 3 * * * /usr/bin/python3 /Users/me/backup.py
# chronos:42
*/5 * * * * /opt/chronos/schedmgr run 42 --db /db -- 'echo hi'
# chronos:7
# 0 9 * * 1 /opt/chronos/schedmgr run 7 --db /db -- 'weekly.sh'
`

describe('crontab model', () => {
  it('round-trips an unchanged crontab byte-for-byte', () => {
    const model = parseCrontab(SAMPLE)
    expect(serializeCrontab(model)).toBe(SAMPLE)
  })

  it('classifies managed jobs (adopted + enabled/disabled) and leaves others alone', () => {
    const model = parseCrontab(SAMPLE)
    const managed = model.jobs.filter((j) => j.chronosId !== null)
    expect(managed.map((j) => j.chronosId)).toEqual([42, 7])
    const j42 = managed.find((j) => j.chronosId === 42)!
    expect(j42.enabled).toBe(true)
    expect(j42.scheduleExpr).toBe('*/5 * * * *')
    const j7 = managed.find((j) => j.chronosId === 7)!
    expect(j7.enabled).toBe(false) // commented-out under its marker
  })

  it('exposes the unmanaged job as adopted=false with no chronosId', () => {
    const model = parseCrontab(SAMPLE)
    const unmanaged = model.jobs.filter((j) => j.chronosId === null)
    expect(unmanaged).toHaveLength(1)
    expect(unmanaged[0].scheduleExpr).toBe('0 3 * * *')
    expect(unmanaged[0].command).toBe('/usr/bin/python3 /Users/me/backup.py')
  })

  it('preserves env and comment lines on round-trip after an unrelated edit', () => {
    const model = parseCrontab(SAMPLE)
    // disable job 42 by toggling its line; PATH/MAILTO/comment must remain verbatim
    model.setLineRaw(model.jobs.find((j) => j.chronosId === 42)!.lineIndex, '#*/5 * * * * /opt/chronos/schedmgr run 42 --db /db -- \'echo hi\'')
    const out = serializeCrontab(model)
    expect(out).toContain('PATH=/usr/bin:/bin')
    expect(out).toContain('MAILTO=me@example.com')
    expect(out).toContain('# my crontab')
    expect(out).toContain("#*/5 * * * * /opt/chronos/schedmgr run 42")
  })
})
