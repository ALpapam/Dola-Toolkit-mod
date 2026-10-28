// ---------------------------------------------------------------------------
// hello mod 构建配置 —— 产出单个 IIFE bundle：dist/index.js
//
// 在 example-hello 目录里执行：
//   npm run build                 # 装了依赖之后
//   node <宿主仓库>/node_modules/vite/bin/vite.js build   # 复用宿主的 vite
//
// 关键点：
//   * lib.formats = ['iife']：没有 import/export、没有 chunk 加载，宿主用 <script> 直接跑
//   * react / react-dom / jsx-runtime 被别名到 src/shims/*，运行期读 window.__DOLA__，
//     所以 bundle 里一份 React 都没有（这是硬性要求，不是体积优化）
//   * 别名必须写成精确正则 /^react$/，否则会把 react-dom、react/jsx-runtime 一起吞掉
//   * assetsInlineLimit 拉大：IIFE 没有独立的资源加载路径，图片/worker 全部内联成 data URL
// ---------------------------------------------------------------------------

import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Node 20.11+ 的 ESM 才有 import.meta.dirname；modRoot === example-hello/
// （如果你把这份配置搬到 CJS 环境，换成 __dirname 即可）
const modRoot = import.meta.dirname

export default defineConfig({
  root: modRoot,
  // 没有 index.html，也不需要 public/
  publicDir: false,
  resolve: {
    alias: [
      { find: /^react$/, replacement: resolve(modRoot, 'src/shims/react.ts') },
      { find: /^react\/jsx-runtime$/, replacement: resolve(modRoot, 'src/shims/react-jsx-runtime.ts') },
      { find: /^react\/jsx-dev-runtime$/, replacement: resolve(modRoot, 'src/shims/react-jsx-runtime.ts') },
      { find: /^react-dom$/, replacement: resolve(modRoot, 'src/shims/react-dom.ts') },
      { find: /^react-dom\/client$/, replacement: resolve(modRoot, 'src/shims/react-dom-client.ts') }
    ]
  },
  define: {
    'process.env.NODE_ENV': '"production"'
  },
  build: {
    outDir: resolve(modRoot, 'dist'),
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'esnext',
    assetsInlineLimit: 16 * 1024 * 1024,
    chunkSizeWarningLimit: 8192,
    lib: {
      entry: resolve(modRoot, 'src/index.tsx'),
      formats: ['iife'],
      // 这个名字只会出现在 window.DolaMod_hello 上（一旦显式注册 __DOLA_MODS__ 就用不到它，
      // 但 IIFE 格式要求有名字）
      name: 'DolaMod_hello',
      fileName: () => 'index.js'
    },
    rollupOptions: {
      output: {
        // IIFE 没有代码分割；named 保持模块对象形状并消掉 mixed exports 警告
        exports: 'named'
      }
    }
  }
})
