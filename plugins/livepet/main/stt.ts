// ---------------------------------------------------------------------------
// 桌宠 mod — 本地语音识别（whisper.cpp）
//
// 为什么是自己带一个二进制，而不是调云端 STT：
//   · 用户明确要求「本地服务」，语音不该往外面传；
//   · 云端 STT 在国内大多需要 key、且时好时坏（硅基流动已经被验证过不稳定）。
//
// 这个模块只做三件事：
//   1. 确保模型文件在本地（第一次用时从镜像下载，约 59 MB）；
//   2. 把一段 16kHz 单声道 WAV 交给 whisper-cli，读回文本；
//   3. 把繁体输出转成简体（whisper 的中文输出经常是繁体）。
//
// 二进制随插件一起发布（`stt/` 目录，12 MB），所以装上就能用，不用编译。
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { cpus } from 'node:os'
import { once } from 'node:events'

/** 可选的模型。都放在 hf-mirror 上，国内直连可用。 */
export interface SttModel {
  id: string
  file: string
  bytes: number
  label: string
  desc: string
}

export const MODELS: SttModel[] = [
  {
    id: 'base-q5',
    file: 'ggml-base-q5_1.bin',
    bytes: 59_707_625,
    label: 'base（推荐）',
    desc: '59 MB，中文识别准确，一段话约 1~2 秒'
  },
  {
    id: 'tiny-q5',
    file: 'ggml-tiny-q5_1.bin',
    bytes: 32_152_673,
    label: 'tiny（轻量）',
    desc: '32 MB，更快更省内存，个别字容易听错'
  }
]

/** 国内可直连的 HF 镜像；官方域名放最后，作为镜像失效时的兜底。 */
const MODEL_HOSTS = [
  'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/',
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'
]

export interface SttPaths {
  /** plugin install dir, holds the whisper binaries */
  installDir: string
  /** plugin data dir, holds the downloaded model */
  dataDir: string
}

export interface SttProgress {
  /** 0..1, -1 when the total size is unknown */
  ratio: number
  received: number
  total: number
}

export class SttEngine {
  private downloading: Promise<string> | null = null
  private cancelled = false

  constructor(
    private readonly paths: SttPaths,
    private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void,
    private readonly onProgress: (p: SttProgress) => void
  ) {}

  /** `stt/` inside the installed plugin: whisper-cli.exe + its DLLs. */
  private binDir(): string {
    return join(this.paths.installDir, 'stt')
  }

  private exe(): string {
    return join(this.binDir(), 'whisper-cli.exe')
  }

  /** Where the downloaded model lives. `models/` under the plugin's private data. */
  modelPath(modelId: string): string {
    const model = MODELS.find((m) => m.id === modelId) ?? MODELS[0]
    return join(this.paths.dataDir, 'models', model.file)
  }

  /** runtime present and usable? Does not check the model. */
  runtimeReady(): boolean {
    return existsSync(this.exe())
  }

  modelReady(modelId: string): boolean {
    const model = MODELS.find((m) => m.id === modelId) ?? MODELS[0]
    try {
      return existsSync(this.modelPath(model.id)) && statSync(this.modelPath(model.id)).size >= model.bytes * 0.95
    } catch {
      return false
    }
  }

  status(modelId: string): { runtime: boolean; model: boolean; modelId: string; bytes: number } {
    const model = MODELS.find((m) => m.id === modelId) ?? MODELS[0]
    let bytes = 0
    try {
      bytes = statSync(this.modelPath(model.id)).size
    } catch {
      /* not downloaded */
    }
    return { runtime: this.runtimeReady(), model: this.modelReady(model.id), modelId: model.id, bytes }
  }

  cancelDownload(): void {
    this.cancelled = true
  }

  /**
   * Downloads the model once, then reuses it forever.
   *
   * The request goes straight to the mirror: routing 59 MB through the user's proxy is
   * slower than the mirror itself, and the mirror is reachable from the mainland.
   */
  async ensureModel(modelId: string): Promise<string> {
    const model = MODELS.find((m) => m.id === modelId) ?? MODELS[0]
    const target = this.modelPath(model.id)
    if (this.modelReady(model.id)) return target
    if (this.downloading) return this.downloading

    this.cancelled = false
    this.downloading = (async () => {
      mkdirSync(join(this.paths.dataDir, 'models'), { recursive: true })
      const part = `${target}.part`
      let lastError = ''
      for (const host of MODEL_HOSTS) {
        const url = host + model.file
        try {
          this.log('info', `下载 ${model.file} ← ${host}`)
          await this.fetchTo(url, part, model.bytes)
          // a truncated file would fail inside whisper with a confusing error
          const size = statSync(part).size
          if (size < model.bytes * 0.95) throw new Error(`下载不完整（${size} 字节）`)
          return await this.finalize(part, target)
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e)
          this.log('warn', `模型下载失败（${host}）：${lastError}`)
          if (this.cancelled) break
        }
      }
      this.downloading = null
      throw new Error(`模型下载失败：${lastError || '所有镜像都不可用'}`)
    })()

