import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { buildCspContent } from './src/main/window-security'

// Inject a strict Content-Security-Policy <meta> into the packaged renderer (code review #2). The
// renderer loads over file:// in production, where session.webRequest.onHeadersReceived never fires,
// so a build-time <meta> is the reliable delivery. Build-only (`apply: 'build'`): the Vite dev server
// needs inline scripts + ws: for HMR, which a strict CSP would block.
const injectCsp = {
  name: 'chronos-inject-csp',
  apply: 'build' as const,
  transformIndexHtml(html: string): string {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${buildCspContent()}" />`
    return html.replace('</head>', `    ${meta}\n  </head>`)
  }
}

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
          },
          {
            // Postgres migration set (per-dialect). resolveMigrationsPaths() picks the
            // matching folder at runtime based on the active backend.
            src: 'src/main/db/migrations.pg/**/*',
            dest: 'migrations.pg'
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
    plugins: [vue(), injectCsp],
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } }
  }
})
