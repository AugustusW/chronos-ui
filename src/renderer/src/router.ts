// SPDX-License-Identifier: Apache-2.0
import { createRouter, createMemoryHistory } from 'vue-router'
import SchedulesView from './views/SchedulesView.vue'
import JobDetailView from './views/JobDetailView.vue'
import SettingsView from './views/SettingsView.vue'

const routes = [
  { path: '/', name: 'schedules', component: SchedulesView },
  { path: '/jobs/:id', name: 'job-detail', component: JobDetailView, props: true },
  { path: '/settings', name: 'settings', component: SettingsView },
  { path: '/history', name: 'history', component: () => import('./views/RunHistoryView.vue') },
  ...(import.meta.env.DEV
    ? [{ path: '/design-system', name: 'design-system', component: () => import('./views/DesignSystemView.vue') }]
    : [])
]

export const router = createRouter({ history: createMemoryHistory(), routes })
