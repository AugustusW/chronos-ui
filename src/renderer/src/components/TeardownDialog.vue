<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { hostPlatform, schedulerLabel } from '../lib/scheduler-label'
const nativeScheduler = computed(() => schedulerLabel(hostPlatform()))

const props = defineProps<{
  open: boolean
  /** Jobs ChronosUI wrapped — these get their original scheduler entry back. */
  adoptedCount: number
  /** Jobs created here — their line keeps running, only the marker goes. */
  createdCount: number
  /** True while the counts are still being scanned; the list is not shown until they are real. */
  counting: boolean
  busy: boolean
}>()
const emit = defineEmits<{ confirm: [deleteData: boolean]; cancel: [] }>()

const deleteData = ref(false)

// Never carry a checked box into the next opening: this is a destructive option and it should be
// deliberate every single time.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) deleteData.value = false
  }
)
</script>

<template>
  <div v-if="open" class="overlay" @keydown.escape="emit('cancel')">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="teardown-title">
      <header><h2 id="teardown-title">Remove ChronosUI</h2></header>
      <div class="body">
        <p v-if="counting" class="muted" data-teardown-counting>Checking what is currently managed…</p>
        <ul v-else class="what">
          <li v-if="adoptedCount" data-teardown-adopted>
            <b>{{ adoptedCount }}</b> adopted
            {{ adoptedCount === 1 ? 'job returns' : 'jobs return' }} to the original
            {{ nativeScheduler }} {{ adoptedCount === 1 ? 'entry' : 'entries' }}, schedules unchanged.
          </li>
          <li v-if="createdCount" data-teardown-created>
            <b>{{ createdCount }}</b>
            {{ createdCount === 1 ? 'job' : 'jobs' }} created here
            {{ createdCount === 1 ? 'keeps' : 'keep' }} running. Only the ChronosUI marker is removed.
          </li>
          <li v-if="!adoptedCount && !createdCount" data-teardown-none>
            No jobs are currently managed, so nothing in {{ nativeScheduler }} changes.
          </li>
          <li>The notification entry ChronosUI installed is removed.</li>
        </ul>

        <p class="irreversible" data-teardown-irreversible>
          This cannot be undone. Re-adopting the jobs afterwards is a manual step.
        </p>

        <label class="opt">
          <input v-model="deleteData" type="checkbox" data-teardown-delete-data />
          <span>
            Also delete run history and settings
            <span class="sub">
              Left unchecked, the local database stays on disk, so reinstalling keeps the history.
            </span>
          </span>
        </label>
      </div>
      <footer>
        <button type="button" data-teardown-cancel :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button
          type="button"
          class="danger-solid"
          data-teardown-confirm
          :disabled="busy || counting"
          @click="emit('confirm', deleteData)"
        >
          {{ busy ? 'Removing…' : 'Remove' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:grid;place-items:center;z-index:100}
.modal{width:520px;max-height:80vh;display:flex;flex-direction:column;background:var(--color-surface);border:1px solid var(--color-border);border-radius:10px;overflow:hidden}
header,footer{padding:var(--p-space-4);border-bottom:1px solid var(--color-border);flex:0 0 auto}
footer{border-bottom:0;border-top:1px solid var(--color-border);display:flex;justify-content:flex-end;gap:10px}
h2{margin:0;font-size:15px}
.body{padding:var(--p-space-4);display:flex;flex-direction:column;gap:var(--p-space-3);overflow:auto}
.muted{color:var(--color-text-muted);margin:0}
.what{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.what li{padding-left:14px;position:relative;line-height:1.45}
.what li::before{content:'';position:absolute;left:0;top:8px;width:5px;height:5px;border-radius:50%;background:var(--color-text-muted)}
.what b{font-variant-numeric:tabular-nums}

/* Light gets a tinted panel; dark gets the frame only (per design review) — a near-black fill on the
   dark surface reads as a hole punched in the dialog rather than as emphasis. */
.irreversible{margin:0;padding:9px 12px;border:1px solid var(--color-danger);border-left-width:3px;border-radius:0 var(--p-radius) var(--p-radius) 0;color:var(--color-danger-text);line-height:1.45}
:root[data-theme='light'] .irreversible{background:var(--color-code-bg)}

.opt{display:flex;gap:9px;align-items:flex-start;padding-top:var(--p-space-3);border-top:1px solid var(--color-border)}
.opt input{margin-top:3px}
.sub{display:block;color:var(--color-text-muted);font-size:12.5px;margin-top:2px;line-height:1.4}
/* Matches the solid-danger button the design system page itself documents (DesignSystemView.vue:131)
   rather than a literal #fff. White on --p-danger is 4.92:1, so AA holds either way; the point is
   that the token is what gets rebound if the palette ever moves. */
.danger-solid{background:var(--color-danger);border-color:transparent;color:var(--color-on-primary)}
.danger-solid:disabled{opacity:.6}
</style>
