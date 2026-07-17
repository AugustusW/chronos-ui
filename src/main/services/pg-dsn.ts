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

/** `postgresql://user:pass@host:port/db?sslmode=<v>`. `user`/`password`/`database` are all
 *  encodeURIComponent'd — every one of them is a field a user can type arbitrary Postgres-identifier
 *  text into (`@ : / # ?`) that would otherwise break URL parsing; `database` in particular sits in
 *  the URL's path segment, where an unencoded `/` splits the path and an unencoded `?`/`#` reopens
 *  the query string / fragment (code review M2 — a database named e.g. `db/name?x` would otherwise
 *  silently point the DSN at the wrong path and corrupt the sslmode query param). `host`/`sslmode`
 *  are the only two fields still expected to be simple tokens (a bracketed IPv6 literal, and a fixed
 *  enum value respectively). */
export function buildDsn(parts: PgDsnParts): string {
  const user = encodeURIComponent(parts.user)
  const password = encodeURIComponent(parts.password)
  const host = bracketHost(parts.host)
  const database = encodeURIComponent(parts.database)
  return `postgresql://${user}:${password}@${host}:${parts.port}/${database}?sslmode=${parts.sslmode}`
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
