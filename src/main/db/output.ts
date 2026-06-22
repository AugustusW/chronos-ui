// SPDX-License-Identifier: Apache-2.0
/**
 * Keep the last `maxBytes` bytes (UTF-8) of `text`. Captured command output is bounded to the
 * tail because the end (errors, final status) is the most useful (spec §5.5: last 64 KB each).
 * The cut is advanced forward to the next UTF-8 character boundary, so the result never starts
 * mid-codepoint (no U+FFFD replacement bytes) and never exceeds `maxBytes` — the byte cap is a
 * true upper bound (matters if a length CHECK constraint is added later).
 */
export function keepLastBytes(text: string, maxBytes: number = 64 * 1024): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let start = buf.length - maxBytes
  // UTF-8 continuation bytes match 10xxxxxx; advance past any so we start on a char boundary.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return buf.subarray(start).toString('utf8')
}
