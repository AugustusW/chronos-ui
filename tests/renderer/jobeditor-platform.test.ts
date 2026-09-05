// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import JobEditor from '../../src/renderer/src/components/JobEditor.vue'

// The defect: the field was labelled "Schedule (cron)" and previewed as cron on every platform,
// but the Windows adapter accepts only descriptors (daily HH:MM, hourly N, …). A Windows user
// followed the label, and got back `trigger: unknown kind 0` — the first field of their own cron
// expression, echoed as though it were a typo.
function setPlatform(p: string) {
  ;(globalThis as unknown as { window: { chronos?: { platform?: string } } }).window.chronos = { platform: p }
}

describe('JobEditor schedule field follows the host scheduler', () => {
  afterEach(() => {
    delete (globalThis as unknown as { window: { chronos?: unknown } }).window.chronos
  })

  describe('on Windows', () => {
    beforeEach(() => setPlatform('win32'))

    it('asks for a Task Scheduler descriptor, not cron', async () => {
      const w = mount(JobEditor, { props: { open: true } })
      const label = w.find('[data-schedule-label]').text()
      expect(label).not.toMatch(/cron/i)
      expect(label).toMatch(/task scheduler/i)
      expect(w.find('[data-f="schedule"]').attributes('placeholder')).toBe('daily 03:00')
      // The cron preview is meaningless here and previously rendered regardless.
      expect(w.find('[data-cron-preview]').exists()).toBe(false)
    })

    it('refuses to submit a cron expression, and says why in the field', async () => {
      const w = mount(JobEditor, { props: { open: true } })
      await w.find('[data-f="name"]').setValue('Backup')
      await w.find('[data-f="schedule"]').setValue('0 3 * * *')
      await w.find('[data-f="command"]').setValue('C:\\b.bat')
      await w.find('[data-save]').trigger('click')

      expect(w.emitted('save')).toBeUndefined() // never reaches IPC
      expect(w.find('[data-schedule-error]').text()).toMatch(/cron/i)
    })

    it('previews a valid descriptor in plain language and submits it', async () => {
      const w = mount(JobEditor, { props: { open: true } })
      await w.find('[data-f="name"]').setValue('Backup')
      await w.find('[data-f="schedule"]').setValue('weekly MON,FRI 07:30')
      await w.find('[data-f="command"]').setValue('C:\\b.bat')
      expect(w.find('[data-trigger-preview]').text()).toBe('Every Monday and Friday at 07:30')

      await w.find('[data-save]').trigger('click')
      expect(w.emitted('save')![0][0]).toMatchObject({ scheduleExpr: 'weekly MON,FRI 07:30' })
    })

    it('names Task Scheduler, not crontab, when un-adopting', async () => {
      const seen: string[] = []
      window.confirm = (m?: string) => {
        seen.push(m ?? '')
        return false
      }
      const w = mount(JobEditor, { props: { open: true, initial: { name: 'x' }, adopted: true } })
      await w.find('[data-unadopt]').trigger('click')
      expect(seen[0]).toMatch(/Task Scheduler/)
      expect(seen[0]).not.toMatch(/crontab/)
    })
  })

  describe('on macOS and Linux', () => {
    beforeEach(() => setPlatform('darwin'))

    it('still asks for cron, previews cron, and submits a cron expression', async () => {
      const w = mount(JobEditor, { props: { open: true } })
      expect(w.find('[data-schedule-label]').text()).toMatch(/cron/i)
      expect(w.find('[data-cron-preview]').exists()).toBe(true)

      await w.find('[data-f="name"]').setValue('Backup')
      await w.find('[data-f="schedule"]').setValue('0 3 * * *')
      await w.find('[data-f="command"]').setValue('/b.sh')
      await w.find('[data-save]').trigger('click')
      expect(w.emitted('save')![0][0]).toMatchObject({ scheduleExpr: '0 3 * * *' })
    })
  })
})
