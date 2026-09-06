<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { JobRevision } from '../../../shared/ipc-contract'
import { relativeTime } from '../lib/format'

const props = defineProps<{ revisions: JobRevision[] }>()
const emit = defineEmits<{ revert: [revision: JobRevision]; restore: [revision: JobRevision] }>()

// Stored values are internal identifiers; everything on screen is the word a person would use.
const SOURCE_LABEL: Record<string, string> = {
  edit: 'edit',
  external: 'changed outside ChronosUI',
  resolved: 'put back',
  adopt: 'adopted',
  unadopt: 'un-adopted'
}
const FIELD_LABEL: Record<string, string> = {
  name: 'name',
  scheduleExpr: 'schedule',
  command: 'command',
  workingDir: 'working directory',
  env: 'environment',
  timeoutSec: 'timeout',
  category: 'category',
  notifyOnFailure: 'notify on failure',
  enabled: 'enabled',
  adopted: 'adopted'
}
// What adopt/un-adopt actually did, in place of a true/false diff that would tell nobody anything.
const SOURCE_NOTE: Record<string, string> = {
  adopt: 'Took over an existing entry in the native scheduler.',
  unadopt: 'Handed the entry back to the native scheduler.'
}

const sourceLabel = (s: string): string => SOURCE_LABEL[s] ?? s
const fieldLabel = (f: string): string => FIELD_LABEL[f] ?? f

function formatValue(v: unknown): string {
  // '' and "not set" are different states and revert treats them differently (an empty string can
  // be restored, an unset optional field cannot), so the display must not merge them.
  if (v === null || v === undefined) return '(not set)'
  if (v === '') return '(empty)'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** changedAt arrives as a Date across the IPC bridge; relativeTime takes epoch ms. */
const changedAtMs = (v: Date | number): number => (v instanceof Date ? v.getTime() : v)

/**
 * An `edit` is undone by re-applying its old values through the ordinary update path.
 *
 * An `external` change is NOT: after one, the DB still holds the old values, so "re-apply the old
 * values" is a no-op that update() would skip entirely while the foreign command kept running.
 * What that case needs is the opposite direction — push what ChronosUI has back into the scheduler
 * — so it gets its own action and its own word.
 *
 * adopt/un-adopt gets neither: it is undone by adopting or un-adopting again, which already has a
 * button of its own.
 */
const canRevert = (r: JobRevision): boolean => r.source === 'edit'

/**
 * Restoring is a per-JOB action — it writes the job's current values into the scheduler — so it is
 * offered on the newest external change only. Putting the same button on older ones would suggest
 * they can be restored individually, when clicking any of them does exactly the same thing.
 *
 * And only while that change is still standing: a `resolved` newer than it means the scheduler is
 * already back in agreement, so the button would be a no-op that reports success. (Revisions
 * arrive newest first, so a `resolved` before it in the list is a later one.)
 */
const restorableId = computed(() => {
  const newest = props.revisions.find((r) => r.source === 'external' || r.source === 'resolved')
  return newest?.source === 'external' ? newest.id : undefined
})
const canRestore = (r: JobRevision): boolean => r.id === restorableId.value
</script>
<template>
  <div class="revs">
    <p v-if="revisions.length === 0" class="empty">No configuration changes recorded</p>
    <article v-for="r in revisions" :key="r.id" class="rev" :data-revision-id="r.id">
      <header>
        <span class="when">{{ relativeTime(changedAtMs(r.changedAt)) }}</span>
        <span class="source" :class="r.source">{{ sourceLabel(r.source) }}</span>
        <button
          v-if="canRevert(r)"
          class="revert"
          type="button"
          data-test="revert"
          @click="emit('revert', r)"
        >
          Revert
        </button>
        <button
          v-else-if="canRestore(r)"
          class="revert"
          type="button"
          data-test="restore"
          title="Write the schedule and command ChronosUI has back into the system scheduler"
          @click="emit('restore', r)"
        >
          Restore in scheduler
        </button>
      </header>
      <p v-if="SOURCE_NOTE[r.source]" class="note">{{ SOURCE_NOTE[r.source] }}</p>
      <template v-else>
        <div v-for="f in r.changedFields" :key="f" class="field" data-test="revision-field">
          <span class="fname">{{ fieldLabel(f) }}</span>
          <span class="val before"><span class="sign">−</span>{{ formatValue(r.before[f]) }}</span>
          <span class="val after"><span class="sign">+</span>{{ formatValue(r.after[f]) }}</span>
        </div>
      </template>
    </article>
  </div>
</template>
<style scoped>
.revs{overflow:auto;padding:var(--p-space-3);flex:1;min-width:0}
.empty{font-size:13px;color:var(--color-text-muted);margin:0;padding:var(--p-space-4,16px)}
.rev{border:1px solid var(--color-border);border-radius:var(--p-radius);padding:9px 10px;margin-bottom:8px;background:var(--color-surface)}
.rev header{display:flex;align-items:center;gap:8px}
.when{font-size:12.5px;color:var(--color-text);font-variant-numeric:tabular-nums}
.source{font-size:10px;color:var(--color-text-muted);border:1px solid var(--color-border);border-radius:20px;padding:1px 7px}
.revert{margin-left:auto;border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--p-radius);padding:3px 9px;font-size:11px;cursor:pointer}
.note{font-size:11.5px;color:var(--color-text-muted);margin:6px 0 0}
.field{margin-top:7px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;align-items:baseline}
.fname{grid-row:span 2;font-size:11px;color:var(--color-text-muted)}
.val{font-size:12px;font-family:var(--p-font-mono,ui-monospace,monospace);word-break:break-all}
.sign{display:inline-block;width:1.1em;color:var(--color-text-muted)}
.before{text-decoration:line-through;color:var(--color-text-muted)}
</style>
