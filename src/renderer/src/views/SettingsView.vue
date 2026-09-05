<!-- SettingsView.vue · SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ThemeToggle from '../components/ThemeToggle.vue'
import ImportPreviewDialog from '../components/ImportPreviewDialog.vue'
import TeardownDialog from '../components/TeardownDialog.vue'
import { useScheduleStore } from '../stores/schedule.store'
import { hostPlatform, schedulerLabel } from '../lib/scheduler-label'
const nativeScheduler = computed(() => schedulerLabel(hostPlatform()))
import { useNotifyStore } from '../stores/notify.store'
import { useDbSettingsStore } from '../stores/dbsettings.store'
import { api } from '../ipc/api'
import type { ImportPreview } from '../../../shared/ipc-contract'
const n = useNotifyStore()
const db = useDbSettingsStore()
const sched = useScheduleStore()
onMounted(() => { n.load(); db.load() })

const BACKEND_LABEL: Record<'sqlite' | 'postgres', string> = { sqlite: 'SQLite', postgres: 'PostgreSQL' }

async function confirmSwitch(): Promise<void> {
  if (!window.confirm('Switch the database backend? The app will restart to apply the change.')) return
  await db.saveSwitch()
}

// v0.4.0: YAML job import/export
const exportStatus = ref<string | null>(null)
const importPreview = ref<ImportPreview | null>(null)
const importOpen = ref(false)
const importApplying = ref(false)
const importStatus = ref<string | null>(null)

async function exportAllJobs(): Promise<void> {
  exportStatus.value = null
  const r = await api.exportJobsYaml()
  if (r.status === 'ok') exportStatus.value = `Exported to ${r.path} ✓`
  else if (r.status === 'error') exportStatus.value = `Export failed: ${r.error}`
}

async function startImport(): Promise<void> {
  importStatus.value = null
  const r = await api.importJobsPreview()
  if (r.status === 'ok') {
    importPreview.value = r.preview
    importOpen.value = true
  } else if (r.status === 'error') {
    importStatus.value = `Import failed: ${r.error}`
  }
}

async function confirmImport(): Promise<void> {
  if (!importPreview.value) return
  importApplying.value = true
  try {
    const entries = importPreview.value.entries.map((d) => d.entry)
    const r = await api.importJobsApply(entries)
    importStatus.value = r.ok
      ? `Imported ✓ — ${r.created} created, ${r.updated} updated`
      : `Imported with errors — ${r.created} created, ${r.updated} updated, ${r.errors.length} failed: ${r.errors.join('; ')}`
    importOpen.value = false
    importPreview.value = null
  } finally {
    importApplying.value = false
  }
}

function cancelImport(): void {
  importOpen.value = false
  importPreview.value = null
}
// --- Teardown (Remove ChronosUI) -------------------------------------------------------------
const teardownOpen = ref(false)
const teardownCounting = ref(false)
const teardownBusy = ref(false)
const teardownError = ref<string | null>(null)
const teardownNotice = ref<string | null>(null)

const adoptedCount = computed(() => sched.items.filter((i) => i.job?.adopted).length)
const createdCount = computed(() => sched.items.filter((i) => i.job && !i.job.adopted).length)

async function openTeardown(): Promise<void> {
  teardownError.value = null
  teardownOpen.value = true
  // Settings can be the first screen someone opens. Without this the dialog would confidently say
  // "0 jobs" when the truth is "nothing has been scanned yet" — a wrong number is worse than a wait.
  if (!sched.hasScanned) {
    teardownCounting.value = true
    try {
      await sched.refresh()
    } finally {
      teardownCounting.value = false
    }
  }
}

