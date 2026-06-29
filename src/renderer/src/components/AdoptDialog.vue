<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  schedule: string
  command: string
  defaultName: string
}>()

const emit = defineEmits<{
  adopt: [{ name: string; category?: string }]
  cancel: []
}>()

const name = ref(props.defaultName)
const category = ref('')

watch(
  () => props.defaultName,
  (v) => { name.value = v },
)

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      name.value = props.defaultName
      category.value = ''
    }
  },
)

function onAdopt() {
  const payload: { name: string; category?: string } = { name: name.value }
  if (category.value) payload.category = category.value
  emit('adopt', payload)
}
</script>

<template>
  <div v-if="open" class="overlay" @keydown.escape="emit('cancel')">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="adopt-dialog-title">
      <header><h2 id="adopt-dialog-title">Adopt job</h2></header>
      <div class="body">
        <div class="ro-group">
          <span class="ro-label">Schedule</span>
          <div data-ro="schedule" class="ro mono">{{ schedule }}</div>
        </div>
        <div class="ro-group">
          <span class="ro-label">Command</span>
          <div data-ro="command" class="ro mono">{{ command }}</div>
        </div>
        <label>Name<input v-model="name" data-f="name" class="in" /></label>
        <label>Category<input v-model="category" data-f="category" class="in" /></label>
        <p class="note">ChronosUI will wrap this existing cron line so it can record runs — fully reversible.</p>
      </div>
      <footer>
        <button data-cancel class="btn" type="button" @click="emit('cancel')">Cancel</button>
        <button data-adopt class="btn primary" type="button" @click="onAdopt">Adopt</button>
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
.ro-group{display:flex;flex-direction:column;gap:4px}
.ro-label{font-size:12px;font-weight:500}
.ro{border:1px solid var(--color-border);background:var(--color-bg);color:var(--color-text);border-radius:var(--p-radius);padding:8px 10px;font-size:13px;opacity:.7;white-space:pre-wrap;word-break:break-all}
.mono{font-family:var(--p-font-mono)}
.btn{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--p-radius);padding:8px 16px;cursor:pointer}
.btn.primary{background:var(--color-primary);color:var(--color-on-primary);border-color:transparent;font-weight:500}
.note{margin:0;font-size:11px;color:var(--color-text-muted)}
</style>
