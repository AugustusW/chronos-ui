// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Windows has no crontab. Every place that named it directly was wrong on that platform, and the
// job editor was only the instance someone happened to hit — five more were sitting in the same
// files. schedulerLabel(hostPlatform()) has existed the whole time; the fix is to use it.
//
// This guards the class rather than the six instances: a component may not name a scheduler in
// literal text at all. The word is allowed in lib/scheduler-label.ts, which is where the choice
// is made.
const ROOT = fileURLToPath(new URL('../../src/renderer/src', import.meta.url))
const BANNED = /crontab|cron line/i

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) return vueFiles(p)
    return p.endsWith('.vue') ? [p] : []
  })
}

describe('no component names a scheduler that may not exist on this platform', () => {
  it('no .vue file contains "crontab" or "cron line"', () => {
    const offenders = vueFiles(ROOT)
      .map((p) => ({ file: relative(ROOT, p), lines: readFileSync(p, 'utf8').split('\n') }))
      .flatMap(({ file, lines }) =>
        lines
          .map((text, i) => ({ file, line: i + 1, text: text.trim() }))
          .filter((l) => BANNED.test(l.text))
      )
    expect(offenders, `use schedulerLabel(hostPlatform()) instead:\n${offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n')}`).toEqual([])
  })
})

