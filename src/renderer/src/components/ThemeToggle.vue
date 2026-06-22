<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ref } from 'vue'
import { applyTheme, getStoredTheme, type ThemeName } from '../lib/theme'
const theme = ref<ThemeName>(getStoredTheme())
function toggle(): void {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
  applyTheme(theme.value)
}
</script>
<template>
  <button class="theme-toggle" type="button" :aria-label="`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`" @click="toggle">
    {{ theme === 'light' ? '🌙' : '☀️' }}
  </button>
</template>
<style scoped>
.theme-toggle{background:var(--color-bg);color:var(--color-text);border:1px solid var(--nav-border);border-radius:var(--p-radius);padding:5px 9px;cursor:pointer}
</style>
