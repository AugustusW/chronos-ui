<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
defineProps<{ categories: string[]; active: string; counts: Record<string, number> }>()
const emit = defineEmits<{ change: [c: string] }>()
</script>
<template>
  <div class="cats">
    <span class="lbl">Category</span>
    <button class="cat" :class="{ on: active === 'All' }" type="button" @click="emit('change', 'All')">All <span class="n">{{ counts.All ?? 0 }}</span></button>
    <button v-for="c in categories" :key="c" class="cat" :class="{ on: active === c }" type="button" @click="emit('change', c)">{{ c }} <span class="n">{{ counts[c] ?? 0 }}</span></button>
  </div>
</template>
<style scoped>
.cats{display:flex;align-items:center;gap:7px;padding:9px var(--p-space-4);border-bottom:1px solid var(--color-border);background:var(--color-bg);flex-wrap:wrap}
.lbl{font-size:11px;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.05em}
.cat{font-size:12px;padding:4px 11px;border-radius:20px;border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text-muted);cursor:pointer}
.cat.on{background:var(--color-primary);color:var(--color-on-primary);border-color:transparent;font-weight:500}
.n{font-size:10px;opacity:.7}
</style>
