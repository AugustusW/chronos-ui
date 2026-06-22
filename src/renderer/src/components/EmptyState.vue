<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
const emit = defineEmits<{ scan: []; new: [] }>()
</script>
<template>
  <div class="empty">
    <svg class="bigdial" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-linecap="round">
      <circle cx="50" cy="50" r="39" stroke-width="2.2" opacity=".5" />
      <line x1="50" y1="11" x2="50" y2="21" stroke-width="3.2" /><line x1="89" y1="50" x2="79" y2="50" stroke-width="3.2" />
      <line x1="50" y1="89" x2="50" y2="79" stroke-width="3.2" /><line x1="11" y1="50" x2="21" y2="50" stroke-width="3.2" />
      <line x1="50" y1="50" x2="73.4" y2="36.5" stroke-width="3" /><line x1="50" y1="50" x2="36.1" y2="40.3" stroke-width="3.6" />
      <circle cx="50" cy="50" r="3.4" fill="currentColor" stroke="none" />
    </svg>
    <h1>Bring order to your schedules</h1>
    <p>ChronosUI reads the jobs already in your <b>native scheduler</b> — your crontab. Nothing is moved or migrated.</p>
    <div class="cta">
      <button class="btn primary" type="button" @click="emit('scan')">⟳ Scan crontab</button>
      <button class="btn" type="button" @click="emit('new')">＋ New job</button>
    </div>
  </div>
</template>
<style scoped>
.empty{max-width:460px;margin:auto;text-align:center;padding:40px}
.bigdial{width:104px;height:104px;color:var(--color-primary);opacity:.92;margin-bottom:var(--p-space-4)}
h1{font-size:22px;margin:0 0 8px}p{color:var(--color-text-muted);font-size:13px;line-height:1.6;margin:0 auto var(--p-space-4);max-width:400px}
.cta{display:flex;gap:10px;justify-content:center}
.btn{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--p-radius);padding:9px 18px;font-size:13px;cursor:pointer}
.btn.primary{background:var(--color-primary);color:var(--color-on-primary);border-color:transparent;font-weight:500}
</style>
