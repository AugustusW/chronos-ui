// SPDX-License-Identifier: Apache-2.0

// POSIX single-quoting: wrap in single quotes; a literal single quote is written as '\'' —
// i.e. close the quote, an escaped quote, reopen. This makes the result ONE shell word, so
// schedmgr receives the original command as a single arg after `--` and passes it verbatim to
// /bin/sh -c (Plan 3 contract). Without this, commands with && | > $VAR break silently.
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

// Inverse of shellQuote: parse a POSIX single-quoted token back to its literal value. Handles the
// '\'' escape sequence. Throws on input that is not a well-formed single-quoted token.
export function shellUnquote(s: string): string {
  if (s.length < 2 || s[0] !== "'" || s[s.length - 1] !== "'") {
    throw new Error(`shellUnquote: not a single-quoted token: ${s}`)
  }
  let out = ''
  let i = 1
  const end = s.length - 1
  while (i < end) {
    if (s[i] === "'") {
      // Must be the escape sequence '\'' : we are at a closing quote followed by \' then '
      if (s.slice(i, i + 4) === "'\\''") {
        out += "'"
        i += 4
        continue
      }
      throw new Error(`shellUnquote: malformed quoting at ${i}: ${s}`)
    }
    out += s[i]
    i++
  }
  return out
}
