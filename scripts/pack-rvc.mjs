#!/usr/bin/env node
// ---------------------------------------------------------------------------
// 打包「音色转换」插件。
//
// 这个插件比一般插件特殊：它**不带** RVC 运行时（几个 GB），只带
//   · 界面 bundle
//   · 主进程服务
//   · bridge/rvc_bridge.py（在用户的 RVC 目录里跑的那段 Python）
//
//   node scripts/pack-rvc.mjs
//   → mods/rvc-<version>.zip
// ---------------------------------------------------------------------------

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const appRoot = resolve(repoRoot, '..', 'dola-toolkit')
const src = process.env['RVC_SRC'] || join(appRoot, 'mods', 'rvc')

function fail(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}

if (!existsSync(src)) fail(`找不到源码目录：${src}`)

const manifest = JSON.parse(readFileSync(join(src, 'dola-mod.json'), 'utf8'))
const out = join(repoRoot, 'mods', `rvc-${manifest.version}.zip`)

/** 构建产物与随包文件 → 插件里的位置。 */
const FILES = [
  ['dola-mod.json', 'dola-mod.json'],
  ['dist/index.js', 'index.js'],
  ['dist/main/index.js', 'main/index.js'],
  ['bridge/rvc_bridge.py', 'bridge/rvc_bridge.py']
]

for (const [from] of FILES) {
  if (!existsSync(join(src, from))) fail(`缺少文件 ${from}，先跑 vite build`)
}

const stage = join(repoRoot, 'mods', '.stage-rvc')
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'main'), { recursive: true })
mkdirSync(join(stage, 'bridge'), { recursive: true })

for (const [from, to] of FILES) cpSync(join(src, from), join(stage, to))

rmSync(out, { force: true })
const tar = join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'tar.exe')
execFileSync(tar, ['-a', '-c', '-f', out, '-C', stage, 'dola-mod.json', 'index.js', 'main', 'bridge'], {
  stdio: 'inherit'
})
rmSync(stage, { recursive: true, force: true })

const size = statSync(out).size
console.log(`✔ rvc v${manifest.version}`)
console.log(`  ${out}  (${(size / 1024).toFixed(0)} KB)`)
console.log('  根目录：dola-mod.json, index.js, main/, bridge/')
