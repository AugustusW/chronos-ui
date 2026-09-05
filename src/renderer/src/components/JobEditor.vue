<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { CreateJobInput } from '../../../shared/ipc-contract'
import {
  validateTriggerDescriptor,
  describeTriggerDescriptor,
  TRIGGER_DESCRIPTOR_EXAMPLE
} from '../../../shared/trigger-validation'
import { hostPlatform, schedulerLabel } from '../lib/scheduler-label'
import CronPreview from './CronPreview.vue'
/** `error` is why the last save was rejected. It renders inside the modal because this dialog
 *  covers the whole viewport — a message elsewhere on the page is behind it. Distinct from
 *  scheduleError, which is this form's own validation and belongs beside its field. */
const props = defineProps<{ open: boolean; initial?: Partial<CreateJobInput>; adopted?: boolean; error?: string | null }>()
const emit = defineEmits<{ save: [v: CreateJobInput]; cancel: []; unadopt: []; forget: [] }>()

// Windows schedules with Task Scheduler descriptors; everything else with cron. The field used to
// say "cron" on all three, so a Windows user was told to enter the one format their machine cannot
// accept — and found out only when the adapter handed back `trigger: unknown kind 0`.
const isWin = computed(() => hostPlatform() === 'win32')
const nativeScheduler = computed(() => schedulerLabel(hostPlatform()))
function onUnadopt() {
  if (window.confirm(`Stop managing this job? It reverts to its original ${nativeScheduler.value} entry and removes it from ChronosUI.`)) emit('unadopt')
}
function onForget() {
  if (window.confirm(`Stop managing this job? ChronosUI will forget it but leave its ${nativeScheduler.value} entry untouched.`)) emit('forget')
}
const f = reactive<CreateJobInput>({ name: '', scheduleExpr: '', command: '', notifyOnFailure: false, ...props.initial })
// Only shown after a failed submit: complaining while someone is still typing "dai" is noise.
const scheduleError = ref<string | null>(null)
const triggerPreview = computed(() => (isWin.value ? describeTriggerDescriptor(f.scheduleExpr) : null))

function onSave() {
  // Validated here rather than left to the adapter, so the message arrives beside the field that
  // caused it instead of after an IPC round trip. cron is not validated: the Unix adapter
  // accepts forms this app has no business second-guessing.
  if (isWin.value) {
    const err = validateTriggerDescriptor(f.scheduleExpr)
    if (err) {
      scheduleError.value = err
      return
    }
  }
  scheduleError.value = null
  emit('save', { ...f })
}

watch(() => f.scheduleExpr, () => (scheduleError.value = null))

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
    scheduleError.value = null
  }
})
</script>
<template>
  <div v-if="open" class="overlay" @keydown.escape="emit('cancel')">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="job-editor-title">
      <header><h2 id="job-editor-title">{{ initial ? 'Edit job' : 'New job' }}</h2></header>
      <div class="body">
        <label>Name<input v-model="f.name" data-f="name" class="in" /></label>
        <label>
          <span data-schedule-label>{{ isWin ? 'Schedule (Task Scheduler)' : 'Schedule (cron)' }}</span>
          <input
            v-model="f.scheduleExpr"
            data-f="schedule"
            class="in mono"
            :placeholder="isWin ? TRIGGER_DESCRIPTOR_EXAMPLE : ''"
          />
        </label>
        <p v-if="scheduleError" data-schedule-error class="field-error">{{ scheduleError }}</p>
        <CronPreview v-if="!isWin" :expr="f.scheduleExpr" data-cron-preview />
        <p v-else-if="triggerPreview" data-trigger-preview class="hint">{{ triggerPreview }}</p>
        <label>Command<textarea v-model="f.command" data-f="command" class="in mono" /></label>
        <label>Category<input v-model="f.category" data-f="category" class="in" /></label>
        <label class="notify-row"><input v-model="f.notifyOnFailure" data-test="job-notify" type="checkbox" /> Notify me if this job fails</label>
        <p v-if="error" data-save-error class="field-error">{{ error }}</p>
      </div>
      <footer>
        <button v-if="initial && adopted" data-unadopt class="btn danger" type="button" @click="onUnadopt">Un-adopt</button>
        <button v-if="initial && !adopted" data-forget class="btn danger" type="button" @click="onForget">Forget</button>
        <button class="btn" type="button" @click="emit('cancel')">Cancel</button>
        <button data-save class="btn primary" type="button" @click="onSave">{{ initial ? 'Save' : 'Create job' }}</button>
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
/* danger-TEXT, not danger: the fill token fails contrast as body copy — same split StatusBadge
   and TeardownDialog already follow. */
.field-error{margin:0;font-size:12px;color:var(--color-danger-text)}
.hint{margin:0;font-size:12px;color:var(--color-text-muted)}
.btn{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--p-radius);padding:8px 16px;cursor:pointer}
.btn.primary{background:var(--color-primary);color:var(--color-on-primary);border-color:transparent;font-weight:500}
/* Semantic token, not a literal: the hardcoded #c0392b this replaced was both a different red from
   the design system's --p-danger (#c0493f) and invisible to the dark-theme rebind, since only the
   semantic layer gets redefined under [data-theme='dark']. */
.btn.danger{color:var(--color-danger);border-color:var(--color-danger);margin-right:auto}
</style>
