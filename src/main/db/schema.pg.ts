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
  jobStartedIdx: index('run_logs_jobId_startedAt_id_idx').on(t.jobId, t.startedAt, t.id)
}))

export const notifySettings = pgTable('notify_settings', {
  id: integer('id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  chatId: text('chatId'),
  windowMin: integer('windowMin').notNull().default(0),
  // Opt-in (default off): include the failed job's stderr tail in immediate alerts (stderr can carry
  // secrets, so sending it to Telegram is an explicit user choice). Mirrors schema.ts.
  includeStderr: boolean('includeStderr').notNull().default(false),
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
export type NotifySettings = typeof notifySettings.$inferSelect
export type NewNotifySettings = typeof notifySettings.$inferInsert
export type NotifyOutbox = typeof notifyOutbox.$inferSelect
export type NewNotifyOutbox = typeof notifyOutbox.$inferInsert
