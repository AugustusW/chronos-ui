// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { router } from '../../src/renderer/src/router'

describe('router', () => {
  it('uses memory history and declares the core routes', () => {
    const paths = router.getRoutes().map((r) => r.path)
    expect(paths).toContain('/')
    expect(paths).toContain('/schedules')
    expect(paths).toContain('/jobs/:id')
    expect(paths).toContain('/settings')
    expect(paths).toContain('/history')
  })

  it('serves the dashboard at / and schedules at /schedules', () => {
    const routes = router.getRoutes()
    const root = routes.find((r) => r.path === '/')
    const schedules = routes.find((r) => r.path === '/schedules')
    expect(root?.name).toBe('dashboard')
    expect(schedules?.name).toBe('schedules')
  })
})
