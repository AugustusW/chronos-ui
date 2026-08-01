<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import { useDashboardStore } from '../stores/dashboard.store'
import { cronToHuman, formatDuration, upcomingLabel, hhmm } from '../lib/format'
import { DASHBOARD_FAILURES_LIMIT } from '../../../shared/dashboard-limits'
import StatusDot from '../components/StatusDot.vue'
import SkeletonRows from '../components/SkeletonRows.vue'

const router = useRouter()
const store = useDashboardStore()
const nowTick = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  void store.refresh()
  timer = setInterval(() => { nowTick.value = Date.now() }, 60_000)
})
onUnmounted(() => { if (timer !== undefined) clearInterval(timer) })

const dateLabel = computed(() =>
  new Date(nowTick.value).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
)

function goToJob(jobId: number): void {
  void router.push({ name: 'job-detail', params: { id: String(jobId) } })
}

function goToHistory(): void {
  void router.push({ name: 'history' })
}
</script>
<template>
  <div class="wrap">
    <div class="topbar">
      <h1>Dashboard</h1><span class="grow" />
      <span class="date muted">{{ dateLabel }} · local time</span>
    </div>
    <template v-if="store.loading">
      <div class="body"><SkeletonRows :count="4" /></div>
    </template>
    <template v-else-if="!store.summary && store.error">
      <div class="body">
        <p class="state-msg error">
          Couldn't load dashboard: {{ store.error }}
          <button class="btn" type="button" data-test="retry" @click="store.refresh()">Retry</button>
        </p>
      </div>
    </template>
    <template v-else-if="store.summary">
      <p v-if="store.error" class="banner error" data-test="error-banner">
        Couldn't refresh dashboard: {{ store.error }}
        <button class="btn" type="button" data-test="retry" @click="store.refresh()">Retry</button>
      </p>
      <div class="tiles">
        <div class="tile" data-test="tile-runs">
          <div class="num">{{ store.summary.runsToday }}</div>
          <div class="label">Runs today</div>
        </div>
        <div class="tile succeeded" data-test="tile-succeeded">
          <div class="num">{{ store.summary.succeededToday }}</div>
          <div class="label">Succeeded</div>
        </div>
        <div class="tile" data-test="tile-failed" :class="{ danger: store.summary.failedToday > 0 }">
          <div class="num">{{ store.summary.failedToday }}</div>
          <div class="label">Failed</div>
        </div>
        <div class="tile" data-test="tile-active">
          <div class="num">{{ store.summary.activeJobs }}</div>
          <div class="label">Active jobs</div>
        </div>
      </div>
      <div class="cols">
        <div class="card">
          <div class="chead">
            <h2>Failures today</h2>
            <span class="count-badge" data-test="failures-badge">{{ store.summary.failuresTotal }}</span>
            <span class="grow" />
            <RouterLink :to="{ name: 'history' }" class="hist-link" data-test="history-link">Run History ›</RouterLink>
          </div>
          <template v-if="store.summary.failures.length === 0">
            <p class="state-msg muted">No failures today ✓</p>
          </template>
          <template v-else>
            <div
              v-for="f in store.summary.failures"
              :key="`${f.jobId}-${f.startedAt}`"
              class="frow"
              data-test="failure-row"
              role="button"
              tabindex="0"
              @click="goToJob(f.jobId)"
              @keydown.enter="goToJob(f.jobId)"
              @keydown.space.prevent="goToJob(f.jobId)"
            >
              <StatusDot :status="f.result === 'timeout' ? 'warn' : 'fail'" />
              <span class="name">{{ f.jobName }}</span>
              <span class="badge">{{ f.result === 'timeout' ? 'timeout' : `exit ${f.exitCode ?? '—'}` }}</span>
              <span class="time">{{ hhmm(f.startedAt) }} · {{ f.durationMs != null ? formatDuration(f.durationMs) : '—' }}</span>
            </div>
            <p v-if="store.summary.failuresTotal > DASHBOARD_FAILURES_LIMIT" class="more">
              <a href="#" @click.prevent="goToHistory">View all {{ store.summary.failuresTotal }} in Run History</a>
            </p>
          </template>
        </div>
        <div class="card">
          <h2>Upcoming runs</h2>
          <template v-if="store.summary.upcoming.length === 0">
            <p class="state-msg muted">No upcoming runs</p>
          </template>
          <template v-else>
            <div v-for="u in store.summary.upcoming" :key="u.jobId" class="urow">
              <span class="name">{{ u.jobName }}</span>
              <span class="sched" data-test="upcoming-sched" :title="cronToHuman(u.scheduleExpr)">{{ u.scheduleExpr }}</span>
              <span class="when">{{ upcomingLabel(u.nextRunAt, nowTick) }}</span>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>