async function confirmTeardown(deleteData: boolean): Promise<void> {
  teardownBusy.value = true
  teardownError.value = null
  teardownNotice.value = null
  try {
    const r = await api.teardown(deleteData)
    teardownOpen.value = false
    if (!r.ok) {
      teardownError.value = r.error ?? 'Teardown failed.'
      return
    }
    // A fully clean teardown quits the app, so nothing below renders. If anything was left behind the
    // main process deliberately stays alive — this is the only surface that can report it.
    const notes: string[] = []
    if (r.skipped.length) {
      notes.push(`${r.skipped.length} job(s) were already gone from the scheduler and were left alone.`)
    }
    if (r.deleteFailed.length) {
      notes.push(`Could not delete: ${r.deleteFailed.join(', ')}. Remove them by hand after quitting.`)
    }
    if (notes.length) {
      teardownNotice.value = `${notes.join(' ')} Everything else was released; quit the app when ready.`
      await sched.refresh()
    }
  } finally {
    teardownBusy.value = false
  }
}
</script>
<template>
  <div class="settings">
    <h1>Settings</h1>
    <section><h2>Appearance</h2><div class="row">Theme <ThemeToggle /></div></section>
    <section>
      <h2>Database</h2>
      <div class="row segmented">
        <button
          data-test="db-backend-sqlite"
          :class="{ active: db.selectedBackend === 'sqlite' }"
          @click="db.selectBackend('sqlite')"
        >SQLite</button>
        <button
          data-test="db-backend-postgres"
          :class="{ active: db.selectedBackend === 'postgres' }"
          @click="db.selectBackend('postgres')"
        >PostgreSQL</button>
        <span class="muted" data-test="db-active-badge">Active: {{ BACKEND_LABEL[db.status.activeBackend] }}</span>
      </div>

      <div v-if="db.selectedBackend === 'sqlite' && db.status.activeBackend === 'sqlite'" class="row muted" data-test="db-sqlite-info">
        SQLite — managed in userData/chronos.db
      </div>

      <template v-else-if="db.selectedBackend === 'postgres'">
        <label class="row">Host <input v-model="db.fields.host" data-test="db-host" type="text" /></label>
        <label class="row">Port <input v-model.number="db.fields.port" data-test="db-port" type="number" /></label>
        <label class="row">Database <input v-model="db.fields.database" data-test="db-database" type="text" /></label>
        <label class="row">User <input v-model="db.fields.user" data-test="db-user" type="text" /></label>
        <label class="row">Password <input v-model="db.fields.password" data-test="db-password" type="password" /></label>
        <label class="row">SSL mode
          <select v-model="db.fields.sslmode" data-test="db-sslmode">
            <option value="disable">disable</option>
            <option value="require">require</option>
            <option value="verify-full">verify-full</option>
          </select>
        </label>
        <div class="row">
          <button data-test="db-test" :disabled="db.testing" @click="db.test()">Test connection</button>
          <button data-test="db-save-switch" :disabled="db.switching" @click="confirmSwitch()">Save &amp; switch</button>
        </div>
        <div v-if="db.testResult" class="row" :class="db.testResult.ok ? 'ok' : 'err'" data-test="db-test-result">
          {{ db.testResult.ok ? `Connection OK — ${db.testResult.version} (${db.testResult.ms} ms)` : `Connection failed — ${db.testResult.error}` }}
        </div>
        <div v-if="db.status.keychainAvailable" class="row muted" data-test="db-keychain-note">
          Credentials are stored in the OS keychain and shared with the schedule runner. They never appear in {{ nativeScheduler }} entries or config files.
        </div>
        <div v-else class="row warn" data-test="db-keychain-warn">
          No OS keychain is available on this platform. The connection string will be stored in a file readable only by this user account (0600).
        </div>
        <label class="row"><input v-model="db.copyData" data-test="db-copydata" type="checkbox" /> Copy existing SQLite data to PostgreSQL</label>
        <div class="row muted">Jobs, run history and notification settings are copied on switch. The current chronos.db file is kept untouched as a backup. Unchecked = start empty.</div>
        <div class="row muted" data-test="db-switch-note">Switching re-writes the managed {{ nativeScheduler }} entries so scheduled runs record to PostgreSQL. This is reversible from the same panel.</div>
      </template>

      <template v-else>
        <div class="row muted" data-test="db-switch-note">Switching re-writes the managed {{ nativeScheduler }} entries so scheduled runs record to PostgreSQL. This is reversible from the same panel.</div>
        <div class="row"><button data-test="db-save-switch" :disabled="db.switching" @click="confirmSwitch()">Save &amp; switch</button></div>
      </template>

      <div v-if="db.error" class="row err" data-test="db-error">{{ db.error }}</div>
    </section>
    <section>
      <h2>Notifications (Telegram)</h2>
      <label class="row"><input v-model="n.nativeEnabled" data-test="notify-native-enable" type="checkbox" /> Native failure notifications</label>
      <div class="row muted">A macOS notification when a scheduled job fails — independent of Telegram below, and only for background runs (not ones you start manually, since you're already watching those).</div>
      <label class="row"><input v-model="n.enabled" data-test="notify-enable" type="checkbox" /> Enable Telegram notifications</label>
      <label class="row">Bot token <input v-model="n.token" data-test="notify-token" type="password" :placeholder="n.tokenSet ? '•••••• (saved)' : 'paste bot token'" /></label>
      <div v-if="n.tokenStorage === 'file'" class="row warn" data-test="notify-token-storage-warn">⚠️ This token is stored unencrypted on disk (your OS keychain is unavailable on this platform). Anyone with access to your user account can read it.</div>
      <label class="row">Chat id <input v-model="n.chatId" data-test="notify-chat" type="text" placeholder="e.g. 123456789" /></label>
      <label class="row">Batch window (min) <input v-model.number="n.windowMin" data-test="notify-window" type="number" min="0" /> <span class="muted">(0 = immediate)</span></label>
      <label class="row"><input v-model="n.includeStderr" data-test="notify-include-stderr" type="checkbox" /> Include the failed job's error output (stderr) in immediate alerts</label>
      <div v-if="n.includeStderr" class="row warn" data-test="notify-stderr-warn">⚠️ stderr can contain secrets, tokens or file paths — these will be sent to your Telegram chat. Only enable for chats you control.</div>
      <div class="row">
        <button data-test="notify-save" :disabled="n.saving" @click="n.save()">Save</button>
        <button data-test="notify-test" :disabled="n.testing" @click="n.test()">Send test message</button>
      </div>
      <div v-if="n.testResult" class="row muted" data-test="notify-test-result">{{ n.testResult }}</div>
      <div v-if="n.error" class="row err">{{ n.error }}</div>
      <p class="row muted">Create a bot with @BotFather; get your chat id from @userinfobot.</p>
    </section>
    <section>
      <h2>Job Definitions</h2>
      <div class="row">
        <button data-test="export-all-jobs" @click="exportAllJobs">Export all jobs to YAML…</button>
        <button data-test="import-jobs" @click="startImport">Import from YAML…</button>
      </div>
      <div class="row muted">
        Export writes every job's schedule, command and settings to a YAML file — not run history or
        Telegram/notification settings. Import previews new/changed/unchanged jobs and asks for
        confirmation before applying anything.
      </div>
      <div v-if="exportStatus" class="row muted" data-test="export-status">{{ exportStatus }}</div>
      <div v-if="importStatus" class="row muted" data-test="import-status">{{ importStatus }}</div>
    </section>
    <section>
      <h2>Remove ChronosUI</h2>
      <div class="row muted">
        Hands every job back to the native scheduler and removes everything ChronosUI added, so
        nothing breaks after the app is deleted. Do this before dragging the app to the trash.
      </div>
      <div class="row">
        <button class="danger" data-teardown-open @click="openTeardown">Remove ChronosUI…</button>
      </div>
      <div v-if="teardownError" class="row err" data-teardown-error>{{ teardownError }}</div>
      <div v-if="teardownNotice" class="row warn" data-teardown-notice>{{ teardownNotice }}</div>
    </section>
    <TeardownDialog
      :open="teardownOpen" :adopted-count="adoptedCount" :created-count="createdCount"
      :counting="teardownCounting" :busy="teardownBusy"
      @confirm="confirmTeardown" @cancel="teardownOpen = false"
    />
    <ImportPreviewDialog
      :open="importOpen" :preview="importPreview" :applying="importApplying"
      @confirm="confirmImport" @cancel="cancelImport"
    />
  </div>
</template>
<style scoped>
.settings{padding:var(--p-space-4) var(--p-space-4);max-width:640px}
h1{font-size:16px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--color-text-muted);margin-top:var(--p-space-4)}
.row{display:flex;align-items:center;gap:10px;padding:8px 0}.muted{color:var(--color-text-muted)}
.err{color:var(--color-danger)}
button.danger{color:var(--color-danger);border-color:var(--color-danger)}
.ok{color:var(--color-ok-text)}
.warn{color:var(--color-warn-text);font-size:12px;line-height:1.4}
input[type=text],input[type=password],input[type=number],select{flex:1;min-width:0}
.segmented button{border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);padding:4px 12px;cursor:pointer}
.segmented button.active{background:rgba(var(--color-primary-rgb),.12);border-color:var(--color-primary);color:var(--color-primary)}
</style>
