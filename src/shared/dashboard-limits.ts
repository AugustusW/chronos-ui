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
