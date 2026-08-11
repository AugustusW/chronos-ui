<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import type { RunLog } from '../../../shared/ipc-contract'
import { relativeTime, formatDuration } from '../lib/format'
import StatusBadge from './StatusBadge.vue'
// v0.4.0: RunHistoryView's search results carry `jobName` (RunLogWithJob, joined across all jobs);
// JobDetailView's single-job list still passes plain RunLog — jobName is simply omitted per-row then.
type RunRow = RunLog & { jobName?: string }
defineProps<{ runs: RunRow[]; selectedId?: number }>()
const emit = defineEmits<{ select: [id: number] }>()
const badge = (r: RunRow): 'ok' | 'fail' | 'warn' | 'run' =>
  r.result === 'failure' ? 'fail' : r.result === 'timeout' ? 'warn' : r.result === 'success' ? 'ok' : 'run'
</script>
<template>
  <div class="hist">
    <button v-for="r in runs" :key="r.id" :data-run-id="r.id" class="hrow" :class="{ sel: r.id === selectedId }" type="button" @click="emit('select', r.id)">
      <StatusBadge :status="badge(r)" :label="r.result ?? 'running'" />
      <div>
        <div class="when">
          <span v-if="r.jobName" class="job-name" data-test="run-job-name">{{ r.jobName }}</span>{{ relativeTime(r.startedAt as unknown as number) }}
        </div>
        <div class="sub">{{ r.durationMs ? formatDuration(r.durationMs) : '—' }} · exit {{ r.exitCode ?? '—' }}</div>
      </div>
      <span class="trig">{{ r.triggeredBy }}</span>
    </button>
  </div>
</template>
<style scoped>
.hist{overflow:auto;padding:var(--p-space-3)}
.hrow{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 10px;border:0;background:none;border-radius:var(--p-radius);cursor:pointer;font-variant-numeric:tabular-nums;color:var(--color-text)}
.hrow.sel{background:rgba(var(--color-primary-rgb),.12)}
.when{font-size:12.5px}.sub{font-size:11px;color:var(--color-text-muted)}
.job-name{font-weight:600;margin-right:7px;font-variant-numeric:normal}
.trig{margin-left:auto;font-size:10px;color:var(--color-text-muted);border:1px solid var(--color-border);border-radius:20px;padding:1px 7px}
</style>
