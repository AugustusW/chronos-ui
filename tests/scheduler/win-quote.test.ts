// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { winQuoteArg, winUnquoteArg, psQuote } from '../../src/main/scheduler/win-quote'

describe('winQuoteArg / winUnquoteArg (CommandLineToArgvW)', () => {
  it('wraps a simple arg in double quotes', () => {
    expect(winQuoteArg('backup.bat')).toBe('"backup.bat"')
    expect(winQuoteArg('')).toBe('""')
  })

  it('escapes an embedded double quote as \\"', () => {
    expect(winQuoteArg('a"b')).toBe('"a\\"b"')
  })

  it('doubles backslashes only when they precede a quote (incl. the closing one)', () => {
    // single backslash before a normal char → literal (not doubled)
    expect(winQuoteArg('a\\b')).toBe('"a\\b"')
    // trailing backslash precedes the closing quote → doubled
    expect(winQuoteArg('a\\')).toBe('"a\\\\"')
    // backslash then quote → backslash doubled + quote escaped (2*1+1 = 3 backslashes)
    expect(winQuoteArg('a\\"b')).toBe('"a\\\\\\"b"')
  })

  it('round-trips every corner case (quote then unquote = identity)', () => {
    const cases = [
      'backup.bat',
      'C:\\Program Files\\app\\run.exe --flag',
      'a && b | c > out.txt',
      'C:\\Users\\John Doe\\',     // spaced path + trailing backslash
      'echo "hi"',                 // embedded quotes
      'weird\\\\path\\\\',         // multiple trailing backslashes
      ''
    ]
    for (const c of cases) {
      expect(winUnquoteArg(winQuoteArg(c)), c).toBe(c)
    }
  })

  it('winUnquoteArg rejects a non-double-quoted token', () => {
    expect(() => winUnquoteArg('nope')).toThrow()
  })
})

describe('psQuote (PowerShell single-quote literal)', () => {
  it('wraps in single quotes and doubles embedded single quotes', () => {
    expect(psQuote("it's")).toBe("'it''s'")
    expect(psQuote('C:\\path\\x.exe')).toBe("'C:\\path\\x.exe'") // backslashes are literal in PS single-quotes
  })
})
