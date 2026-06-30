<!-- SettingsView.vue · SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { onMounted } from 'vue'
import ThemeToggle from '../components/ThemeToggle.vue'
import { useNotifyStore } from '../stores/notify.store'
const n = useNotifyStore()
onMounted(() => n.load())
</script>
<template>
  <div class="settings">
    <h1>Settings</h1>
    <section><h2>Appearance</h2><div class="row">Theme <ThemeToggle /></div></section>
    <section><h2>Database</h2><div class="row muted">SQLite — managed in userData/chronos.db (Postgres: v1.1)</div></section>
    <section>
      <h2>Notifications (Telegram)</h2>
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
  </div>
</template>
<style scoped>
.settings{padding:var(--p-space-4) var(--p-space-4);max-width:640px}
h1{font-size:16px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--color-text-muted);margin-top:var(--p-space-4)}
.row{display:flex;align-items:center;gap:10px;padding:8px 0}.muted{color:var(--color-text-muted)}
.err{color:var(--color-danger)}
.warn{color:var(--color-warn-text);font-size:12px;line-height:1.4}
input[type=text],input[type=password],input[type=number]{flex:1;min-width:0}
</style>
