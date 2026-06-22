// SPDX-License-Identifier: Apache-2.0
import js from '@eslint/js'
import ts from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default [
  // ── Ignored paths ──────────────────────────────────────────────────────────
  { ignores: ['out/**', 'dist/**', 'node_modules/**', '.vite/**', 'coverage/**'] },

  // ── Base JS + TS rules ─────────────────────────────────────────────────────
  js.configs.recommended,
  ...ts.configs.recommended,

  // ── Vue SFC rules ──────────────────────────────────────────────────────────
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: ts.parser } }
  },

  // ── Node globals: main process, preload, config files, tests, scripts ────────
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'src/__mocks__/**/*.ts',
      'electron.vite.config.ts',
      'vitest.config.ts',
      'eslint.config.js',
      'tests/**/*.ts',
      'scripts/**/*.mjs',
      'scripts/**/*.js'
    ],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },

  // ── Browser globals: renderer source files ─────────────────────────────────
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.vue'],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },

  // ── Shared source (runs in both contexts — allow both sets) ────────────────
  {
    files: ['src/shared/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },

  // ── Rule overrides ─────────────────────────────────────────────────────────
  // Parameters prefixed with _ are intentionally unused (e.g. stubs / mocks).
  // This is the standard TypeScript convention; we configure the rule to honour it
  // rather than disabling the rule entirely.
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },

  // ── Prettier compat (disables formatting rules that conflict with Prettier) ─
  prettier
]
