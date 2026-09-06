// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// The list is the only place a user ever sees what a change actually was, so the assertions here
// are about the two things that make it useful: both sides of every changed field, and a revert
// offered only where reverting is a field edit (adopt/un-adopt is undone by adopt/un-adopt).
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import JobRevisionList from '../../src/renderer/src/components/JobRevisionList.vue'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rev = (over: any = {}): any => ({
  id: 1,
  jobId: 1,
  changedAt: new Date('2026-09-06T04:00:00Z'),
  source: 'edit',
  changedFields: ['command'],
  before: { command: '/usr/bin/a.sh' },
  after: { command: '/usr/bin/b.sh' },
  ...over
})

describe('JobRevisionList', () => {
  it('renders both sides of a changed field', () => {
    const w = mount(JobRevisionList, { props: { revisions: [rev()] } })
    expect(w.text()).toContain('/usr/bin/a.sh')
    expect(w.text()).toContain('/usr/bin/b.sh')
  })

  it('names fields and sources in plain words, not internal identifiers', () => {
    const w = mount(JobRevisionList, {
      props: { revisions: [rev({ source: 'external', changedFields: ['scheduleExpr'], before: { scheduleExpr: '0 3 * * *' }, after: { scheduleExpr: '*/5 * * * *' } })] }
    })
    const text = w.text()
    expect(text).toContain('schedule')
    expect(text).not.toContain('scheduleExpr')
    expect(text).toContain('changed outside ChronosUI')
    expect(text).not.toContain('external')
  })

  it('renders every changed field of a multi-field change', () => {
    const w = mount(JobRevisionList, {
      props: {
        revisions: [
          rev({
            changedFields: ['scheduleExpr', 'enabled'],
            before: { scheduleExpr: '0 3 * * *', enabled: true },
            after: { scheduleExpr: '@daily', enabled: false }
          })
        ]
      }
    })
    expect(w.findAll('[data-test="revision-field"]')).toHaveLength(2)
  })

  it('shows a readable placeholder rather than a blank for an unset value', () => {
    const w = mount(JobRevisionList, {
      props: { revisions: [rev({ changedFields: ['workingDir'], before: { workingDir: null }, after: { workingDir: '/srv' } })] }
    })
    expect(w.text()).toContain('not set')
  })

  it('offers revert for an edit', () => {
    const w = mount(JobRevisionList, { props: { revisions: [rev({ id: 1 })] } })
    expect(w.findAll('[data-test="revert"]')).toHaveLength(1)
    expect(w.findAll('[data-test="restore"]')).toHaveLength(0)
  })

  // An external change leaves the DB holding the OLD values, so "re-apply the old values" is a
  // no-op the update path skips entirely — it would report success while the foreign entry kept
  // running. The external case must therefore offer the opposite direction, not Revert.
  it('offers restore — not revert — for a change made outside the app', () => {
    const w = mount(JobRevisionList, { props: { revisions: [rev({ id: 2, source: 'external' })] } })
    expect(w.findAll('[data-test="revert"]')).toHaveLength(0)
    const restore = w.findAll('[data-test="restore"]')
    expect(restore).toHaveLength(1)
    expect(restore[0].text()).toContain('Restore in scheduler')
  })

  it('offers restore on the newest external change only — it restores the job, not one revision', () => {
    const w = mount(JobRevisionList, {
      props: { revisions: [rev({ id: 9, source: 'external' }), rev({ id: 8, source: 'external' }), rev({ id: 7 })] }
    })
    const restore = w.findAll('[data-test="restore"]')
    expect(restore).toHaveLength(1)
    expect(w.find('[data-revision-id="9"]').find('[data-test="restore"]').exists()).toBe(true)
    expect(w.find('[data-revision-id="8"]').find('[data-test="restore"]').exists()).toBe(false)
  })

  it('offers no restore once the change has been put back', () => {
    // A `resolved` newer than the external means the scheduler already agrees; the button would be
    // a no-op reporting "Restored in the scheduler".
    const w = mount(JobRevisionList, {
      props: {
        revisions: [
          rev({ id: 10, source: 'resolved', before: { command: '/usr/bin/b.sh' }, after: { command: '/usr/bin/a.sh' } }),
          rev({ id: 9, source: 'external' })
        ]
      }
    })
    expect(w.findAll('[data-test="restore"]')).toHaveLength(0)
    expect(w.text()).toContain('put back')
  })

  it('emits restore with the revision', async () => {
    const w = mount(JobRevisionList, { props: { revisions: [rev({ id: 2, source: 'external' })] } })
    await w.find('[data-test="restore"]').trigger('click')
    expect(w.emitted('restore')?.[0]?.[0]).toMatchObject({ id: 2 })
  })

  it('distinguishes an empty string from an unset value', () => {
    const w = mount(JobRevisionList, {
      props: { revisions: [rev({ changedFields: ['category'], before: { category: null }, after: { category: '' } })] }
    })
    expect(w.text()).toContain('(not set)')
    expect(w.text()).toContain('(empty)')
  })

  it('offers neither action for adopt or un-adopt — those are undone by adopting again', () => {
    const w = mount(JobRevisionList, {
      props: {
        revisions: [
          rev({ id: 1, source: 'adopt', changedFields: ['adopted'], before: { adopted: false }, after: { adopted: true } }),
          rev({ id: 2, source: 'unadopt', changedFields: ['adopted'], before: { adopted: true }, after: { adopted: false } })
        ]
      }
    })
    expect(w.findAll('[data-test="revert"]')).toHaveLength(0)
    expect(w.findAll('[data-test="restore"]')).toHaveLength(0)
    expect(w.text()).toContain('adopted')
  })

  it('emits revert with the revision so the caller can apply its before values', async () => {
    const w = mount(JobRevisionList, { props: { revisions: [rev()] } })
    await w.find('[data-test="revert"]').trigger('click')
    expect(w.emitted('revert')?.[0]?.[0]).toMatchObject({ id: 1 })
  })

  it('renders an empty state when there is no history', () => {
    const w = mount(JobRevisionList, { props: { revisions: [] } })
    expect(w.text()).toContain('No configuration changes recorded')
  })

  it('uses no emoji in its copy', () => {
    const w = mount(JobRevisionList, { props: { revisions: [rev({ source: 'external' })] } })
    expect(w.text()).not.toMatch(/\p{Extended_Pictographic}/u)
  })
})
