// SPDX-License-Identifier: Apache-2.0
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

// DB column names are camelCase, identical to spec §7's field list, so the SQLite file is the
// literal cross-language contract the Go schedmgr (Plan 3) writes against.
export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  source: text('source', { enum: ['native_cron', 'native_task'] }).notNull(),
  platform: text('platform', { enum: ['darwin', 'linux', 'win32'] }).notNull(),
  scheduleExpr: text('scheduleExpr').notNull(),
  command: text('command').notNull(),
  workingDir: text('workingDir'),
  env: text('env', { mode: 'json' }).$type<Record<string, string>>(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  adopted: integer('adopted', { mode: 'boolean' }).notNull().default(false),
  timeoutSec: integer('timeoutSec'),
  category: text('category'),
  notifyOnFailure: integer('notifyOnFailure', { mode: 'boolean' }).notNull().default(false),
  lastRunAt: integer('lastRunAt', { mode: 'timestamp_ms' }),
  lastResult: text('lastResult', { enum: ['success', 'failure', 'timeout'] }),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  // updatedAt is bumped explicitly by updateJob() only (a job *config* change). We deliberately
  // do NOT use $onUpdateFn here: it would also fire on setJobCachedRun() (a run finishing),
  // wrongly marking the job as edited. Semantics: updatedAt = config last-changed; lastRunAt = run.
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
})

export const runLogs = sqliteTable('run_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('jobId')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  triggeredBy: text('triggeredBy', { enum: ['schedule', 'manual'] }).notNull(),
  // null while a run is in progress (endedAt IS NULL); set on completion.
  result: text('result', { enum: ['success', 'failure', 'timeout'] }),
  startedAt: integer('startedAt', { mode: 'timestamp_ms' }).notNull(),
  endedAt: integer('endedAt', { mode: 'timestamp_ms' }),
  durationMs: integer('durationMs'),
  exitCode: integer('exitCode'),
  stdout: text('stdout'),
  stderr: text('stderr'),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
})

export const notifySettings = sqliteTable('notify_settings', {
  id: integer('id').primaryKey(), // always 1 (singleton)
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  chatId: text('chatId'),
  windowMin: integer('windowMin').notNull().default(0), // 0 = immediate; ≥1 = batch every N min
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date())
})

export const notifyOutbox = sqliteTable('notify_outbox', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('jobId').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  jobName: text('jobName').notNull(),
  result: text('result', { enum: ['failure', 'timeout'] }).notNull(),
  exitCode: integer('exitCode'),
  occurredAt: integer('occurredAt', { mode: 'timestamp_ms' }).notNull(),
  sentAt: integer('sentAt', { mode: 'timestamp_ms' }),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date())
})

export type Job = typeof jobs.$inferSelect
export type NewJob = typeof jobs.$inferInsert
export type RunLog = typeof runLogs.$inferSelect
export type NewRunLog = typeof runLogs.$inferInsert
export type NotifySettings = typeof notifySettings.$inferSelect
export type NewNotifySettings = typeof notifySettings.$inferInsert
export type NotifyOutbox = typeof notifyOutbox.$inferSelect
export type NewNotifyOutbox = typeof notifyOutbox.$inferInsert
