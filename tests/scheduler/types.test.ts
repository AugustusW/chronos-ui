// SPDX-License-Identifier: Apache-2.0
import { describe, it, expectTypeOf } from 'vitest'
import type { AdoptionSpec, BatchWriteResult, WriteResult, KnownErrorCode } from '../../src/main/scheduler/types'

describe('scheduler batch types', () => {
  it('AdoptionSpec carries chronosId + schedule + command', () => {
    expectTypeOf<AdoptionSpec>().toMatchTypeOf<{ chronosId: number; scheduleExpr: string; command: string }>()
  })
  it('BatchWriteResult reports which ids were adopted', () => {
    expectTypeOf<BatchWriteResult>().toMatchTypeOf<{ ok: boolean; adopted: number[] }>()
  })
  it('WriteResult gains an optional discriminant errorCode', () => {
    const e: KnownErrorCode = 'not_found'
    expectTypeOf<WriteResult['errorCode']>().toEqualTypeOf<KnownErrorCode | undefined>()
    void e
  })
})
