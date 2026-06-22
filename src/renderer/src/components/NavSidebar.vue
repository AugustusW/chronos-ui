<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import ThemeToggle from './ThemeToggle.vue'
const items = [
  { to: '/', icon: '▤', label: 'Schedules' },
  { to: '/history', icon: '≡', label: 'Run History' },
  { to: '/settings', icon: '⚙', label: 'Settings' }
]
const version = ref('')
onMounted(async () => {
  if (typeof window !== 'undefined' && window.chronos) {
    version.value = (await window.chronos.getVersion()).version
  }
})
</script>
<template>
  <aside class="nav">
    <div class="brand">
      <span class="tile"><svg class="dial" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-linecap="round">
        <circle cx="50" cy="50" r="39" stroke-width="2.2" opacity=".5" />
        <line x1="50" y1="11" x2="50" y2="21" stroke-width="3.2" /><line x1="89" y1="50" x2="79" y2="50" stroke-width="3.2" />
        <line x1="50" y1="89" x2="50" y2="79" stroke-width="3.2" /><line x1="11" y1="50" x2="21" y2="50" stroke-width="3.2" />
        <line x1="50" y1="50" x2="73.4" y2="36.5" stroke-width="3" /><line x1="50" y1="50" x2="36.1" y2="40.3" stroke-width="3.6" />
        <circle cx="50" cy="50" r="3.4" fill="currentColor" stroke="none" />
      </svg></span>
      <div>ChronosUI<small>Bring Order to Time</small></div>
    </div>
    <div class="sec">Manage</div>
    <RouterLink v-for="it in items" :key="it.to" :to="it.to" class="item" active-class="active">
      <span class="ic">{{ it.icon }}</span> {{ it.label }}
    </RouterLink>
    <div class="spacer" />
    <div class="foot"><span>v{{ version }}</span><ThemeToggle /></div>
  </aside>
</template>
<style scoped>
.nav{width:212px;flex:0 0 212px;background:var(--nav-bg);color:var(--nav-text);display:flex;flex-direction:column;padding:var(--p-space-4) 0;border-right:1px solid var(--nav-border);height:100%}
.brand{display:flex;align-items:center;gap:10px;padding:0 var(--p-space-4) var(--p-space-4);font-weight:600}
.tile{width:30px;height:30px;border-radius:7px;background:linear-gradient(160deg,#23232c,#0b0b0f);display:grid;place-items:center}
.dial{width:22px;height:22px;color:#7299cd}
.brand small{display:block;font-weight:400;font-size:11px;color:var(--nav-muted)}
.sec{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--nav-muted);padding:var(--p-space-3) var(--p-space-4) var(--p-space-1)}
.item{display:flex;align-items:center;gap:10px;padding:8px var(--p-space-4);color:var(--nav-text);text-decoration:none;border-left:2px solid transparent}
.item.active{background:var(--nav-active-bg);color:var(--nav-active-text);border-left-color:var(--color-primary);font-weight:500}
.ic{width:16px;text-align:center;opacity:.7}
.spacer{flex:1}
.foot{padding:var(--p-space-3) var(--p-space-4) 0;border-top:1px solid var(--nav-border);margin-top:var(--p-space-3);display:flex;align-items:center;justify-content:space-between;color:var(--nav-muted);font-size:11px}
</style>
