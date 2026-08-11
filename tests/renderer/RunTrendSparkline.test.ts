// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RunTrendSparkline from '../../src/renderer/src/components/RunTrendSparkline.vue'
import type { RunDurationTrendPoint } from '../../src/shared/ipc-contract'

function pt(over: Partial<RunDurationTrendPoint> = {}): RunDurationTrendPoint {
  return { durationMs: 1000, result: 'success', startedAt: 0, ...over }
}

describe('RunTrendSparkline', () => {
  it('shows the empty state when there are no points', () => {
    const w = mount(RunTrendSparkline, { props: { points: [] } })
    expect(w.find('[data-test="trend-empty"]').exists()).toBe(true)
    expect(w.find('[data-test="trend-sparkline"]').exists()).toBe(false)
  })

  it('renders an svg path and the run count label when points exist', () => {
    const w = mount(RunTrendSparkline, { props: { points: [pt(), pt({ result: 'timeout' })] } })
    expect(w.find('[data-test="trend-sparkline"]').exists()).toBe(true)
    expect(w.find('path').exists()).toBe(true)
    expect(w.text()).toContain('last 2 runs')
    expect(w.text()).toContain('1 failed')
  })

  it('does not show a failed count when everything succeeded', () => {
    const w = mount(RunTrendSparkline, { props: { points: [pt(), pt()] } })
    expect(w.text()).not.toContain('failed')
  })

  it('renders one marker per failed/timeout point', () => {
    const w = mount(RunTrendSparkline, {
      props: { points: [pt(), pt({ result: 'failure' }), pt({ result: 'timeout' })] }
    })
    expect(w.findAll('[data-test="trend-fail-marker"]')).toHaveLength(2)
  })
})
