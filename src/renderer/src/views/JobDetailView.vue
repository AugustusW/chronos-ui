<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import type { RunLog, RunDurationTrendPoint } from '../../../shared/ipc-contract'
import { api } from '../ipc/api'
import { useScheduleStore } from '../stores/schedule.store'
import RunHistoryList from '../components/RunHistoryList.vue'
import OutputTerminal from '../components/OutputTerminal.vue'
import SkeletonRows from '../components/SkeletonRows.vue'
import RunTrendSparkline from '../components/RunTrendSparkline.vue'

const props = defineProps<{ id: string }>()
const store = useScheduleStore()
const runs = ref<RunLog[]>([])
const selected = ref<RunLog | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
const trend = ref<RunDurationTrendPoint[]>([])
const exportStatus = ref<string | null>(null)

// Synthetic runId if THIS job currently has a live run in progress
const liveRunId = computed(() => store.runningRuns.get(Number(props.id)))
// The job's command — lets OutputTerminal explain an empty pane when the command redirects output (#7)
const jobCommand = computed(() => store.items.find((it) => it.job?.id === Number(props.id))?.job?.command)

async function loadRuns(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    runs.value = await api.listRuns(Number(props.id))
    selected.value = runs.value[0] ?? null
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function loadTrend(): Promise<void> {
  // Best-effort, separate from loadRuns' loading/error state — a trend fetch failure shouldn't
  // block the (more important) run history + output panes from rendering.
  try {
    trend.value = await api.jobRunDurationTrend(Number(props.id))
  } catch {
    trend.value = []
  }
}

// When a live run transitions from active → finished, reload persisted runs + trend, auto-select newest
watch(liveRunId, async (newVal, oldVal) => {
  if (oldVal !== undefined && newVal === undefined) {
    await Promise.all([loadRuns(), loadTrend()])
  }
})

onMounted(async () => {
  void loadTrend()
  // If there's no live run, load persisted history immediately
  if (liveRunId.value === undefined) {
    await loadRuns()
  }
})

function select(id: number): void { selected.value = runs.value.find((r) => r.id === id) ?? null }

async function exportThisJob(): Promise<void> {
  exportStatus.value = null
  const r = await api.exportJobsYaml([Number(props.id)])
  if (r.status === 'ok') exportStatus.value = `Exported to ${r.path} ✓`
  else if (r.status === 'error') exportStatus.value = `Export failed: ${r.error}`
  // 'canceled' — the user backed out of the save dialog, not an error worth a message.
}

// Live output buffer for the current in-flight run
const liveBuffer = computed(() => liveRunId.value !== undefined ? store.liveOutput.get(liveRunId.value) : undefined)
</script>
<template>
  <div class="detail">
    <div class="trend-bar">
      <RunTrendSparkline :points="trend" />
      <span class="grow" />
      <button class="btn" type="button" data-test="export-job" @click="exportThisJob">Export to YAML…</button>
    </div>
    <p v-if="exportStatus" class="export-status" data-test="export-status">{{ exportStatus }}</p>
    <!-- Live run: always show the live terminal regardless of persisted-history state -->
    <template v-if="liveRunId !== undefined">
      <div class="split">
        <RunHistoryList :runs="runs" :selected-id="selected?.id" @select="select" />
        <OutputTerminal
          :stdout="liveBuffer?.stdout ?? ''"
          :stderr="liveBuffer?.stderr ?? ''"
          :live="true"
        />
      </div>
    </template>
    <!-- No live run: show loading / error / empty / normal list -->
    <template v-else-if="loadError">
      <p class="state-msg error">Couldn't load runs: {{ loadError }}</p>
    </template>
    <template v-else-if="loading">
      <SkeletonRows :count="4" />
    </template>
    <template v-else-if="runs.length === 0">
      <p class="state-msg muted">No runs for this job</p>
    </template>
    <template v-else>
      <div class="split">
        <RunHistoryList :runs="runs" :selected-id="selected?.id" @select="select" />
        <OutputTerminal
          :stdout="selected?.stdout ?? ''"
          :stderr="selected?.stderr ?? ''"
          :live="selected?.result == null"
          :command="jobCommand"
        />
      </div>
    </template>
  </div>
</template>
<style scoped>
.detail{flex:1;display:flex;flex-direction:column;min-width:0}
.trend-bar{display:flex;align-items:center;gap:10px;padding:8px var(--p-space-4,16px);border-bottom:1px solid var(--color-border)}
.grow{flex:1}
.btn{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--p-radius);padding:5px 10px;font-size:11.5px;cursor:pointer}
.export-status{font-size:11.5px;color:var(--color-text-muted);margin:0;padding:0 var(--p-space-4,16px) 6px}
.split{flex:1;display:flex;min-height:0}
.split>:first-child{flex:0 0 340px;border-right:1px solid var(--color-border)}
.state-msg{padding:var(--p-space-4,16px);font-size:13px;margin:0}
.state-msg.muted{color:var(--color-text-muted)}
.state-msg.error{color:var(--color-danger,#e05)}
</style>
