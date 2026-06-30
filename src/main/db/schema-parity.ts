// SPDX-License-Identifier: Apache-2.0
//
// Compile-time parity guard (review #11): the pg repositories cast sqlite-typed rows into the pg row
// types, so the compiler alone would not catch a sqlite↔pg ROW-SHAPE drift. These type-level
// assertions fail `tsc` if the inferred Select row types diverge between the dialects — complementing
// the runtime schema-parity.test.ts (which guards column names / notNull / logical dataType). This
// file has no runtime output (type-only imports + type aliases erase to nothing).
import type { Job as SqliteJob, RunLog as SqliteRunLog, NotifySettings as SqliteNotify, NotifyOutbox as SqliteOutbox } from './schema'
import type { Job as PgJob, RunLog as PgRunLog, NotifySettings as PgNotify, NotifyOutbox as PgOutbox } from './schema.pg'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

// Each alias is a type error if that table's inferred Select row drifts between the two dialects.
export type _JobRowParity = Expect<Equal<SqliteJob, PgJob>>
export type _RunLogRowParity = Expect<Equal<SqliteRunLog, PgRunLog>>
export type _NotifyRowParity = Expect<Equal<SqliteNotify, PgNotify>>
export type _OutboxRowParity = Expect<Equal<SqliteOutbox, PgOutbox>>