<style scoped>
.wrap{flex:1;display:flex;flex-direction:column;min-width:0}
.topbar{display:flex;align-items:center;gap:10px;padding:var(--p-space-3) var(--p-space-4);border-bottom:1px solid var(--color-border);background:var(--color-surface)}
.topbar h1{font-size:15px;margin:0}.grow{flex:1}.muted{color:var(--color-text-muted);font-size:12px}
.body{padding:var(--p-space-4)}
.state-msg{padding:var(--p-space-4);font-size:13px;margin:0}
.state-msg.muted{color:var(--color-text-muted);text-align:center;padding:24px}
.state-msg.error{color:var(--color-danger)}
.banner{margin:var(--p-space-3) var(--p-space-4) 0;padding:8px 12px;border-radius:var(--p-radius);font-size:12.5px}
.banner.error{background:var(--color-code-bg);color:var(--color-danger-text);border:1px solid var(--color-danger)}
.btn{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--p-radius);padding:5px 10px;font-size:12px;cursor:pointer;margin-left:8px}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:var(--p-space-3);padding:var(--p-space-4)}
.tile{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--p-radius);padding:var(--p-space-3);text-align:center}
.tile.danger .num{color:var(--color-danger-text)}
.tile.succeeded .num{color:var(--color-ok-text)}
.tile .num{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}
.tile .label{font-size:11.5px;color:var(--color-text-muted);margin-top:2px}
.cols{display:grid;grid-template-columns:1.2fr 1fr;gap:var(--p-space-3);padding:0 var(--p-space-4) var(--p-space-4)}
.card{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--p-radius);padding:var(--p-space-3)}
.card h2{font-size:12px;margin:0 0 var(--p-space-2);color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.05em}
.chead{display:flex;align-items:center;gap:8px;margin:0 0 var(--p-space-2)}
.chead h2{margin:0}
.count-badge{background:rgba(var(--color-primary-rgb),.12);color:var(--color-primary);border-radius:20px;font-size:10.5px;font-weight:600;padding:1px 7px;font-variant-numeric:tabular-nums}
.hist-link{color:var(--color-primary);font-size:11px;text-decoration:none}
.hist-link:hover{text-decoration:underline}
.frow{display:flex;align-items:center;gap:9px;padding:7px 6px;border-radius:var(--p-radius);cursor:pointer}
.frow:hover{background:rgba(var(--color-primary-rgb),.12)}
.frow:focus-visible{outline:2px solid var(--color-primary);outline-offset:-2px}
.frow .name{flex:1;font-weight:600;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.frow .badge{font-family:var(--p-font-mono);font-size:10.5px;background:var(--color-code-bg);color:var(--color-danger-text);border-radius:var(--p-radius);padding:2px 6px}
.frow .time{font-size:11px;color:var(--color-text-muted);flex:0 0 auto;font-variant-numeric:tabular-nums}
.more{margin:var(--p-space-2) 0 0;font-size:12px;text-align:center}
.more a{color:var(--color-primary);text-decoration:none;cursor:pointer}
.more a:hover{text-decoration:underline}
.urow{display:flex;align-items:center;gap:9px;padding:7px 6px}
.urow .name{flex:1;font-weight:600;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.urow .sched{font-family:var(--p-font-mono);font-size:10.5px;color:var(--color-text-muted)}
.urow .when{font-size:11.5px;color:var(--color-text-muted);flex:0 0 auto;font-variant-numeric:tabular-nums}
</style>
