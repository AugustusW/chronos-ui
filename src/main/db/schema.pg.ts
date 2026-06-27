// SPDX-License-Identifier: Apache-2.0
import { pgTable, serial, integer, text, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core'

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
})

export type Job = typeof jobs.$inferSelect
export type NewJob = typeof jobs.$inferInsert
export type RunLog = typeof runLogs.$inferSelect
export type NewRunLog = typeof runLogs.$inferInsert
