// SPDX-License-Identifier: Apache-2.0
//
// Build / redact a Postgres connection string for ChronosUI's settings UI. The built DSN is the
// URL form node-postgres + src/main/db/client.ts's pgPoolOptions both understand (`new URL(dsn)`
// there pulls the hostname to decide TLS), and is what pg-secret.ts stores/retrieves opaquely — it
// never inspects the DSN's contents, just the string.

export interface PgDsnParts {
  host: string
  port: number
  database: string
  user: string
  password: string
  sslmode: string
}

/** Wraps a bare IPv6 literal in `[...]` (required in a URL authority so `host:port` parses
 *  unambiguously) — a no-op for hostnames/IPv4 (no ':') and for an already-bracketed host. */
function bracketHost(host: string): string {
  if (host.startsWith('[')) return host
  return host.includes(':') ? `[${host}]` : host
}

/** `postgresql://user:pass@host:port/db?sslmode=<v>`. Only `user`/`password` are
 *  encodeURIComponent'd (they are the two fields a user can type arbitrary text into that would
 *  otherwise break URL parsing, e.g. `@ : / # ?`) — `host`/`database`/`sslmode` are expected to be
 *  simple tokens (a bracketed IPv6 literal, and a Postgres identifier / enum value respectively). */
export function buildDsn(parts: PgDsnParts): string {
  const user = encodeURIComponent(parts.user)
  const password = encodeURIComponent(parts.password)
  const host = bracketHost(parts.host)
  return `postgresql://${user}:${password}@${host}:${parts.port}/${parts.database}?sslmode=${parts.sslmode}`
}

/** Replaces the password segment of a `scheme://user:password@...` DSN with `***`, for safe
 *  inclusion in error messages/logs. A no-op when the DSN carries no userinfo (no `user:pass@`
 *  prefix) — e.g. a bare `postgresql://host/db`. Only touches the userinfo password: host, port,
 *  database, and query string pass through unchanged.
 *
 *  The regex requires a literal '@' after the password to disambiguate "user:pass@" from a
 *  host:port with no userinfo at all (e.g. "postgresql://host:5432/db" must NOT match) — safe
 *  because buildDsn's encodeURIComponent guarantees a real DSN's password segment never contains a
 *  literal '@' (it would be encoded to %40), so the first '@' after the scheme is always the
 *  userinfo/host boundary. */
export function redactDsn(dsn: string): string {
  return dsn.replace(/^(\w+:\/\/[^:@/]+:)([^@]*)(@)/, '$1***$3')
}
