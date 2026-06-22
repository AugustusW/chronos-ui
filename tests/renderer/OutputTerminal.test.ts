// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import OutputTerminal from '../../src/renderer/src/components/OutputTerminal.vue'

describe('OutputTerminal', () => {
  it('strips SGR ANSI escape sequences (spec §9.4)', () => {
    const w = mount(OutputTerminal, { props: { stdout: '\x1b[31mred\x1b[0m done', stderr: '' } })
    expect(w.text()).toContain('red done')
    expect(w.text()).not.toContain('\x1b')
  })

  it('strips cursor/erase CSI sequences (FU4)', () => {
    const w = mount(OutputTerminal, { props: { stdout: '\x1b[2J\x1b[1;1Hcleared\x1b[K', stderr: '' } })
    expect(w.text()).toContain('cleared')
    expect(w.text()).not.toContain('\x1b')
    expect(w.text()).not.toContain('[2J')
    expect(w.text()).not.toContain('[1;1H')
    expect(w.text()).not.toContain('[K')
  })

  it('strips OSC title sequences terminated by BEL (FU4)', () => {
    const w = mount(OutputTerminal, { props: { stdout: '\x1b]0;my-title\x07hello', stderr: '' } })
    expect(w.text()).toContain('hello')
    expect(w.text()).not.toContain('my-title')
    expect(w.text()).not.toContain('\x1b')
  })

  it('strips OSC title sequences terminated by ST (FU4)', () => {
    const w = mount(OutputTerminal, { props: { stdout: '\x1b]0;my-title\x1b\\hello', stderr: '' } })
    expect(w.text()).toContain('hello')
    expect(w.text()).not.toContain('my-title')
    expect(w.text()).not.toContain('\x1b')
  })

  it('SGR plain text still works — regression (FU4)', () => {
    const w = mount(OutputTerminal, { props: { stdout: '\x1b[32mok\x1b[0m', stderr: '' } })
    expect(w.text()).toContain('ok')
    expect(w.text()).not.toContain('\x1b')
  })
})
