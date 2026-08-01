// SPDX-License-Identifier: Apache-2.0
import { createApp } from 'vue'
import App from './App.vue'
import './assets/base.css'
import { applyTheme, getStoredTheme } from './lib/theme'
import { router } from './router'
import { startRunEventBridge } from './ipc/events'
import { useScheduleStore } from './stores/schedule.store'
import { useDashboardStore } from './stores/dashboard.store'

applyTheme(getStoredTheme())
createApp(App).use(router).mount('#app')

// Single subscription point (architect HIGH-1/HIGH-2): fan out to every store that reacts to run
// events here, rather than each store/view calling window.chronos.onRunEvent itself.
const scheduleStore = useScheduleStore()
const dashboardStore = useDashboardStore()
startRunEventBridge({
  applyRunEvent: (e) => {
    scheduleStore.applyRunEvent(e)
    dashboardStore.applyRunEvent(e)
  }
})
