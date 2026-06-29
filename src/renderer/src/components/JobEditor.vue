<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { reactive, watch } from 'vue'
import type { CreateJobInput } from '../../../shared/ipc-contract'
import CronPreview from './CronPreview.vue'
const props = defineProps<{ open: boolean; initial?: Partial<CreateJobInput> }>()
const emit = defineEmits<{ save: [v: CreateJobInput]; cancel: [] }>()
const f = reactive<CreateJobInput>({ name: '', scheduleExpr: '', command: '', notifyOnFailure: false, ...props.initial })
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    Object.assign(f, {
      name: '',
      scheduleExpr: '',
      command: '',
      category: undefined,
      workingDir: undefined,
      env: undefined,
      timeoutSec: undefined,
      notifyOnFailure: false,
      ...props.initial,
    })
  }
})
</script>
<template>
  <div v-if="open" class="overlay" @keydown.escape="emit('cancel')">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="job-editor-title">
      <header><h2 id="job-editor-title">{{ initial ? 'Edit job' : 'New job' }}</h2></header>
      <div class="body">
        <label>Name<input v-model="f.name" data-f="name" class="in" /></label>
        <label>Schedule (cron)<input v-model="f.scheduleExpr" data-f="schedule" class="in mono" /></label>
        <CronPreview :expr="f.scheduleExpr" />
        <label>Command<textarea v-model="f.command" data-f="command" class="in mono" /></label>
        <label>Category<input v-model="f.category" data-f="category" class="in" /></label>
        <label class="notify-row"><input v-model="f.notifyOnFailure" data-test="job-notify" type="checkbox" /> Notify me if this job fails</label>
      </div>
      <footer>
        <button class="btn" type="button" @click="emit('cancel')">Cancel</button>
        <button data-save class="btn primary" type="button" @click="emit('save', { ...f })">{{ initial ? 'Save' : 'Create job' }}</button>
      </footer>
    </div>
  </div>
</template>
<style scoped>
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:grid;place-items:center;z-index:100}
.modal{width:560px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:10px;overflow:hidden}
header,footer{padding:var(--p-space-4);border-bottom:1px solid var(--color-border)}footer{border-bottom:0;border-top:1px solid var(--color-border);display:flex;justify-content:flex-end;gap:10px}
h2{margin:0;font-size:15px}.body{padding:var(--p-space-4);display:flex;flex-direction:column;gap:var(--p-space-3)}
label{display:block;font-size:12px;font-weight:500}
.in{width:100%;border:1px solid var(--color-border);background:var(--color-bg);color:var(--color-text);border-radius:var(--p-radius);padding:8px 10px;font-size:13px;margin-top:4px}
.mono{font-family:var(--p-font-mono)}textarea.in{min-height:46px;resize:vertical}
.btn{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--p-radius);padding:8px 16px;cursor:pointer}
.btn.primary{background:var(--color-primary);color:var(--color-on-primary);border-color:transparent;font-weight:500}
</style>
