// SPDX-License-Identifier: Apache-2.0

// Two Windows quoting layers — keep them straight:
//
//  1. winQuoteArg / winUnquoteArg — CommandLineToArgvW rules (the convention the
//     MSVCRT / Go / .NET runtimes parse). Used for ONE argv token inside a Task
//     Scheduler Action's Arguments string, so when the task fires Windows hands
//     schedmgr.exe the db path and the original command each as a single arg
//     after `--`. The Windows analog of the POSIX shellQuote on the crontab side.
//     Ref: Daniel Colascione, "Everyone quotes command line arguments the wrong
//     way" (MSDN, 2011).
//  2. psQuote — PowerShell single-quote literal (' -> ''). Used to embed a value
//     in the PowerShell SCRIPT we generate. Backslashes are literal inside PS
//     single-quotes, so no backslash handling is needed.
//
// adopt() applies BOTH: winQuoteArg the fields (for the runtime argv parse), then
// psQuote the whole Arguments string (for script embedding). They are NOT the same
// and must not be confused (architect D4).

// Quote ONE argument per CommandLineToArgvW. We always wrap (even when unneeded)
// for predictable round-tripping, matching shellQuote which always single-quotes.
export function winQuoteArg(s: string): string {
  let out = '"'
  let backslashes = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (ch === '"') {
      // These backslashes precede a quote → double them, then escape the quote.
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    // Normal char → pending backslashes are literal (not before a quote).
    out += '\\'.repeat(backslashes) + ch
    backslashes = 0
  }
  // Trailing backslashes precede the closing quote → double them.
  out += '\\'.repeat(backslashes * 2) + '"'
  return out
}

// Inverse of winQuoteArg: parse ONE double-quoted CommandLineToArgvW token back to
// its literal value. Used by list() to recover the original command from an adopted
// task's Arguments (the segment after `--`). Throws on a non-token.
export function winUnquoteArg(s: string): string {
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') {
    throw new Error(`winUnquoteArg: not a double-quoted token: ${s}`)
  }
  const inner = s.slice(1, -1)
  let out = ''
  let i = 0
  while (i < inner.length) {
    const ch = inner[i]
    if (ch === '\\') {
      let bs = 0
      while (i < inner.length && inner[i] === '\\') {
        bs++
        i++
      }
      const atEnd = i >= inner.length
      if (!atEnd && inner[i] === '"') {
        // backslashes precede an escaped quote: 2n+1 → n backslashes + literal "
        if (bs % 2 === 0) throw new Error(`winUnquoteArg: unescaped quote: ${s}`)
        out += '\\'.repeat(Math.floor(bs / 2)) + '"'
        i++ // consume the escaped quote
      } else if (atEnd) {
        // backslashes precede the closing delimiter → halve them
        out += '\\'.repeat(Math.floor(bs / 2))
      } else {
        // backslashes before a normal char → literal
        out += '\\'.repeat(bs)
      }
      continue
    }
    if (ch === '"') throw new Error(`winUnquoteArg: unescaped quote: ${s}`)
    out += ch
    i++
  }
  return out
}

// PowerShell single-quoted string literal: wrap in ' and double any embedded '.
export function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'"
}
