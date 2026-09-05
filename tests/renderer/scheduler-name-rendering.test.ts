// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AdoptDialog from '../../src/renderer/src/components/AdoptDialog.vue'
import TeardownDialog from '../../src/renderer/src/components/TeardownDialog.vue'

// no-hardcoded-scheduler-name.test.ts proves no literal scheduler name is left in any component.
// It cannot prove a component resolves the value and renders it — a file could import
// schedulerLabel, never call it, and still pass that scan. These mount the two dialogs that name
// the scheduler most prominently and read what a user would actually see.
function withPlatform(p: string, fn: () => void) {
  const w = globalThis as unknown as { window: { chronos?: { platform?: string } } }
  w.window.chronos = { platform: p }
  try {
    fn()
  } finally {
    delete w.window.chronos
  }
}

describe('dialogs name the host scheduler', () => {
  it('TeardownDialog: Task Scheduler on Windows, crontab elsewhere', () => {
    withPlatform('win32', () => {
      const t = mount(TeardownDialog, { props: { open: true, adoptedCount: 2, createdCount: 0 } }).text()
      expect(t).toContain('Task Scheduler')
      expect(t).not.toMatch(/crontab/i)
    })
    withPlatform('darwin', () => {
      const t = mount(TeardownDialog, { props: { open: true, adoptedCount: 2, createdCount: 0 } }).text()
      expect(t).toContain('crontab')
    })
  })

  it('AdoptDialog: Task Scheduler on Windows', () => {
    withPlatform('win32', () => {
      const t = mount(AdoptDialog, { props: { open: true, schedule: 'daily 03:00', command: 'x' } }).text()
      expect(t).toContain('Task Scheduler')
      expect(t).not.toMatch(/cron/i)
    })
  })
})
