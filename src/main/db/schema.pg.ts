// SPDX-License-Identifier: Apache-2.0
import { pgTable, serial, integer, text, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core'

const ts = (name: string) => timestamp(name, { mode: 'date', withTimezone: true })

export const jobs = pgTable('jobs', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  source: text('source', { enum: ['native_cron', 'native_task'] }).notNull(),
  platform: text('platform', { enum: ['darwin', 'linux', 'win32'] }).notNull(),
  scheduleExpr: text('scheduleExpr').notNull(),
  command: text('command').notNull(),
  workingDir: text('workingDir'),
  env: jsonb('env').$type<Record<string, string>>(),
  enabled: boolean('enabled').notNull().default(true),
  adopted: boolean('adopted').notNull().default(false),
  timeoutSec: integer('timeoutSec'),
  category: text('category'),
  notifyOnFailure: boolean('notifyOnFailure').notNull().default(false),
  lastRunAt: ts('lastRunAt'),
  lastResult: text('lastResult', { enum: ['success', 'failure', 'timeout'] }),
  createdAt: ts('createdAt')
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: ts('updatedAt')
    .notNull()
    .$defaultFn(() => new Date())
})

export const runLogs = pgTable('run_logs', {
  id: serial('id').primaryKey(),
  jobId: integer('jobId')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  triggeredBy: text('triggeredBy', { enum: ['schedule', 'manual'] }).notNull(),
  result: text('result', { enum: ['success', 'failure', 'timeout'] }),
  startedAt: ts('startedAt').notNull(),
  endedAt: ts('endedAt'),
  durationMs: integer('durationMs'),
  exitCode: integer('exitCode'),
  stdout: text('stdout'),
  stderr: text('stderr'),
  createdAt: ts('createdAt')
    .notNull()
    .$defaultFn(() => new Date())
}, (t) => ({
  // Mirrors schema.ts: composite index for listRunsForJob / getLatestRun
  // (WHERE jobId=? ORDER BY startedAt DESC, id DESC) + the retention DELETE (review #4).
  jobStartedIdx: index('run_logs_jobId_startedAt_id_idx').on(t.jobId, t.startedAt, t.id),
  // Dashboard's today-window aggregates (WHERE startedAt >= ? [AND result IN …]) carry no jobId,
  // so the composite above never serves them; this one does (architect HIGH-2, dashboard spec).
  startedResultIdx: index('run_logs_startedAt_result_idx').on(t.startedAt, t.result)
}))

// Mirrors jobRevisions in schema.ts — see that file for why this table exists. Kept row-shape
// identical (schema-parity.ts asserts it at compile time; schema-parity.test.ts at runtime).
export const jobRevisions = pgTable('job_revisions', {
  id: serial('id').primaryKey(),
  jobId: integer('jobId')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  changedAt: ts('changedAt')
    .notNull()
    .$defaultFn(() => new Date()),
  source: text('source', { enum: ['edit', 'adopt', 'unadopt', 'external', 'resolved'] }).notNull(),
  changedFields: jsonb('changedFields').$type<string[]>().notNull(),
  before: jsonb('before').$type<Record<string, unknown>>().notNull(),
  after: jsonb('after').$type<Record<string, unknown>>().notNull()
}, (t) => ({
  jobChangedIdx: index('job_revisions_jobId_changedAt_id_idx').on(t.jobId, t.changedAt, t.id)
}))

export const notifySettings = pgTable('notify_settings', {
  id: integer('id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  chatId: text('chatId'),
  windowMin: integer('windowMin').notNull().default(0),
  // Opt-in (default off): include the failed job's stderr tail in immediate alerts (stderr can carry
  // secrets, so sending it to Telegram is an explicit user choice). Mirrors schema.ts.
  includeStderr: boolean('includeStderr').notNull().default(false),
  // v0.4.0: macOS native (Notification Center) alert on a scheduled job's failure. Mirrors schema.ts.
  nativeEnabled: boolean('nativeEnabled').notNull().default(true),
  updatedAt: ts('updatedAt').notNull().$defaultFn(() => new Date())
})

export const notifyOutbox = pgTable('notify_outbox', {
  id: serial('id').primaryKey(),
  jobId: integer('jobId').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  jobName: text('jobName').notNull(),
  result: text('result', { enum: ['failure', 'timeout'] }).notNull(),
  exitCode: integer('exitCode'),
  occurredAt: ts('occurredAt').notNull(),
  sentAt: ts('sentAt'),
  createdAt: ts('createdAt').notNull().$defaultFn(() => new Date())
})

export type Job = typeof jobs.$inferSelect
export type NewJob = typeof jobs.$inferInsert
export type RunLog = typeof runLogs.$inferSelect
export type NewRunLog = typeof runLogs.$inferInsert
export type JobRevision = typeof jobRevisions.$inferSelect
export type NewJobRevision = typeof jobRevisions.$inferInsert
export type NotifySettings = typeof notifySettings.$inferSelect
export type NewNotifySettings = typeof notifySettings.$inferInsert
export type NotifyOutbox = typeof notifyOutbox.$inferSelect
export type NewNotifyOutbox = typeof notifyOutbox.$inferInsert
