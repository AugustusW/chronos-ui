import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      viteStaticCopy({
        targets: [
          {
            // Copy the entire migrations folder (*.sql + meta/_journal.json + snapshots)
            // into out/main/migrations so that resolveMigrationsPath() can find them
            // in a packaged (asar-unpacked) build. Using '**/*' ensures the meta/
            // subfolder is included — drizzle-orm's migrate() requires meta/_journal.json
            // to know which SQL files to apply and in what order.
            src: 'src/main/db/migrations/**/*',
            dest: 'migrations'
          }
        ]
      })
    ],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // Force CommonJS output: this package is `"type": "module"`, so electron-vite
        // would otherwise emit an ESM `.mjs` preload. Electron's sandboxed preload
        // scripts cannot be ESM, and the app enables `sandbox: true`, so the preload
        // must be CJS (emitted as `index.cjs`, referenced from the main process).
        output: { format: 'cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [vue()],
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } }
  }
})
