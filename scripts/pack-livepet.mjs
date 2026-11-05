#!/usr/bin/env node
// ---------------------------------------------------------------------------
// 打包「桌宠」插件。
//
// 桌宠比普通插件复杂：它除了 index.js 还要带页面（pet.html / orb.html）、一个
// Live2D 运行时（cubismcore.min.js）、主进程服务（main/index.js），以及本地语音
// 识别用的 whisper 二进制和繁简转换表。所以走独立脚本，而不是通用的 pack.mjs。
//
//   node scripts/pack-livepet.mjs
//   → mods/livepet-<version>.zip
//
// 源码位置：默认读应用仓库的 mods/livepet（那里有 node_modules，能跑 vite）。
// 用 LIVE PET_SRC 环境变量可以指向别处。
// ---------------------------------------------------------------------------

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const appRoot = resolve(repoRoot, '..', 'dola-toolkit')
const src = process.env['LIVEPET_SRC'] || join(appRoot, 'mods', 'livepet')

function fail(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}

if (!existsSync(src)) fail(`找不到源码目录：${src}`)

const manifest = JSON.parse(readFileSync(join(src, 'dola-mod.json'), 'utf8'))
const out = join(repoRoot, 'mods', `livepet-${manifest.version}.zip`)

/** 构建产物 → 插件里的位置。缺一个都会让插件在运行期直接坏掉。 */
const FILES = [
  ['dola-mod.json', 'dola-mod.json'],
  ['dist/index.js', 'index.js'],
  ['dist/main/index.js', 'main/index.js'],
  ['pet.html', 'pet.html'],
  ['dist/pet/index.js', 'pet.js'],
  ['orb.html', 'orb.html'],
  ['dist/orb/index.js', 'orb.js'],
  ['panel.html', 'panel.html'],
  ['dist/panel/index.js', 'panel.js'],
  ['cubismcore.min.js', 'cubismcore.min.js']
]

for (const [from] of FILES) {
  if (!existsSync(join(src, from))) fail(`缺少构建产物 ${from}，先跑 vite build`)
}

const sttDir = join(src, 'stt')
if (!existsSync(join(sttDir, 'whisper-cli.exe'))) fail(`缺少语音识别运行时：${sttDir}\\whisper-cli.exe`)
if (!existsSync(join(sttDir, 't2s.tsv'))) fail(`缺少繁简转换表：${sttDir}\\t2s.tsv`)

/** 随包发布的默认参考音频（GPT-SoVITS 音色样本），第一次使用时复制到插件数据目录。 */
const refVoice = join(src, 'ref-voice.wav')
if (!existsSync(refVoice)) fail(`缺少默认参考音频：${refVoice}`)
FILES.push(['ref-voice.wav', 'ref-voice.wav'])

const stage = join(repoRoot, 'mods', `.stage-livepet`)
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'main'), { recursive: true })
mkdirSync(join(stage, 'stt'), { recursive: true })

for (const [from, to] of FILES) cpSync(join(src, from), join(stage, to))
// whisper-cli.exe 与它依赖的 DLL 必须同目录；t2s.tsv 也放在这里
for (const name of readdirSync(sttDir)) {
  if (name.endsWith('.exe') || name.endsWith('.dll') || name === 't2s.tsv') {
    cpSync(join(sttDir, name), join(stage, 'stt', name))
  }
}

rmSync(out, { force: true })
const tar = join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'tar.exe')
// -a 让 bsdtar 按扩展名选格式；显式列出条目，避免把 .stage 的空目录结构带进去
const entries = [
  'dola-mod.json',
  'index.js',
  'main',
  'pet.html',
  'pet.js',
  'orb.html',
  'orb.js',
  'panel.html',
  'panel.js',
  'cubismcore.min.js',
  'ref-voice.wav',
  'stt'
]
execFileSync(tar, ['-a', '-c', '-f', out, '-C', stage, ...entries], { stdio: 'inherit' })

rmSync(stage, { recursive: true, force: true })

const size = statSync(out).size
console.log(`✔ livepet v${manifest.version}`)
console.log(`  ${out}  (${(size / 1024 / 1024).toFixed(1)} MB)`)
console.log(
  '  根目录：dola-mod.json, index.js, main/, pet.html, pet.js, orb.html, orb.js, panel.html, panel.js, cubismcore.min.js, ref-voice.wav, stt/'
)