    try {
      return await this.downloading
    } finally {
      this.downloading = null
    }
  }

  private async finalize(part: string, target: string): Promise<string> {
    // rename after a full download, so a half file never looks like a valid model
    const { renameSync } = await import('node:fs')
    renameSync(part, target)
    this.onProgress({ ratio: 1, received: statSync(target).size, total: statSync(target).size })
    return target
  }

  private async fetchTo(url: string, dest: string, expected: number): Promise<void> {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length')) || expected
    let received = 0
    const out = createWriteStream(dest)
    // fetch bodies are web streams; pipe through a reader so progress can be reported
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (this.cancelled) throw new Error('已取消')
        received += value.byteLength
        out.write(value)
        if (received % (256 * 1024) < 8192) {
          this.onProgress({ ratio: total ? received / total : -1, received, total })
        }
      }
    } finally {
      out.end()
      await once(out, 'finish').catch(() => undefined)
    }
    this.onProgress({ ratio: 1, received, total })
  }

  /**
   * Transcribes a 16 kHz mono WAV and returns simplified-Chinese text.
   *
   * whisper-cli writes the transcript to `<prefix>.txt`; parsing stdout instead would
   * mean fighting with its banner and timing lines.
   */
  async transcribe(wavPath: string, modelId: string, opts: { language?: string } = {}): Promise<string> {
    if (!this.runtimeReady()) throw new Error('插件里缺少语音识别组件（stt/whisper-cli.exe），请重新安装插件')
    const model = this.modelReady(modelId) ? this.modelPath(modelId) : await this.ensureModel(modelId)

    /*
     * whisper-cli must receive RELATIVE paths.
     *
     * It crashes with 0xC0000409 (stack buffer overrun) whenever an absolute argument
     * contains non-ASCII characters — and this app lives under `D:\桌面\…`, so every
     * absolute path it would get does. Running the process with `cwd` set to the plugin's
     * data dir and passing names like `models/ggml-base-q5_1.bin` sidesteps the bug
     * completely; the exe itself is spawned by absolute path, which is fine.
     */
    const dataDir = this.paths.dataDir
    const relModel = relative(dataDir, model).replace(/\\/g, '/')
    const relWav = relative(dataDir, wavPath).replace(/\\/g, '/')
    if (relModel.startsWith('..') || relWav.startsWith('..')) {
      throw new Error('语音文件不在插件数据目录内，无法识别')
    }
    const relOut = relWav.replace(/\.wav$/i, '')

    const threads = Math.max(2, Math.min(8, Math.floor(cpus().length / 2)))
    const args = [
      '-m', relModel,
      '-f', relWav,
      '-l', opts.language ?? 'zh',
      '-nt',
      '-otxt',
      '-of', relOut,
      '-t', String(threads)
    ]
    this.log('info', `whisper ${relModel} · ${relWav} · ${threads} 线程`)

    const text = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.exe(), args, {
        cwd: dataDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stderr = ''
      child.stderr?.on('data', (buf: Buffer) => {
        stderr += buf.toString('utf8')
      })
      // a hung inference must not keep the orb spinning forever
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('语音识别超时'))
      }, 30_000)
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(new Error(`无法启动语音识别：${e.message}`))
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(new Error(`语音识别失败（退出码 ${code}）${stderr ? `：${stderr.slice(-200)}` : ''}`))
          return
        }
        try {
          resolve(readFileSync(`${wavPath.replace(/\.wav$/i, '')}.txt`, 'utf8'))
        } catch {
          resolve('')
        }
      })
    })

    return this.toSimplified(cleanTranscript(text))
  }

  /**
   * whisper's Chinese output is frequently traditional, so the transcript is folded to
   * simplified before it is shown or sent to the model.
   *
   * The table is OpenCC's `TSCharacters.txt` (4148 single-character mappings, 34 KB),
   * shipped with the plugin and read from disk — no dictionary is embedded in the bundle.
   */
  toSimplified(text: string): string {
    if (!this.table) {
      try {
        // tolerate a CRLF-saved table: a stray `\r` in a value would end up inside the
        // transcript, which is exactly how it leaked out the first time
        const raw = readFileSync(join(this.paths.installDir, 'stt', 't2s.tsv'), 'utf8').replace(/\r/g, '')
        const map = new Map<string, string>()
        for (const line of raw.split('\n')) {
          const i = line.indexOf('\t')
          if (i > 0) map.set(line.slice(0, i), line.slice(i + 1))
        }
        this.table = map
      } catch {
        this.table = new Map()
      }
    }
    let out = ''
    for (const ch of text) out += this.table.get(ch) ?? ch
    return out
  }

  private table: Map<string, string> | null = null
}

/**
 * Drops what whisper likes to add around real speech: bracketed sound markers such as
 * `[音乐]`、`（笑声）`, leftover timestamps, and stray spaces between CJK characters.
 *
 * whisper-cli writes one line per segment, joined with CRLF — and its segments break
 * mid-sentence, so the carriage returns must go before anything else or the transcript
 * ends up with `帮\r我看看现\r在几\r点`. Line breaks are only dropped for CJK text; latin
 * output keeps a single space between lines so English words do not run together.
 */
export function cleanTranscript(raw: string): string {
  const joined = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
  // a line break inside one Chinese sentence is an artefact, not punctuation
  return joined
    .replace(/(?<=[\u4e00-\u9fff，。！？、；：])\n(?=[\u4e00-\u9fff，。！？、；：])/g, '')
    .replace(/\n+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([，。！？、；：])/g, '$1')
    .trim()
}
