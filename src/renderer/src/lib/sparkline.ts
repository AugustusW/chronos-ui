// SPDX-License-Identifier: Apache-2.0
// Pure SVG polyline math for JobDetailView's run-duration trend (v0.4.0). No chart library — the
// repo has none, and a handful of points at sparkline size doesn't need one.

export interface SparklinePoint {
  durationMs: number | null
  result: 'success' | 'failure' | 'timeout'
  startedAt: number
}

export interface SparklineMarker {
  x: number
  y: number
  failed: boolean
}

export interface SparklineModel {
  path: string
  markers: SparklineMarker[]
  width: number
  height: number
}

/**
 * Builds an SVG polyline path + per-point markers from a job's run-duration history.
 *
 * `points` must already be oldest-first (chronological, left→right) — the repository query
 * (listRunDurationTrend) returns most-recent-first for consistency with its siblings, so the
 * caller reverses before calling this; keeping that reversal outside this function means it stays
 * a pure presentation transform with no implicit reordering.
 *
 * Failed/timeout runs are pinned to the baseline (y = height, i.e. drawn as a dip) rather than
 * plotted by their actual durationMs: a timeout's duration sits at the timeout ceiling (often much
 * larger than a normal run) and would either flatten the rest of the line to near-zero or spike
 * wildly depending on scale. Pinning + a separate `failed` marker keeps the line's shape legible for
 * the successful runs while still surfacing exactly when a failure happened.
 */
export function buildSparklineModel(points: SparklinePoint[], width = 120, height = 28): SparklineModel {
  if (points.length === 0) return { path: '', markers: [], width, height }

  const valueOf = (p: SparklinePoint): number => (p.result === 'success' ? (p.durationMs ?? 0) : 0)
  const max = Math.max(...points.map(valueOf), 1) // avoid /0 when every run is 0ms or failed
  const stepX = points.length > 1 ? width / (points.length - 1) : 0

  const coords = points.map((p, i) => ({
    x: points.length > 1 ? i * stepX : width / 2,
    y: height - (valueOf(p) / max) * height,
    failed: p.result !== 'success'
  }))

  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
  const markers = coords.filter((c) => c.failed)
  return { path, markers, width, height }
}
