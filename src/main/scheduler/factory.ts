// SPDX-License-Identifier: Apache-2.0
import { CrontabAdapter } from './crontab.adapter'
import { TaskSchedulerAdapter } from './task-scheduler.adapter'
import type { ExecFn, SchedulerAdapter } from './types'

export interface AdapterFactoryOpts {
  schedmgrPath: string
  dbPath: string
  taskFolder?: string // Windows only; default handled by the adapter
}

/** Platform dispatch (spec §3.3). The adapter holds schedmgrPath/dbPath so adoptMany/adopt need no per-call paths. */
export function createAdapter(
  platform: NodeJS.Platform,
  exec: ExecFn,
  opts: AdapterFactoryOpts
): SchedulerAdapter {
  if (platform === 'win32') {
    return new TaskSchedulerAdapter({
      exec,
      schedmgrPath: opts.schedmgrPath,
      dbPath: opts.dbPath,
      taskFolder: opts.taskFolder
    })
  }
  return new CrontabAdapter({ exec, schedmgrPath: opts.schedmgrPath, dbPath: opts.dbPath })
}
