// ---------------------------------------------------------------------------
// 代理 mod — 主进程 bundle 构建配置
//
// The renderer half is built by vite.config.ts (IIFE, React from the host bridge). This
// config builds the *main-process* half into `dist/main/index.js`, which the app loads as
// a mod service: `mods/<id>/main/index.js` exporting `register(dola)`.
//
// Output is CommonJS because it is required from the main process, and everything that
// belongs to Electron or to Node is left external.
// ---------------------------------------------------------------------------

import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const modRoot = __dirname
const repoRoot = resolve(modRoot, '..', '..')
/** the application checkout, for shared types/constants */
const appRoot = resolve(repoRoot, '..', 'dola-toolkit')

export default defineConfig({
  root: modRoot,
  publicDir: false,
  resolve: {
    alias: [
      { find: '@shared', replacement: resolve(appRoot, 'src/shared') }
    ]
  },
  build: {
    outDir: resolve(modRoot, 'dist/main'),
    emptyOutDir: true,
    minify: false,
    target: 'node20',
    lib: {
      entry: resolve(modRoot, 'main/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.js'
    },
    rollupOptions: {
      // Electron and Node built-ins are provided by the host process
      external: [/^electron/, /^node:/, 'fs', 'path', 'child_process', 'crypto', 'http', 'net', 'os', 'url']
    }
  }
})
