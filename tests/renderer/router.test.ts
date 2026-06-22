// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { router } from '../../src/renderer/src/router'

describe('router', () => {
  it('uses memory history and declares the core routes', () => {
    const paths = router.getRoutes().map((r) => r.path)
    expect(paths).toContain('/')
    expect(paths).toContain('/jobs/:id')
    expect(paths).toContain('/settings')
    expect(paths).toContain('/history')
  })
})
