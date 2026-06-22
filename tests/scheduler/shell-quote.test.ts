// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { shellQuote, shellUnquote } from '../../src/main/scheduler/shell-quote'

describe('shellQuote / shellUnquote', () => {
  const cases = [
    'backup.sh',
    '/usr/bin/python3 /Users/me/backup.py',
    'a && b || c',
    'echo $HOME | grep x > /tmp/out',
    "it's a path/with quote",
    'tab\tand space'
  ]

  it('wraps a command as a single POSIX-quoted token', () => {
    expect(shellQuote('backup.sh')).toBe("'backup.sh'")
    // a single quote becomes '\'' (close, escaped quote, reopen)
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
  })

  it('round-trips every case (quote then unquote = identity)', () => {
    for (const c of cases) {
      expect(shellUnquote(shellQuote(c)), c).toBe(c)
    }
  })

  it('quoted form is a single shell word (sh -c echo prints the original)', () => {
    // The quoted string, when handed to `sh -c "echo <quoted>"`, must echo the original.
    // (Verified semantically here by unquote; an integration check lives in the adapter tests.)
    expect(shellUnquote(shellQuote('a && b'))).toBe('a && b')
  })
})
