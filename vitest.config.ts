// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // The Vue plugin compiles single-file components so renderer component tests
  // (e.g. App.vue) can be mounted with @vue/test-utils.
  plugins: [vue()],
  test: {
    // Default to Node; jsdom is opted into per-file via `// @vitest-environment jsdom`.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    alias: {
      // Stub the Electron runtime for unit tests — only the Node-safe exports
      // needed by tests are provided here; the real Electron APIs run inside the
      // Electron process and cannot be imported in a plain Node/vitest context.
      electron: resolve(__dirname, 'src/__mocks__/electron.ts')
    }
  }
})
