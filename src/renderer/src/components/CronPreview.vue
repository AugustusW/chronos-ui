<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { computed } from 'vue'
import { cronToHuman } from '../lib/format'
const props = defineProps<{ expr: string }>()
const human = computed(() => cronToHuman(props.expr))
</script>
<template><div class="preview">▸ {{ human }}</div></template>
<style scoped>
.preview{font-size:12px;color:var(--color-primary);background:rgba(var(--color-primary-rgb),.12);border-radius:var(--p-radius);padding:6px 10px}
</style>
