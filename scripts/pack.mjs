#!/usr/bin/env node
// ---------------------------------------------------------------------------
// 把一个已构建的插件目录打成可安装的 zip。
//
//   node scripts/pack.mjs hello
//   → mods/hello-1.0.0.zip，根目录是 dola-mod.json + index.js
//
// 为什么要脚本：zip 的**根目录**必须直接是 dola-mod.json 和入口 js。
// 直接 `Compress-Archive -Path example-hello\*` 会把 src/、dist/、node_modules 一起打进去，
// 入口也变成 dist/index.js，装上去就是「插件缺少入口文件 index.js」。
//
// 依赖：Windows 自带的 bsdtar（C:\Windows\System32\tar.exe），宿主解包用的也是它。
// 任何能生成标准 zip 的工具都可以替代，见 README「打包」一节。
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')

/** 插件 id → 相对仓库根的源码目录。新增插件时在这里登记一行。 */
const MODS = {
  hello: 'example-hello'
}

function fail(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}

const arg = process.argv[2]
if (!arg) fail(`用法：node scripts/pack.mjs <id>\n可选：${Object.keys(MODS).join(', ')}`)

const rel = MODS[arg]
if (!rel) fail(`未知插件 id "${arg}"，可选：${Object.keys(MODS).join(', ')}`)

const modRoot = join(repoRoot, rel)
const manifestPath = join(modRoot, 'dola-mod.json')
if (!existsSync(manifestPath)) fail(`缺少清单：${manifestPath}`)

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const entry = typeof manifest.entry === 'string' && manifest.entry.trim() ? manifest.entry.trim() : 'index.js'

// 源码布局是「清单在插件根、构建产物在 dist/」，而 zip 里两者必须平级。
// 所以入口先在插件根找（已经手动摆好），再退到 dist/（vite 的默认产物）。
const entryCandidates = [join(modRoot, entry), join(modRoot, 'dist', entry)]
const entryPath = entryCandidates.find((p) => existsSync(p))
if (!entryPath) {
  fail(`缺少入口文件 ${entry}，先执行 npm run build（产物应在 ${modRoot}\\dist）`)
}

const stage = join(modsDirSafe(), `.stage-${manifest.id}`)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// 只把「运行期需要的东西」放进 zip 根目录：清单 + 入口。其他资源（图片、字体）
// 如果插件真的需要，也放根目录并在代码里用相对 URL 引用 dola-mod://<id>/<file>。
copyFileSync(manifestPath, join(stage, 'dola-mod.json'))
copyFileSync(entryPath, join(stage, entry))

const outDir = modsDirSafe()
const out = join(outDir, `${manifest.id}-${manifest.version}.zip`)
rmSync(out, { force: true })

const tar = join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'tar.exe')
execFileSync(tar, ['-a', '-c', '-f', out, '-C', stage, 'dola-mod.json', entry], {
  stdio: 'inherit'
})

rmSync(stage, { recursive: true, force: true })

const size = statSync(out).size
console.log(`✔ ${manifest.id} v${manifest.version}`)
console.log(`  ${out}  (${(size / 1024).toFixed(1)} KB)`)
console.log(`  根目录：dola-mod.json, ${entry}`)

function modsDirSafe() {
  const dir = join(repoRoot, 'mods')
  mkdirSync(dir, { recursive: true })
  return dir
}
