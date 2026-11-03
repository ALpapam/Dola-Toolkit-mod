// ---------------------------------------------------------------------------
// 桌宠 mod — 本地语音合成（GPT-SoVITS）
//
// 为什么 TTS 的配置在插件里，而不是主程序里：
//
//   1. 桌宠是「用某个音色说话」的那一方，音色、参考音频、语速都是它的属性；
//   2. 主程序不该因为一个插件的需求就长出一整套设置页和 IPC —— 主程序保持干净；
//   3. 只有本插件用到 TTS，别的工具要用时照抄这个文件即可。
//
// 主进程仍然是唯一能发这个请求的地方（渲染层 CSP 的 connect-src 不含 127.0.0.1）。
//
// 请求走 **GET + query**，和 GPT-SoVITS 的 /tts 接口一致。参考音频用绝对路径没问题：
// 实测中文路径也能正常合成（那个 'gbk' 报错是终端编码问题，不是路径问题）。
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'

export interface TtsConfig {
  enabled: boolean
  /** full TTS URL, e.g. http://127.0.0.1:9880/tts */
  endpoint: string
  /** absolute path to the reference clip */
  refAudio: string
  /** transcript of the reference clip; empty lets the server derive it */
  promptText: string
  /** language of the reference clip */
  promptLang: string
  /** language of the text being spoken */
  textLang: string
  speed: number
  timeoutMs: number
}

export const TTS_DEFAULTS: TtsConfig = {
  enabled: true,
  endpoint: 'http://127.0.0.1:9880/tts',
  refAudio: '',
  promptText: '',
  promptLang: 'ja',
  textLang: 'zh',
  speed: 1,
  timeoutMs: 120_000
}

export interface TtsResult {
  ok: boolean
  audio: string
  text: string
  error: string | null
}

export interface TtsStatus {
  configured: boolean
  ready: boolean
  reason: string
  endpoint: string
  refAudio: string
}

/** GPT-SoVITS gets unstable well before this; one paragraph is plenty for a pet. */
const MAX_TEXT = 400

export class TtsEngine {
  constructor(
    private readonly paths: { installDir: string; dataDir: string },
    private config: TtsConfig,
    private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void
  ) {}

  getConfig(): TtsConfig {
    return { ...this.config }
  }

  setConfig(patch: Partial<TtsConfig>): TtsConfig {
    this.config = { ...this.config, ...patch }
    return this.getConfig()
  }

  /**
   * Where the bundled sample lives once it is unpacked.
   *
   * The plugin's install folder is replaced wholesale on upgrade, so the clip is copied
   * into the plugin's data dir on first use and read from there forever after.
   */
  private stableRefPath(): string {
    return join(this.paths.dataDir, 'voice', 'ref.wav')
  }

  /** Copies the bundled sample into the data dir (idempotent) and returns its path. */
  installBundledReference(): string | null {
    const bundled = join(this.paths.installDir, 'ref-voice.wav')
    const stable = this.stableRefPath()
    try {
      if (existsSync(stable)) return stable
      if (!existsSync(bundled)) return null
      mkdirSync(join(this.paths.dataDir, 'voice'), { recursive: true })
      cpSync(bundled, stable)
      return stable
    } catch {
      return null
    }
  }

  /**
   * Ensures a reference clip is configured.
   *
   * On first run nothing is set, so the bundled sample is adopted automatically — the
   * user can then replace it with their own voice without touching any file paths.
   */
  ensureReference(): void {
    if (this.config.refAudio && existsSync(this.config.refAudio)) return
    const bundled = this.installBundledReference()
    if (bundled) this.config.refAudio = bundled
  }

