<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
withDefaults(defineProps<{ count?: number }>(), { count: 4 })
</script>
<template><div><div v-for="n in count" :key="n" class="sk-row" /></div></template>
<style scoped>
.sk-row{height:50px;border-radius:var(--p-radius);margin-bottom:8px;background:linear-gradient(90deg,var(--color-shimmer-base) 25%,var(--color-shimmer-highlight) 37%,var(--color-shimmer-base) 63%);background-size:400% 100%;animation:sh 1.4s ease infinite}
@keyframes sh{0%{background-position:100% 0}100%{background-position:0 0}}
</style>
