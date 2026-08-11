<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRunHistoryStore } from '../stores/runHistory.store'
import { api } from '../ipc/api'
import type { DateRangePreset } from '../lib/format'
import RunHistoryList from '../components/RunHistoryList.vue'
import SkeletonRows from '../components/SkeletonRows.vue'

const store = useRunHistoryStore()
const jobs = ref<Array<{ id: number; name: string }>>([])

const DATE_PRESETS: Array<{ value: DateRangePreset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' }
]
const RESULT_OPTIONS: Array<{ value: 'success' | 'failure' | 'timeout'; label: string }> = [
  { value: 'success', label: 'Succeeded' },
  { value: 'failure', label: 'Failed' },
  { value: 'timeout', label: 'Timeout' }
]

onMounted(async () => {
  void store.refresh()
  try {
    const { items } = await api.listJobs()
    jobs.value = items
      .filter((it): it is typeof it & { job: NonNullable<typeof it.job> } => !!it.job)
      .map((it) => ({ id: it.job.id, name: it.job.name }))
  } catch {
    // The job filter dropdown just stays empty — every OTHER filter (result/date/search) still works.
  }
})

function onJobChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value
  store.setFilters({ jobId: v ? Number(v) : null })
}
function onResultChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value as '' | 'success' | 'failure' | 'timeout'
  store.setFilters({ result: v || null })
}
</script>
<template>
  <div class="run-history">
    <div class="filters">
      <select data-test="filter-job" :value="store.filters.jobId ?? ''" @change="onJobChange">
        <option value="">All jobs</option>
        <option v-for="j in jobs" :key="j.id" :value="j.id">{{ j.name }}</option>
      </select>
      <select data-test="filter-result" :value="store.filters.result ?? ''" @change="onResultChange">
        <option value="">All results</option>
        <option v-for="r in RESULT_OPTIONS" :key="r.value" :value="r.value">{{ r.label }}</option>
      </select>
      <div class="segmented" data-test="filter-date">
        <button
          v-for="p in DATE_PRESETS" :key="p.value" type="button"
          :class="{ active: store.filters.datePreset === p.value }"
          @click="store.setFilters({ datePreset: p.value })"
        >{{ p.label }}</button>
      </div>
      <input
        class="search" data-test="filter-search" type="search" placeholder="Search job name, output…"
        :value="store.filters.searchText"
        @input="store.setSearchText(($event.target as HTMLInputElement).value)"
      />
      <button
        v-if="store.filters.jobId || store.filters.result || store.filters.datePreset !== 'all' || store.filters.searchText"
        class="btn" type="button" data-test="filter-clear" @click="store.clearFilters()"
      >Clear</button>
    </div>
    <template v-if="store.error">
      <p class="state-msg error">Couldn't load runs: {{ store.error }}</p>
    </template>
    <template v-else-if="store.loading">
      <SkeletonRows :count="5" />
    </template>
    <template v-else-if="store.runs.length === 0">
      <p class="state-msg muted">No runs match these filters</p>
    </template>
    <template v-else>
      <RunHistoryList :runs="store.runs" />
      <div v-if="store.hasMore" class="load-more">
        <button class="btn" type="button" :disabled="store.loadingMore" data-test="load-more" @click="store.loadMore()">
          {{ store.loadingMore ? 'Loading…' : 'Load 50 more' }}
        </button>
      </div>
    </template>
  </div>
</template>
<style scoped>
.run-history{flex:1;display:flex;flex-direction:column;min-height:0}
.filters{display:flex;align-items:center;gap:8px;padding:var(--p-space-3,12px) var(--p-space-4,16px);border-bottom:1px solid var(--color-border);flex-wrap:wrap}
.filters select{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--p-radius);padding:5px 8px;font-size:12px}
.search{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--p-radius);padding:5px 8px;font-size:12px;flex:1;min-width:140px}
.segmented{display:flex}
.segmented button{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);padding:5px 10px;font-size:11.5px;cursor:pointer}
.segmented button.active{background:rgba(var(--color-primary-rgb),.12);border-color:var(--color-primary);color:var(--color-primary)}
.btn{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--p-radius);padding:5px 10px;font-size:11.5px;cursor:pointer}
.load-more{display:flex;justify-content:center;padding:var(--p-space-3,12px)}
.state-msg{padding:var(--p-space-4,16px);font-size:13px;margin:0}
.state-msg.muted{color:var(--color-text-muted)}
.state-msg.error{color:var(--color-danger,#e05)}
</style>
