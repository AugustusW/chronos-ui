// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from 'vitest'
import { IPC } from '../src/shared/ipc-contract'
import type { JobListItem, ReconcileResult, CreateJobInput, RunNowResult, RunEvent, PgStatus } from '../src/shared/ipc-contract'

describe('IPC contract', () => {
  it('declares every Plan 5 channel with a stable string name', () => {
    expect(IPC.jobsList).toBe('jobs:list')
    expect(IPC.jobsCreate).toBe('jobs:create')
    expect(IPC.jobsAdopt).toBe('jobs:adopt')
    expect(IPC.jobsRunNow).toBe('jobs:runNow')
    expect(IPC.runsListForJob).toBe('runs:listForJob')
  })
  it('ReconcileResult is a tagged list', () => {
    expectTypeOf<ReconcileResult>().toMatchTypeOf<{ items: JobListItem[]; generatedAt: number }>()
  })
  it('CreateJobInput is renderer-shaped (no id/source/platform — service derives those)', () => {
    expectTypeOf<CreateJobInput>().toMatchTypeOf<{ name: string; scheduleExpr: string; command: string }>()
  })
  it('RunNowResult discriminates completed vs ui_timeout', () => {
    const a: RunNowResult = { status: 'ui_timeout', jobId: 1, waitedMs: 60000 }
    expect(a.status).toBe('ui_timeout')
  })
})

describe('Plan 6 IPC additions', () => {
  it('declares the run-event channel + batch cancel', () => {
    expect(IPC.runEvent).toBe('run:event')
    expect(IPC.jobsRunBatchCancel).toBe('jobs:runBatchCancel')
    expect(IPC.jobsRunNowStreaming).toBe('jobs:runNowStreaming')
  })
  it('RunEvent is a tagged union', () => {
    const e: RunEvent = { kind: 'output', runId: 1, stream: 'stdout', chunk: 'x' }
    expect(e.kind).toBe('output')
  })
})

describe('Plan 6 FU5 IPC additions', () => {
  it('declares the runsRecent channel', () => {
    expect(IPC.runsRecent).toBe('runs:recent')
  })
})

describe('Bolt 3 pg settings IPC channels (T13)', () => {
  it('declares the pg test-connection and save-switch channels', () => {
    expect(IPC.pgTestConnection).toBe('pg:testConnection')
    expect(IPC.pgSaveSwitch).toBe('pg:saveSwitch')
  })
})

describe('Bolt 4 pg status IPC channel (T15)', () => {
  it('declares the pg get-status channel', () => {
    expect(IPC.pgGetStatus).toBe('pg:getStatus')
  })
  it('PgStatus carries the active backend + keychain availability', () => {
    const s: PgStatus = { activeBackend: 'postgres', keychainAvailable: false }
    expect(s.activeBackend).toBe('postgres')
  })
})

describe('Dashboard IPC channel (Task 5)', () => {
  it('declares the dashboard summary channel', () => {
    expect(IPC.dashboardSummary).toBe('dashboard:summary')
  })
})
