// SPDX-License-Identifier: Apache-2.0
export const THEMES = ['light', 'dark'] as const
export type ThemeName = (typeof THEMES)[number]

const STORAGE_KEY = 'chronos.theme'
const DEFAULT: ThemeName = 'light'

export function getStoredTheme(): ThemeName {
  const v = localStorage.getItem(STORAGE_KEY)
  return (THEMES as readonly string[]).includes(v ?? '') ? (v as ThemeName) : DEFAULT
}

export function applyTheme(name: ThemeName): void {
  document.documentElement.setAttribute('data-theme', name)
  localStorage.setItem(STORAGE_KEY, name)
}
