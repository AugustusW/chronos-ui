<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
const props = defineProps<{ status: 'ok' | 'fail' | 'warn' | 'run'; label: string }>()
const ICON: Record<string, string> = { ok: '✓', fail: '✕', warn: '◷', run: '◔' }
</script>
<template>
  <span class="badge" :class="status">
    <span data-icon aria-hidden="true">{{ ICON[props.status] }}</span> {{ label }}
  </span>
</template>
<style scoped>
.badge{font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;display:inline-flex;gap:4px;align-items:center}
.ok{background:rgba(63,164,91,.16);color:var(--color-ok-text)}
.fail{background:rgba(192,73,63,.16);color:var(--color-danger-text)}
.warn{background:rgba(201,150,46,.16);color:var(--color-warn-text)}
.run{background:rgba(79,127,193,.16);color:var(--color-running-text)}
</style>
