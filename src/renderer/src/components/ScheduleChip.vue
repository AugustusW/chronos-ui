<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
defineProps<{ kind: 'wrapped' | 'unmanaged' | 'plain'; label: string }>()
</script>
<template><span class="chip" :class="kind">{{ label }}</span></template>
<style scoped>
.chip{font-size:10px;padding:1px 7px;border-radius:20px;border:1px solid var(--color-border);color:var(--color-text-muted);font-weight:500}
.wrapped{background:rgba(var(--color-primary-rgb),.12);border-color:transparent;color:var(--color-primary)}
</style>
