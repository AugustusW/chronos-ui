<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ref, computed } from 'vue'
const props = defineProps<{ stdout: string; stderr: string; live?: boolean }>()
const tab = ref<'stdout' | 'stderr'>('stdout')
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][\s\S]*?(?:\x07|\x1b\\)/g
const text = computed(() => (tab.value === 'stdout' ? props.stdout : props.stderr).replace(ANSI, ''))
</script>
<template>
  <div class="out">
    <div class="bar">
      <button class="tab" :class="{ on: tab === 'stdout' }" type="button" @click="tab = 'stdout'">stdout</button>
      <button class="tab" :class="{ on: tab === 'stderr' }" type="button" @click="tab = 'stderr'">stderr</button>
      <span v-if="live" class="live">● streaming</span>
    </div>
    <pre class="term" :class="{ err: tab === 'stderr' }">{{ text }}</pre>
  </div>
</template>
<style scoped>
.out{flex:1;display:flex;flex-direction:column;min-width:0}
.bar{display:flex;gap:8px;padding:8px var(--p-space-3);border-bottom:1px solid var(--color-border)}
.tab{font-size:12px;padding:4px 10px;border:0;background:none;color:var(--color-text-muted);cursor:pointer;border-radius:var(--p-radius)}
.tab.on{background:rgba(var(--color-primary-rgb),.12);color:var(--color-primary);font-weight:600}
.live{margin-left:auto;color:var(--color-primary);font-size:11px}
.term{flex:1;overflow:auto;margin:0;background:var(--color-code-bg);font-family:var(--p-font-mono);font-size:12px;line-height:1.55;padding:var(--p-space-3) var(--p-space-4);white-space:pre-wrap;word-wrap:break-word}
.term.err{color:var(--color-stderr-text)}
</style>
