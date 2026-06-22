<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
defineProps<{ status: 'ok' | 'fail' | 'warn' | 'off' | 'running' }>()
</script>
<template><span class="dot" :class="status" :title="status" /></template>
<style scoped>
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:0 0 9px}
.ok{background:var(--color-ok)}.fail{background:var(--color-danger)}.warn{background:var(--color-warn)}
.off{background:var(--color-off)}.running{background:var(--color-primary)}
</style>
