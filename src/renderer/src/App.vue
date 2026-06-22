<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { onMounted } from 'vue'
import NavSidebar from './components/NavSidebar.vue'
import { applyTheme, getStoredTheme } from './lib/theme'
onMounted(() => applyTheme(getStoredTheme()))
</script>
<template>
  <div class="app"><NavSidebar /><main class="content"><RouterView /></main></div>
</template>
<style scoped>
.app{display:flex;height:100%}
.content{flex:1;min-width:0;display:flex;flex-direction:column}
</style>