  status(): TtsStatus {
    const base = { endpoint: this.config.endpoint, refAudio: this.config.refAudio }
    if (!this.config.enabled) return { ...base, configured: false, ready: false, reason: '语音合成已关闭' }
    if (!this.config.endpoint) return { ...base, configured: false, ready: false, reason: '没有填服务地址' }
    if (!this.config.refAudio) {
      const bundled = this.installBundledReference()
      if (bundled) {
        this.config.refAudio = bundled
        return { ...base, endpoint: this.config.endpoint, refAudio: bundled, configured: true, ready: true, reason: '' }
      }
      return { ...base, configured: false, ready: false, reason: '还没有参考音频' }
    }
    if (!existsSync(this.config.refAudio)) {
      const bundled = this.installBundledReference()
      if (bundled) {
        this.config.refAudio = bundled
        return { ...base, refAudio: bundled, configured: true, ready: true, reason: '' }
      }
      return { ...base, configured: true, ready: false, reason: '参考音频文件不存在' }
    }
    return { ...base, configured: true, ready: true, reason: '' }
  }

  /**
   * Trims what should never be read aloud: code blocks, markdown punctuation, and
   * anything past a sentence boundary once the text gets long.
   */
  private clampText(text: string): string {
    const clean = text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/[*_#`>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (clean.length <= MAX_TEXT) return clean
    const cut = clean.slice(0, MAX_TEXT)
    const lastStop = Math.max(...['。', '！', '？', '；', '.', '!', '?', '\n'].map((p) => cut.lastIndexOf(p)))
    return lastStop > MAX_TEXT * 0.5 ? cut.slice(0, lastStop + 1) : cut
  }

  async speak(rawText: string): Promise<TtsResult> {
    const text = this.clampText(rawText)
    if (!text) return { ok: false, audio: '', text: '', error: '没有要朗读的内容' }
    this.ensureReference()
    const status = this.status()
    if (!status.ready) return { ok: false, audio: '', text, error: status.reason || '语音合成不可用' }

    const url = new URL(this.config.endpoint)
    url.searchParams.set('text', text)
    url.searchParams.set('text_lang', this.config.textLang || 'zh')
    url.searchParams.set('ref_audio_path', this.config.refAudio)
    url.searchParams.set('prompt_text', this.config.promptText ?? '')
    url.searchParams.set('prompt_lang', this.config.promptLang || 'zh')
    url.searchParams.set('media_type', 'wav')
    const speed = Number(this.config.speed)
    if (Number.isFinite(speed) && speed > 0.5 && speed < 2.5) {
      url.searchParams.set('speed_factor', String(speed))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(10_000, this.config.timeoutMs || 120_000))
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) {
        let detail = `HTTP ${res.status}`
        try {
          const payload = (await res.json()) as { message?: string; Exception?: string }
          detail = [payload.message, payload.Exception].filter(Boolean).join('：') || detail
        } catch {
          /* not JSON */
        }
        return { ok: false, audio: '', text, error: `合成失败：${detail}` }
      }
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length < 200) return { ok: false, audio: '', text, error: '合成返回的音频是空的' }
      const mime = res.headers.get('content-type')?.split(';')[0] || 'audio/wav'
      this.log('info', `tts ${text.length} 字 → ${(bytes.length / 1024).toFixed(0)} KB`)
      return { ok: true, audio: `data:${mime};base64,${bytes.toString('base64')}`, text, error: null }
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError'
      return {
        ok: false,
        audio: '',
        text,
        error: aborted ? '合成超时（服务没有响应）' : `连不上语音服务：${e instanceof Error ? e.message : String(e)}`
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Reads a local audio file as a data URL, for previewing the reference clip. */
  previewRefAudio(): string | null {
    try {
      const p = this.config.refAudio
      if (!p || !existsSync(p)) return null
      if (statSync(p).size > 20 * 1024 * 1024) return null
      return `data:audio/wav;base64,${readFileSync(p).toString('base64')}`
    } catch {
      return null
    }
  }

  /**
   * Writes the last generated clip to disk.
   *
   * Handy for the settings page's "上次合成的音频" replay, and as the only way to check
   * what went out when a user reports "it sounds wrong".
   */
  cacheLast(audioDataUrl: string): void {
    try {
      const dir = join(this.paths.dataDir, 'voice')
      mkdirSync(dir, { recursive: true })
      const b64 = audioDataUrl.slice(audioDataUrl.indexOf(',') + 1)
      writeFileSync(join(dir, 'last.wav'), Buffer.from(b64, 'base64'))
    } catch {
      /* a lost cache file is not worth a warning */
    }
  }
}
