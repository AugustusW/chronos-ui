<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { ImportPreview } from '../../../shared/ipc-contract'

const props = defineProps<{ open: boolean; preview: ImportPreview | null; applying: boolean }>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()

const newCount = computed(() => props.preview?.entries.filter((e) => e.kind === 'new').length ?? 0)
const changedCount = computed(() => props.preview?.entries.filter((e) => e.kind === 'changed').length ?? 0)
const unchangedCount = computed(() => props.preview?.entries.filter((e) => e.kind === 'unchanged').length ?? 0)
const applyCount = computed(() => newCount.value + changedCount.value)
</script>
<template>
  <div v-if="open && preview" class="overlay" @keydown.escape="emit('cancel')">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
      <header><h2 id="import-dialog-title">Import from {{ preview.fileName }}</h2></header>
      <div class="body">
        <p class="summary">
          <span v-if="newCount" class="tag new" data-test="count-new">{{ newCount }} new</span>
          <span v-if="changedCount" class="tag changed" data-test="count-changed">{{ changedCount }} changed</span>
          <span v-if="unchangedCount" class="tag unchanged" data-test="count-unchanged">{{ unchangedCount }} unchanged</span>
        </p>
        <div v-if="preview.entries.length === 0" class="empty">No jobs in this file.</div>
        <div v-else class="rows" data-test="diff-rows">
          <div v-for="(d, i) in preview.entries" :key="i" class="row" :class="d.kind" data-test="diff-row">
            <span class="kind-badge" :class="d.kind">{{ d.kind }}</span>
            <span class="name">{{ d.entry.name }}</span>
            <span v-if="d.kind === 'changed'" class="fields">{{ d.changedFields?.join(', ') }}</span>
          </div>
        </div>
        <p class="note">New and changed jobs are created/updated when you confirm — unchanged jobs are left alone. Nothing is applied until you confirm.</p>
      </div>
      <footer>
        <button class="btn" type="button" data-test="import-cancel" @click="emit('cancel')">Cancel</button>
        <button
          class="btn primary" type="button" data-test="import-confirm"
          :disabled="applying || applyCount === 0" @click="emit('confirm')"
        >{{ applying ? 'Importing…' : `Import (${applyCount})` }}</button>
      </footer>
    </div>
  </div>
</template>
<style scoped>
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:grid;place-items:center;z-index:100}
.modal{width:560px;max-height:80vh;display:flex;flex-direction:column;background:var(--color-surface);border:1px solid var(--color-border);border-radius:10px;overflow:hidden}
header,footer{padding:var(--p-space-4);border-bottom:1px solid var(--color-border);flex:0 0 auto}
footer{border-bottom:0;border-top:1px solid var(--color-border);display:flex;justify-content:flex-end;gap:10px}
h2{margin:0;font-size:15px}
.body{padding:var(--p-space-4);display:flex;flex-direction:column;gap:var(--p-space-3);overflow:auto}
.summary{display:flex;gap:8px;margin:0}
.tag{font-size:11px;font-weight:600;padding:2px 9px;border-radius:20px}
.tag.new{background:rgba(63,164,91,.16);color:var(--color-ok-text)}
.tag.changed{background:rgba(201,150,46,.16);color:var(--color-warn-text)}
.tag.unchanged{background:var(--color-border);color:var(--color-text-muted)}
.rows{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto;border:1px solid var(--color-border);border-radius:var(--p-radius)}
.row{display:flex;align-items:center;gap:9px;padding:7px 10px;font-size:12.5px;border-bottom:1px solid var(--color-border)}
.row:last-child{border-bottom:0}
.kind-badge{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:1px 6px;border-radius:20px;flex:0 0 auto}
.kind-badge.new{background:rgba(63,164,91,.16);color:var(--color-ok-text)}
.kind-badge.changed{background:rgba(201,150,46,.16);color:var(--color-warn-text)}
.kind-badge.unchanged{background:var(--color-border);color:var(--color-text-muted)}
.row .name{font-weight:600}
.row .fields{color:var(--color-text-muted);font-size:11px;margin-left:auto;font-family:var(--p-font-mono)}
.empty{color:var(--color-text-muted);font-size:12.5px}
.note{margin:0;font-size:11px;color:var(--color-text-muted)}
.btn{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--p-radius);padding:8px 16px;cursor:pointer}
.btn.primary{background:var(--color-primary);color:var(--color-on-primary);border-color:transparent;font-weight:500}
.btn:disabled{opacity:.5;cursor:default}
</style>
