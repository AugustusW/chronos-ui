// SPDX-License-Identifier: Apache-2.0
// Shared by main/services/dashboard.service.ts and renderer/src/views/DashboardView.vue. Lives in
// src/shared (not src/main) so the renderer can import the constants without pulling any main
// process module — and its dependencies (e.g. croner) — into the renderer bundle.
export const DASHBOARD_FAILURES_LIMIT = 20
export const DASHBOARD_UPCOMING_LIMIT = 20

// Tray menu (main-process only, v0.4.0): a much tighter slice of the already-fetched
// DashboardSummary.failures — the menu bar has room for a handful of rows, not the full
// DASHBOARD_FAILURES_LIMIT list. No separate DB query: the tray takes the first N of the same
// `failures` array the dashboard view already gets from dashboard.service.ts.
export const TRAY_RECENT_FAILURES_LIMIT = 5

// Job run-duration trend sparkline (JobDetailView.vue, backed by its own jobs:runDurationTrend
// channel — architect LOW-2's "a future trend-chart endpoint gets its own channel", not folded
// into dashboard:summary or runs:search). ~20 points is enough to see a shape at sparkline size
// without the query/response growing unbounded for a job with years of history.
export const JOB_TREND_LIMIT = 20

// Run History search (RunHistoryView.vue's runs:search channel): default page size, and the
// "load more" step size — deliberately the SAME constant so each load-more click requests exactly
// one more page's worth rather than an arbitrary increment.
export const RUN_SEARCH_PAGE_SIZE = 50
