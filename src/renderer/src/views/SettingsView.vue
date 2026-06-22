<!-- SettingsView.vue · SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import ThemeToggle from '../components/ThemeToggle.vue'
</script>
<template>
  <div class="settings">
    <h1>Settings</h1>
    <section><h2>Appearance</h2><div class="row">Theme <ThemeToggle /></div></section>
    <section><h2>Database</h2><div class="row muted">SQLite — managed in userData/chronos.db (Postgres: v1.1)</div></section>
  </div>
</template>
<style scoped>
.settings{padding:var(--p-space-4) var(--p-space-4);max-width:640px}
h1{font-size:16px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--color-text-muted);margin-top:var(--p-space-4)}
.row{display:flex;align-items:center;gap:10px;padding:8px 0}.muted{color:var(--color-text-muted)}
</style>
