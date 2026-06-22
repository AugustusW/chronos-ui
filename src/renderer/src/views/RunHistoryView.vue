<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { RunLog } from '../../../shared/ipc-contract'
import RunHistoryList from '../components/RunHistoryList.vue'
import SkeletonRows from '../components/SkeletonRows.vue'

const recent = ref<RunLog[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)

onMounted(async () => {
  loading.value = true
  loadError.value = null
  try {
    recent.value = await window.chronos.recentRuns(50)
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
})
</script>
<template>
  <div class="run-history">
    <template v-if="loadError">
      <p class="state-msg error">Couldn't load runs: {{ loadError }}</p>
    </template>
    <template v-else-if="loading">
      <SkeletonRows :count="5" />
    </template>
    <template v-else-if="recent.length === 0">
      <p class="state-msg muted">No runs yet</p>
    </template>
    <template v-else>
      <RunHistoryList :runs="recent" />
    </template>
  </div>
</template>
<style scoped>
.run-history{flex:1;display:flex;flex-direction:column;min-height:0}
.state-msg{padding:var(--p-space-4,16px);font-size:13px;margin:0}
.state-msg.muted{color:var(--color-text-muted)}
.state-msg.error{color:var(--color-danger,#e05)}
</style>
