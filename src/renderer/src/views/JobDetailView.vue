<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import type { RunLog, RunDurationTrendPoint, JobRevision } from '../../../shared/ipc-contract'
import { api } from '../ipc/api'
import { useScheduleStore } from '../stores/schedule.store'
import RunHistoryList from '../components/RunHistoryList.vue'
import OutputTerminal from '../components/OutputTerminal.vue'
import SkeletonRows from '../components/SkeletonRows.vue'
import RunTrendSparkline from '../components/RunTrendSparkline.vue'
import JobRevisionList from '../components/JobRevisionList.vue'
import { revertPlan } from '../lib/revert-plan'

const props = defineProps<{ id: string }>()
const store = useScheduleStore()
const runs = ref<RunLog[]>([])
const selected = ref<RunLog | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
const trend = ref<RunDurationTrendPoint[]>([])
const exportStatus = ref<string | null>(null)
const tab = ref<'runs' | 'changes'>('runs')
const revisions = ref<JobRevision[]>([])
const revisionError = ref<string | null>(null)
const revertStatus = ref<string | null>(null)

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

watch(tab, (t) => {
  if (t === 'changes') void loadRevisions()
})

onMounted(async () => {
  void loadTrend()
  // If there's no live run, load persisted history immediately
  if (liveRunId.value === undefined) {
    await loadRuns()
  }
})

function select(id: number): void { selected.value = runs.value.find((r) => r.id === id) ?? null }

const REVISION_PAGE = 200
// Ask for one more than we show: `length >= PAGE` would claim truncation for a job that has
// exactly PAGE changes and nothing older.
const revisionsTruncated = ref(false)

async function loadRevisions(): Promise<void> {
  revisionError.value = null
  try {
    const fetched = await api.listRevisions(Number(props.id), REVISION_PAGE + 1)
    revisionsTruncated.value = fetched.length > REVISION_PAGE
    revisions.value = fetched.slice(0, REVISION_PAGE)
  } catch (err) {
    revisionError.value = err instanceof Error ? err.message : String(err)
  }
}

/**
 * Write the schedule and command ChronosUI holds back into the native scheduler. This is the
 * answer to an EXTERNAL change: the DB already has the values being restored, so the ordinary
 * edit path would compare them against themselves, skip the scheduler and report success while
 * the foreign entry kept running.
 */
async function restore(): Promise<void> {
  revertStatus.value = null
  try {
    const r = await api.restoreToScheduler(Number(props.id))
    revertStatus.value = r.ok
      ? 'Restored in the scheduler'
      : `Restore failed: ${'error' in r ? r.error : r.reason}`
  } catch (err) {
    revertStatus.value = `Restore failed: ${err instanceof Error ? err.message : String(err)}`
    return
  }
  await Promise.all([loadRevisions(), store.refresh()])
}

/**
 * Reverting re-applies the revision's old values through the ordinary update path, so it goes
 * through the same validation and the same adapter guards as any edit — including the one that
 * refuses to change an adopted job's command in place. That refusal surfaces here as an ordinary
 * error message rather than a special case, which is what keeps the two paths consistent.
 */
async function revert(revision: JobRevision): Promise<void> {
  revertStatus.value = null
  const plan = revertPlan(revision)
  // A revert can be two writes (fields, then enabled). If the first lands and the second fails,
  // saying only "Revert failed" would hide a change that DID happen — so track and report both.
  const landed: string[] = []
  try {
    if (Object.keys(plan.changes).length > 0) {
      const r = await api.updateJob(Number(props.id), plan.changes)
      if (!r.ok) {
        revertStatus.value = `Revert failed: ${'error' in r ? r.error : r.reason}`
        await Promise.all([loadRevisions(), store.refresh()])
        return
      }
      landed.push(Object.keys(plan.changes).join(', '))
    }
    if (plan.setEnabled !== undefined) {
      const r = plan.setEnabled ? await api.enableJob(Number(props.id)) : await api.disableJob(Number(props.id))
      if (!r.ok) {
        const done = landed.length ? ` (${landed.join(', ')} was restored)` : ''
        revertStatus.value = `Revert failed: ${'error' in r ? r.error : r.reason}${done}`
        await Promise.all([loadRevisions(), store.refresh()])
        return
      }
    }
  } catch (err) {
    const done = landed.length ? ` (${landed.join(', ')} was restored)` : ''
    revertStatus.value = `Revert failed: ${err instanceof Error ? err.message : String(err)}${done}`
    // Refresh here too: a throw can still follow a write that landed, and the other failure paths
    // already refresh — leaving this one stale would show different state for the same outcome.
    await Promise.all([loadRevisions(), store.refresh()])
    return
  }
  // Say what could NOT be restored. Reporting only success would leave the user believing the job
  // is fully back to its old state when part of it is not.
  revertStatus.value = plan.unsupported.length
    ? `Reverted, except: ${plan.unsupported.join(', ')} — restore those by editing the job`
    : 'Reverted'
  await Promise.all([loadRevisions(), store.refresh()])
}

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
      <div class="tabs" role="tablist">
        <button class="tab" :class="{ on: tab === 'runs' }" type="button" role="tab" :aria-selected="tab === 'runs'" data-test="tab-runs" @click="tab = 'runs'">Runs</button>
        <button class="tab" :class="{ on: tab === 'changes' }" type="button" role="tab" :aria-selected="tab === 'changes'" data-test="tab-changes" @click="tab = 'changes'">Changes</button>
      </div>
      <RunTrendSparkline v-if="tab === 'runs'" :points="trend" />
      <span class="grow" />
      <button class="btn" type="button" data-test="export-job" @click="exportThisJob">Export to YAML…</button>
    </div>
    <p v-if="exportStatus" class="export-status" data-test="export-status">{{ exportStatus }}</p>
    <!-- Configuration change log — independent of run state, so it sits ahead of the run branches -->
    <template v-if="tab === 'changes'">
      <p v-if="revertStatus" class="export-status" data-test="revert-status">{{ revertStatus }}</p>
      <p v-if="revisionError" class="state-msg error">Couldn't load changes: {{ revisionError }}</p>
      <template v-else>
        <p v-if="revisionsTruncated" class="export-status" data-test="revisions-truncated">
          Showing the {{ REVISION_PAGE }} most recent changes.
        </p>
        <JobRevisionList :revisions="revisions" @revert="revert" @restore="restore" />
      </template>
    </template>
    <!-- Live run: always show the live terminal regardless of persisted-history state -->
    <template v-else-if="liveRunId !== undefined">
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
.tabs{display:flex;border:1px solid var(--color-border);border-radius:var(--p-radius);overflow:hidden}
.tab{border:0;background:none;color:var(--color-text-muted);padding:4px 12px;font-size:11.5px;cursor:pointer}
.tab.on{background:rgba(var(--color-primary-rgb),.12);color:var(--color-text)}
.grow{flex:1}
.btn{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--p-radius);padding:5px 10px;font-size:11.5px;cursor:pointer}
.export-status{font-size:11.5px;color:var(--color-text-muted);margin:0;padding:0 var(--p-space-4,16px) 6px}
.split{flex:1;display:flex;min-height:0}
.split>:first-child{flex:0 0 340px;border-right:1px solid var(--color-border)}
.state-msg{padding:var(--p-space-4,16px);font-size:13px;margin:0}
.state-msg.muted{color:var(--color-text-muted)}
.state-msg.error{color:var(--color-danger,#e05)}
</style>
