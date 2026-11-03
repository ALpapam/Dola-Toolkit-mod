#!/usr/bin/env node
// ---------------------------------------------------------------------------
// 取回 whisper.cpp 的 Windows 运行时（语音识别用）。
//
// 二进制不进 git：12 MB 的 dll/exe 放仓库里既拖慢 clone，也没必要版本化——
// 它们是 whisper.cpp 官方 release 的产物，版本固定（b5454），随时可以重新拉。
//
//   node scripts/fetch-stt-runtime.mjs            取回运行时（12 MB）
//   node scripts/fetch-stt-runtime.mjs --check    只检查是否已就位
//
// 目标目录：plugins/livepet/stt/
// 需要的文件：whisper-cli.exe + 它依赖的 dll + msvcp140/vcruntime140(_1).dll
// 另外 t2s.tsv（繁简转换表）是仓库存的，不是这里下载的。
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const dest = join(repoRoot, 'plugins', 'livepet', 'stt')
const work = join(repoRoot, '.cache', 'whisper')
const RELEASE = 'b5454'
const ASSET = 'whisper-bin-x64.zip'
/** 国内可用的 GitHub 加速前缀；直连 github.com 在这里基本不可用 */
const MIRRORS = ['https://gh-proxy.com/', 'https://ghproxy.net/']

/** whisper-cli 运行时需要的 dll（CPU 后端全部保留，whisper 会按 CPU 特性自动选） */
const NEEDED = /^(whisper-cli\.exe|whisper\.dll|ggml\.dll|ggml-base\.dll|ggml-cpu-.*\.dll)$/
/** MSVC 运行时；目标机器没装 VC++ 运行库时缺它们会直接报「找不到 dll」 */
const CRT = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']

const check = process.argv.includes('--check')

if (check) {
  const missing = ['whisper-cli.exe', 't2s.tsv'].filter((f) => !existsSync(join(dest, f)))
  console.log(missing.length ? `✖ missing: ${missing.join(', ')}` : '✔ stt runtime present')
  process.exit(missing.length ? 1 : 0)
}

if (existsSync(join(dest, 'whisper-cli.exe'))) {
  console.log('✔ stt runtime already present, nothing to do')
  process.exit(0)
}

mkdirSync(dest, { recursive: true })
mkdirSync(work, { recursive: true })

const zip = join(work, ASSET)
if (!existsSync(zip) || statSync(zip).size < 8_000_000) {
  const url = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}/${ASSET}`
  let ok = false
  for (const mirror of MIRRORS) {
    console.log(`下载 ${ASSET} ← ${mirror}`)
    try {
      execFileSync(
        'curl',
        ['-sS', '-L', '--retry', '3', '--retry-delay', '2', '-m', '900', '-o', zip, `${mirror}${url}`],
        { stdio: 'inherit' }
      )
      if (statSync(zip).size > 8_000_000) {
        ok = true
        break
      }
    } catch (e) {
      console.log(`  ✖ ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (!ok) {
    console.error('✖ 下载失败，请手动下载后放到 ' + zip)
    process.exit(1)
  }
}

rmSync(join(work, 'Release'), { recursive: true, force: true })
const tar = join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'tar.exe')
execFileSync(tar, ['-xf', zip, '-C', work], { stdio: 'inherit' })

const release = join(work, 'Release')
if (!existsSync(release)) {
  console.error('✖ 解压后没有 Release/ 目录')
  process.exit(1)
}

let copied = 0
for (const name of readdirSync(release)) {
  if (!NEEDED.test(name)) continue
  cpSync(join(release, name), join(dest, name))
  copied++
}

// MSVC 运行时从本机 System32 复制：whisper.cpp 的 release 产物没有带它们
const sys32 = join(process.env['SystemRoot'] || 'C:\\Windows', 'System32')
for (const name of CRT) {
  const from = join(sys32, name)
  if (existsSync(from)) cpSync(from, join(dest, name))
  else console.log(`⚠ 本机没有 ${name}，目标机器需要自己装 VC++ 运行库`)
}

const total = readdirSync(dest).reduce((n, f) => n + statSync(join(dest, f)).size, 0)
console.log(`✔ ${copied} 个文件 → ${dest}`)
console.log(`  合计 ${(total / 1024 / 1024).toFixed(1)} MB（含 t2s.tsv）`)
