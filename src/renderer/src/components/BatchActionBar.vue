<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
const props = defineProps<{ count: number; running?: { done: number; total: number } }>()
const emit = defineEmits<{ run: []; enable: []; disable: []; delete: []; clear: []; cancel: [] }>()
function confirmDelete(): void { if (window.confirm(`Delete ${props.count} job(s)? This cannot be undone.`)) emit('delete') }
</script>
<template>
  <div class="batch">
    <template v-if="running">
      <span class="spin" /><b>Running batch · {{ running.done }} of {{ running.total }} done</b>
      <div class="pbar"><div class="pfill" :style="{ width: (running.done / running.total * 100) + '%' }" /></div>
      <span class="grow" /><span class="live">live — no refresh needed</span>
      <button class="b" type="button" @click="emit('cancel')">■ Cancel remaining</button>
    </template>
    <template v-else>
      <b>{{ count }} selected</b><span class="vl" />
      <button class="b" data-act="run" type="button" @click="emit('run')">▶ Run</button>
      <button class="b" type="button" @click="emit('enable')">Enable</button>
      <button class="b" type="button" @click="emit('disable')">Disable</button>
      <button class="b danger" data-act="delete" type="button" @click="confirmDelete">🗑 Delete</button>
      <span class="grow" /><button class="b" type="button" @click="emit('clear')">✕ Clear</button>
    </template>
  </div>
</template>
<style scoped>
.batch{display:flex;align-items:center;gap:10px;padding:8px var(--p-space-3);background:rgba(var(--color-primary-rgb),.12);border:1px solid var(--color-primary);border-radius:var(--p-radius);margin-bottom:8px;font-size:12.5px}
b{color:var(--color-primary)}.grow{flex:1}.vl{width:1px;height:18px;background:var(--color-border)}
.b{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--p-radius);padding:5px 9px;font-size:11.5px;cursor:pointer}
.b.danger{color:var(--color-danger-text);border-color:var(--color-danger)} /* ghost-danger, not color-only (design-director MED-2) */
.live{color:var(--color-text-muted);font-size:11.5px}
.pbar{flex:0 0 140px;height:6px;border-radius:6px;background:rgba(var(--color-primary-rgb),.18);overflow:hidden}.pfill{height:100%;background:var(--color-primary)}
.spin{width:12px;height:12px;border:2px solid rgba(var(--color-primary-rgb),.35);border-top-color:var(--color-primary);border-radius:50%;animation:sp .8s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
