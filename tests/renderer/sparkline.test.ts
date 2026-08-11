// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { buildSparklineModel, type SparklinePoint } from '../../src/renderer/src/lib/sparkline'

function pt(over: Partial<SparklinePoint> = {}): SparklinePoint {
  return { durationMs: 1000, result: 'success', startedAt: 0, ...over }
}

describe('buildSparklineModel', () => {
  it('empty input renders nothing', () => {
    expect(buildSparklineModel([])).toEqual({ path: '', markers: [], width: 120, height: 28 })
  })

  it('a single point is centered horizontally with no markers (not failed)', () => {
    const model = buildSparklineModel([pt()], 120, 28)
    expect(model.path).toBe('M60.0,0.0')
    expect(model.markers).toEqual([])
  })

  it('draws an M-then-L path with one segment per point, oldest (first) to newest (last)', () => {
    const points = [pt({ durationMs: 1000 }), pt({ durationMs: 2000 }), pt({ durationMs: 500 })]
    const model = buildSparklineModel(points, 100, 50)
    // 3 points → 2 equal steps of 50 apiece: x = 0, 50, 100
    expect(model.path).toMatch(/^M0\.0,\d+\.\d L50\.0,\d+\.\d L100\.0,\d+\.\d$/)
  })

  it('the tallest bar (max duration) touches y=0 (top); the DB min-value floor is y=height (bottom)', () => {
    const points = [pt({ durationMs: 0 }), pt({ durationMs: 1000 })]
    const model = buildSparklineModel(points, 100, 40)
    expect(model.path).toBe('M0.0,40.0 L100.0,0.0')
  })

  it('a failed/timeout point is pinned to the baseline (y=height) regardless of its durationMs, and produces a marker', () => {
    const points = [
      pt({ durationMs: 1000, result: 'success' }),
      pt({ durationMs: 999_999, result: 'timeout' }) // would dwarf everything else if plotted by value
    ]
    const model = buildSparklineModel(points, 100, 40)
    expect(model.path).toBe('M0.0,0.0 L100.0,40.0')
    expect(model.markers).toEqual([{ x: 100, y: 40, failed: true }])
  })

  it('a failure with durationMs=null does not crash and is pinned to the baseline', () => {
    const points = [pt({ durationMs: null, result: 'failure' })]
    const model = buildSparklineModel(points, 60, 20)
    expect(model.path).toBe('M30.0,20.0')
    expect(model.markers).toHaveLength(1)
  })

  it('all-zero/all-failed input never divides by zero (max floors at 1)', () => {
    const points = [pt({ durationMs: 0 }), pt({ durationMs: 0 })]
    const model = buildSparklineModel(points, 100, 40)
    expect(model.path).not.toContain('NaN')
    expect(model.path).not.toContain('Infinity')
  })

  it('successful points are plotted proportionally to the max SUCCESSFUL duration, not skewed by failures', () => {
    const points = [
      pt({ durationMs: 500, result: 'success' }),
      pt({ durationMs: 1000, result: 'success' }), // this is the max — should touch y=0
      pt({ durationMs: 50, result: 'timeout' }) // small value but pinned to baseline anyway
    ]
    const model = buildSparklineModel(points, 100, 40)
    const [p1, p2, p3] = model.path.split(' ')
    expect(p1).toBe('M0.0,20.0') // 500/1000 of the way up
    expect(p2).toBe('L50.0,0.0') // the max — top
    expect(p3).toBe('L100.0,40.0') // pinned baseline despite durationMs=50
  })
})
