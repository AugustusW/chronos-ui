// SPDX-License-Identifier: Apache-2.0
import { createApp } from 'vue'
import App from './App.vue'
import './assets/base.css'
import { applyTheme, getStoredTheme } from './lib/theme'
import { router } from './router'
import { startRunEventBridge } from './ipc/events'
import { useScheduleStore } from './stores/schedule.store'

applyTheme(getStoredTheme())
createApp(App).use(router).mount('#app')
startRunEventBridge(useScheduleStore())
