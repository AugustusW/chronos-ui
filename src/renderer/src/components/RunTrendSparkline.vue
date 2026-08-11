<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { RunDurationTrendPoint } from '../../../shared/ipc-contract'
import { buildSparklineModel } from '../lib/sparkline'

const props = defineProps<{ points: RunDurationTrendPoint[] }>()
// jobRunDurationTrend (JOB_TREND_LIMIT) returns most-recent-first, matching every other
// listX-style query in this app; the sparkline itself always draws oldest→newest, left→right.
const chronological = computed(() => [...props.points].reverse())
const model = computed(() => buildSparklineModel(chronological.value))
const failedCount = computed(() => props.points.filter((p) => p.result !== 'success').length)
</script>
<template>
  <div v-if="points.length > 0" class="trend" data-test="trend-sparkline">
    <svg
      :viewBox="`0 0 ${model.width} ${model.height}`"
      :width="model.width"
      :height="model.height"
      preserveAspectRatio="none"
      role="img"
      :aria-label="`Duration trend over the last ${points.length} runs, ${failedCount} failed`"
    >
      <path :d="model.path" fill="none" stroke="var(--color-primary)" stroke-width="1.5" stroke-linejoin="round" />
      <circle
        v-for="(m, i) in model.markers" :key="i"
        :cx="m.x" :cy="m.y" r="2.2" fill="var(--color-danger)" data-test="trend-fail-marker"
      />
    </svg>
    <span class="trend-label">last {{ points.length }} runs<template v-if="failedCount"> · {{ failedCount }} failed</template></span>
  </div>
  <p v-else class="trend-empty" data-test="trend-empty">No completed runs yet</p>
</template>
<style scoped>
.trend{display:flex;align-items:center;gap:8px}
.trend-label{font-size:11px;color:var(--color-text-muted);font-variant-numeric:tabular-nums}
.trend-empty{font-size:11px;color:var(--color-text-muted);margin:0}
</style>
