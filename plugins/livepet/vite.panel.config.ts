// ---------------------------------------------------------------------------
// 桌宠 mod — 设置面板 bundle
//
// 和 orb 一样是自包含 IIFE（页面用普通 <script> 加载），但多一条：面板要能打字，
// 所以它由宿主用 focusable 窗口打开。
//
// `vite build --config mods/livepet/vite.panel.config.ts`
// ---------------------------------------------------------------------------

import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const modRoot = __dirname
const repoRoot = resolve(modRoot, '..', '..')

export default defineConfig({
  root: modRoot,
  publicDir: false,
  resolve: {
    alias: [{ find: '@shared', replacement: resolve(repoRoot, 'src/shared') }]
  },
  define: {
    'process.env.NODE_ENV': '"production"'
  },
  build: {
    outDir: resolve(modRoot, 'dist/panel'),
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'esnext',
    assetsInlineLimit: 16 * 1024 * 1024,
    chunkSizeWarningLimit: 8192,
    lib: {
      entry: resolve(modRoot, 'src/panel.ts'),
      formats: ['iife'],
      name: 'DolaPetPanel',
      fileName: () => 'index.js'
    },
    rollupOptions: {
      output: { exports: 'none' },
      external: []
    }
  }
})
