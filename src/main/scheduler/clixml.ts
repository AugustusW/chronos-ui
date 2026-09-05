// SPDX-License-Identifier: Apache-2.0
//
// PowerShell serializes its error stream as CLIXML whenever stderr is redirected, which it always
// is here — the adapter spawns powershell.exe and captures the pipes. Before the delivery fix the
// error path never ran (everything came back exit 0), so nobody ever saw this. Now that failures
// surface, this is what decides whether they can be read.
//
// Two facts about the format, both measured on Windows 11 zh-TW PowerShell 5.1 (2026-09-05) and
// both contradicting an earlier guess in this file:
//
//   1. Records are console-WIDTH-WRAPPED fragments, not logical lines. A long line is split across
//      several <S S="Error"> nodes, sometimes mid-word: 'exists' arrived as 'exist' + 's'.
//   2. The position line is localized ("位於 line:2 字元:102"). An earlier version of this file
//      asserted "At line:" is never localized, on the strength of a sample taken from a terminal
//      run rather than from this pipe. It is localized here, so nothing may key off it.
//
// Which is why the echoed script is removed by matching the script we actually sent, rather than by
// recognizing the lines around it. We know exactly what we passed to -EncodedCommand; guessing at
// PowerShell's line furniture is what failed the first time.

const CLIXML_MARKER = '#< CLIXML'
const ERROR_RECORD_RE = /<S\s+S="Error">([\s\S]*?)<\/S>/g

/** PowerShell escapes control characters as _xNNNN_ inside CLIXML string nodes. */
function decodeEscapes(s: string): string {
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&') // last: an entity produced by an earlier rule must not be re-decoded
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * Rejoin width-wrapped fragments.
 *
 * A fragment as long as the widest one was almost certainly cut by the console width, so it
 * continues into the next and is joined with nothing — otherwise a word split across the boundary
 * gains a space it never had. Shorter fragments ended on their own and keep their line break.
 *
 * The width is taken from the document rather than assumed, because a spawned PowerShell does not
 * necessarily use 80 or 120. It is still a heuristic: a genuine line that happens to be the longest
 * in the document will be glued to the next one. That costs a line break in a message that is about
 * to have its bulk removed anyway, which is a better failure than splitting a word.
 */
function rejoin(fragments: string[]): string {
  const lines = fragments.map((f) => f.replace(/[\r\n]+$/, ''))
  const width = Math.max(...lines.map((l) => l.length))
  return lines.map((l, i) => (l.length >= width && i < lines.length - 1 ? l : l + '\n')).join('')
}

/**
 * Turn PowerShell's stderr into something a person can read.
 *
 * `script` is what was handed to -EncodedCommand. PowerShell echoes it back inside the error, and
 * with -EncodedCommand that is the entire script on one line — including the job's command, which
 * can carry a token in an env assignment. This string is shown in the UI, so the echo is removed by
 * exact match against what we sent.
 *
 * Anything unrecognized passes through, and so does CLIXML from which nothing survives extraction.
 * Reporting a failure as an empty message is the same defect as reporting it as success.
 */
export function readableStderr(raw: string, script?: string): string {
  if (!raw.includes(CLIXML_MARKER)) return raw

  const fragments = [...raw.matchAll(ERROR_RECORD_RE)].map((m) => decodeEntities(decodeEscapes(m[1])))
  if (fragments.length === 0) return raw

  let text = collapse(rejoin(fragments))
  if (script) {
    const echo = collapse(script)
    const at = text.indexOf(echo)
    if (at >= 0) text = (text.slice(0, at) + text.slice(at + echo.length)).trim()
  }
  text = text.replace(/^[\s:]+/, '').trim()
  if (!text) return raw

  // Put the two diagnostics back on their own lines; collapse() ran them into the message.
  return text.replace(/\s+\+\s+(CategoryInfo|FullyQualifiedErrorId)/g, '\n+ $1')
}
