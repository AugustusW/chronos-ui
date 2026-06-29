<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import type { JobListItem } from '../../../shared/ipc-contract'
import { cronToHuman, relativeTime } from '../lib/format'
import StatusDot from './StatusDot.vue'
import ScheduleChip from './ScheduleChip.vue'
const props = defineProps<{ item: JobListItem; selectMode: boolean; selected: boolean; running: boolean }>()
const emit = defineEmits<{ run: []; 'toggle-select': []; edit: []; adopt: []; 'open-detail': [] }>()
const dotStatus = (): 'ok' | 'fail' | 'warn' | 'off' | 'running' => {
  if (props.running) return 'running'
  if (props.item.status === 'unmanaged') return 'off'
  const j0 = props.item.job
  if (!j0?.enabled) return 'off'
  return j0.lastResult === 'failure' ? 'fail' : j0.lastResult === 'timeout' ? 'warn' : 'ok'
}
const chipKind = (): 'wrapped' | 'unmanaged' | 'plain' =>
  props.item.status === 'unmanaged' ? 'unmanaged' : props.item.job?.adopted ? 'wrapped' : 'plain'
const chipLabel = (): string => (chipKind() === 'wrapped' ? 'wrapped' : chipKind() === 'unmanaged' ? 'unmanaged' : 'not wrapped')
</script>
<template>
  <div class="row" :class="{ sel: selected }">
    <input v-if="selectMode" type="checkbox" :checked="selected" aria-label="select job" @change="emit('toggle-select')" />
    <StatusDot :status="dotStatus()" />
    <div class="meta" data-detail role="button" tabindex="0" @click="emit('open-detail')" @keydown.enter="emit('open-detail')" @keydown.space.prevent="emit('open-detail')">
      <div class="name">{{ item.job?.name ?? item.native?.name ?? '' }}
        <ScheduleChip :kind="chipKind()" :label="chipLabel()" />
      </div>
      <div class="cmd">{{ item.job?.command ?? item.native?.command }}</div>
    </div>
    <div class="sched">
      <div class="h">{{ cronToHuman(item.job?.scheduleExpr ?? item.native?.scheduleExpr ?? '') }}</div>
      <div class="raw">{{ item.job?.scheduleExpr ?? item.native?.scheduleExpr }}</div>
    </div>
    <div class="last">
      <span v-if="running" data-running class="spin" /> {{ running ? 'running…' : (item.job?.lastRunAt ? relativeTime(+item.job.lastRunAt) : '—') }}
    </div>
    <div class="acts">
      <button v-if="item.job" data-run class="btn" type="button" @click="emit('run')">▶ Run</button>
      <button v-if="item.status === 'unmanaged'" class="btn" type="button" @click="emit('adopt')">Adopt</button>
      <button v-else class="btn" type="button" @click="emit('edit')">⋯</button>
    </div>
  </div>
</template>
<style scoped>
.row{display:flex;align-items:center;gap:11px;padding:9px var(--p-space-3);background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--p-radius);margin-bottom:7px}
.row.sel{outline:2px solid var(--color-primary);outline-offset:-1px}
.meta{min-width:0;flex:1;cursor:pointer}.meta:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px;border-radius:var(--p-radius)}.name{font-weight:600;display:flex;gap:8px;align-items:center;font-size:13px}
.cmd{font-family:var(--p-font-mono);font-size:11px;color:var(--color-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.sched{flex:0 0 150px}.sched .raw{font-family:var(--p-font-mono);font-size:10.5px;color:var(--color-text-muted)}
.last{flex:0 0 130px;font-size:11.5px;color:var(--color-text-muted);font-variant-numeric:tabular-nums}
.acts{display:flex;gap:6px}.btn{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--p-radius);padding:5px 9px;font-size:11.5px;cursor:pointer}
.spin{display:inline-block;width:11px;height:11px;border:2px solid rgba(var(--color-primary-rgb),.35);border-top-color:var(--color-primary);border-radius:50%;animation:sp .8s linear infinite;vertical-align:-1px}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
