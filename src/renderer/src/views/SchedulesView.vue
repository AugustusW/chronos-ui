<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useScheduleStore } from '../stores/schedule.store'
import { api } from '../ipc/api'
import type { CreateJobInput, Job, JobListItem, AdoptItem } from '../../../shared/ipc-contract'
import CategoryFilter from '../components/CategoryFilter.vue'
import BatchActionBar from '../components/BatchActionBar.vue'
import JobRow from '../components/JobRow.vue'
import SkeletonRows from '../components/SkeletonRows.vue'
import EmptyState from '../components/EmptyState.vue'
import JobEditor from '../components/JobEditor.vue'
const router = useRouter()
const store = useScheduleStore()
const loading = ref(true)
const editorOpen = ref(false)
const editingId = ref<number | null>(null)
const editorInitial = ref<Partial<CreateJobInput> | undefined>(undefined)
const saveError = ref<string | null>(null)
const batchState = ref<{ done: number; total: number } | null>(null)
let batchCancel = false
onMounted(async () => { await store.refresh(); loading.value = false })
const counts = computed<Record<string, number>>(() => {
  const c: Record<string, number> = { All: store.items.length }
  for (const cat of store.categories) c[cat] = store.items.filter((it) => it.job?.category === cat).length
  return c
})
const isEmpty = computed(() => !loading.value && store.items.length === 0)
function selectedJobIds(): number[] {
  return store.items
    .filter((it) => it.job && store.selectedIds.has(it.job.id))
    .map((it) => it.job!.id)
}
function exitSelect(): void {
  store.selectedIds.clear()
  store.selectMode = false
  batchState.value = null
}
async function runOne(id: number): Promise<void> { await api.runNowStreaming(id) }
async function batchRun(): Promise<void> {
  const ids = selectedJobIds()
  if (ids.length === 0) return
  batchCancel = false
  batchState.value = { done: 0, total: ids.length }
  for (const id of ids) {
    if (batchCancel) break
    try { await api.runNowStreaming(id) } catch { /* per-job failure doesn't abort batch */ }
    if (batchState.value) batchState.value = { done: batchState.value.done + 1, total: ids.length }
  }
  batchState.value = null
}
function cancelBatchRun(): void {
  batchCancel = true
  batchState.value = null
}
async function batchEnable(): Promise<void> {
  for (const id of selectedJobIds()) { try { await api.enableJob(id) } catch { /* best-effort */ } }
  await store.refresh()
  exitSelect()
}
async function batchDisable(): Promise<void> {
  for (const id of selectedJobIds()) { try { await api.disableJob(id) } catch { /* best-effort */ } }
  await store.refresh()
  exitSelect()
}
async function batchDelete(): Promise<void> {
  for (const id of selectedJobIds()) { try { await api.deleteJob(id) } catch { /* best-effort */ } }
  await store.refresh()
  exitSelect()
}
function openNew(): void {
  editingId.value = null
  editorInitial.value = undefined
  editorOpen.value = true
}
function openEdit(job: Job): void {
  editingId.value = job.id
  editorInitial.value = {
    name: job.name,
    scheduleExpr: job.scheduleExpr,
    command: job.command,
    category: job.category ?? undefined,
    workingDir: job.workingDir ?? undefined,
    timeoutSec: job.timeoutSec ?? undefined,
  }
  editorOpen.value = true
}
async function onSave(input: CreateJobInput): Promise<void> {
  try {
    const result = editingId.value != null
      ? await api.updateJob(editingId.value, input)
      : await api.createJob(input)
    if (!result.ok) {
      // A rejected write (e.g. adopted-command guard, drift) must surface — not silently close.
      saveError.value = result.error ?? 'Failed to save job'
      return
    }
    saveError.value = null
    editorOpen.value = false
    await store.refresh()
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : 'Failed to save job'
  }
}
async function onAdopt(it: JobListItem): Promise<void> {
  if (!it.native) return
  // #8: carry the native name (Windows Task Scheduler) into the adopted job; cron has none → blank.
  const item: AdoptItem = { name: it.native.name, scheduleExpr: it.native.scheduleExpr, command: it.native.command }
  try {
    await api.adoptJobs([item])
    await store.refresh()
  } catch { /* best-effort */ }
}
async function onScan(): Promise<void> {
  // store.refresh() owns loading/error state and never throws; errors surface via store.scanError.
  await store.refresh()
}
</script>
<template>
  <div class="wrap">
    <div class="topbar">
      <h1>Schedules</h1><span class="grow" />
      <button class="btn" :class="{ on: store.selectMode }" type="button" @click="store.selectMode = !store.selectMode">☑ Select</button>
      <button class="btn primary" type="button" @click="openNew">＋ New job</button>
    </div>
    <JobEditor :open="editorOpen" :initial="editorInitial" @save="onSave" @cancel="editorOpen = false" />
    <p v-if="saveError" class="save-err">{{ saveError }}</p>
    <p v-if="store.scanError" class="save-err">Scan failed: {{ store.scanError }}</p>
    <template v-if="isEmpty"><EmptyState :scanning="store.loading" :scanned="store.hasScanned && !store.scanError" @new="openNew" @scan="onScan" /></template>
    <template v-else>
      <CategoryFilter :categories="store.categories" :active="store.categoryFilter" :counts="counts" @change="store.setCategory" />
      <div class="list">
        <SkeletonRows v-if="loading" :count="4" />
        <template v-else>
          <BatchActionBar
            v-if="store.selectMode && store.selectedIds.size" :count="store.selectedIds.size"
            :running="batchState ?? undefined"
            @run="batchRun" @enable="batchEnable" @disable="batchDisable" @delete="batchDelete"
            @cancel="cancelBatchRun" @clear="exitSelect" />
          <template v-for="g in store.visibleGroups" :key="g.category">
            <div class="ghead">{{ g.category }} <span class="gc">{{ g.items.length }}</span></div>
            <JobRow
              v-for="it in g.items" :key="it.job?.id ?? it.native?.scheduleExpr" :item="it"
              :select-mode="store.selectMode" :selected="!!it.job && store.selectedIds.has(it.job.id)"
              :running="!!it.job && store.runningRuns.has(it.job.id)"
              @toggle-select="it.job && store.toggleSelect(it.job.id)" @run="it.job && runOne(it.job.id)"
              @open-detail="it.job?.id && router.push('/jobs/' + it.job.id)"
              @edit="it.job && openEdit(it.job)" @adopt="onAdopt(it)" />
          </template>
        </template>
      </div>
    </template>
  </div>
</template>
<style scoped>
.wrap{flex:1;display:flex;flex-direction:column;min-width:0}
.topbar{display:flex;align-items:center;gap:10px;padding:var(--p-space-3) var(--p-space-4);border-bottom:1px solid var(--color-border);background:var(--color-surface)}
.topbar h1{font-size:15px;margin:0}.grow{flex:1}
.btn{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--p-radius);padding:6px 12px;font-size:12px;cursor:pointer}
.btn.primary{background:var(--color-primary);color:var(--color-on-primary);border-color:transparent;font-weight:500}.btn.on{border-color:var(--color-primary);color:var(--color-primary)}
.list{flex:1;overflow:auto;padding:var(--p-space-2) var(--p-space-4)}
.ghead{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--color-text-muted);margin:var(--p-space-3) 4px var(--p-space-2)}
.gc{background:var(--color-border);border-radius:20px;font-size:10px;padding:0 7px}
.save-err{color:var(--color-danger,#e05);font-size:12px;padding:var(--p-space-2) var(--p-space-4);margin:0}
</style>
