// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { resolveSchedmgrPath } from '../../src/main/scheduler/schedmgr-path'
import { sep } from 'node:path'

// The impl uses path.join (\ on Windows), so normalize the result to / for platform-agnostic assertions.
const norm = (p: string): string => p.split(sep).join('/')

describe('resolveSchedmgrPath', () => {
  it('dev: points at the locally built binary in the schedmgr dir', () => {
    expect(
      norm(
        resolveSchedmgrPath({
          isPackaged: false,
          platform: 'darwin',
          appRoot: '/proj/chronos-ui',
          resourcesPath: '/x'
        })
      )
    ).toBe('/proj/chronos-ui/schedmgr/schedmgr')
  })
  it('dev on win32: appends .exe', () => {
    expect(
      norm(
        resolveSchedmgrPath({
          isPackaged: false,
          platform: 'win32',
          appRoot: 'C:/proj',
          resourcesPath: '/x'
        })
      )
    ).toBe('C:/proj/schedmgr/schedmgr.exe')
  })
  it('prod: resolves under resourcesPath (Plan 7 finalizes packaging)', () => {
    expect(
      norm(
        resolveSchedmgrPath({
          isPackaged: true,
          platform: 'darwin',
          appRoot: '/x',
          resourcesPath: '/app/Contents/Resources'
        })
      )
    ).toBe('/app/Contents/Resources/schedmgr/schedmgr')
  })
})
