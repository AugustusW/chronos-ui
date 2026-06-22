// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { createAdapter } from '../../src/main/scheduler/factory'
import { CrontabAdapter, TaskSchedulerAdapter, type ExecFn } from '../../src/main/scheduler'

const exec: ExecFn = async () => ({ stdout: '', exitCode: 0 })
const opts = { schedmgrPath: '/x/schedmgr', dbPath: '/x/chronos.db' }

describe('createAdapter', () => {
  it('returns the Task Scheduler adapter on win32', () => {
    expect(createAdapter('win32', exec, opts)).toBeInstanceOf(TaskSchedulerAdapter)
  })
  it('returns the crontab adapter on darwin and linux', () => {
    expect(createAdapter('darwin', exec, opts)).toBeInstanceOf(CrontabAdapter)
    expect(createAdapter('linux', exec, opts)).toBeInstanceOf(CrontabAdapter)
  })
})
