// SPDX-License-Identifier: Apache-2.0
// Shared by main/services/dashboard.service.ts and renderer/src/views/DashboardView.vue. Lives in
// src/shared (not src/main) so the renderer can import the constants without pulling any main
// process module — and its dependencies (e.g. croner) — into the renderer bundle.
export const DASHBOARD_FAILURES_LIMIT = 20
export const DASHBOARD_UPCOMING_LIMIT = 20
