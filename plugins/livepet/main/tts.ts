// ---------------------------------------------------------------------------
// 桌宠 mod — 本地 / 云端语音合成
//
// 两种后端，由用户在插件设置里选：
//
//   本地 GPT-SoVITS   GET  http://127.0.0.1:9880/tts
//                     → 直接回 WAV 字节。音色用参考音频克隆，完全不出网。
//
//   云端 MiMo-TTS      POST {base}/chat/completions
//                     → 音频在 choices[0].message.audio.data（base64 WAV）。
//                     MiMo 把 TTS 挂在 chat-completions 上，不是 OpenAI 的
//                     /v1/audio/speech，所以请求体是 messages + audio.voice。
//
// 为什么配置归插件：桌宠才是「用某个音色说话」的那一方，主程序不该为了一个插件长出
// 一整套设置。请求也必须在主进程发 —— 渲染层 CSP 的 connect-src 不含 127.0.0.1。
//
// MiMo 的音色既可传预置名（冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean），也可传
// `data:audio/…;base64,…` 做音色克隆；克隆走 -voiceclone 模型。
// ---------------------------------------------------------------------------

import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

export type TtsProvider = 'local' | 'mimo'

export interface TtsConfig {
  enabled: boolean
  /** which backend to use */
  provider: TtsProvider
  /** playback gain in the renderer: 0 = mute, 1 = normal */
  volume: number
  timeoutMs: number

  /* ---- 本地 GPT-SoVITS ---- */
  endpoint: string
  /** reference clip that decides the timbre */
  refAudio: string
  promptText: string
  promptLang: string
  textLang: string
  speed: number

  /* ---- 云端 MiMo ---- */
  mimoBaseUrl: string
  mimoApiKey: string
  /** preset voice name (冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean) */
  mimoVoice: string
  /** style direction sent as MiMo's user message; may be empty */
  mimoStyle: string
  /** true = clone the timbre from refAudio (uses the -voiceclone model) */
  mimoClone: boolean
}

export const TTS_DEFAULTS: TtsConfig = {
  enabled: true,
  provider: 'local',
  volume: 1,
  timeoutMs: 120_000,

  endpoint: 'http://127.0.0.1:9880/tts',
  refAudio: '',
  promptText: '',
  promptLang: 'ja',
  textLang: 'zh',
  speed: 1,

  mimoBaseUrl: 'https://api.xiaomimimo.com/v1',
  mimoApiKey: '',
  mimoVoice: '冰糖',
  mimoStyle: '',
  mimoClone: false
}

/** MiMo 的预置音色，给设置页做成下拉。 */
export const MIMO_VOICES = ['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'] as const

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
  provider: TtsProvider
  /** what is actually in use, shown in the settings row */
  detail: string
}

/** MiMo takes ~4000 chars; the pet never gets near that, but clamp anyway. */
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

  /* ---- 内置参考音频 ---- */

  private stableRefPath(): string {
    return join(this.paths.dataDir, 'voice', 'ref.wav')
  }

  /**
   * Copies the bundled sample into the data dir (idempotent).
   *
   * The install folder is replaced wholesale on upgrade, so the clip must live under
   * `dataDir` and be referenced by absolute path.
   */
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

  /** Adopts the bundled clip when nothing valid is configured. */
  ensureReference(): void {
    if (this.config.refAudio && existsSync(this.config.refAudio)) return
    const bundled = this.installBundledReference()
    if (bundled) this.config.refAudio = bundled
  }

  /* ---- 状态 ---- */

  status(): TtsStatus {
    const c = this.config
    if (!c.enabled) {
      return { configured: false, ready: false, reason: '语音合成已关闭', provider: c.provider, detail: '' }
    }

    if (c.provider === 'mimo') {
      const detail = c.mimoClone
        ? `MiMo 克隆音色（${this.shortName(c.refAudio)}）`
        : `MiMo 预置音色 ${c.mimoVoice}`
      if (!c.mimoApiKey) {
        return { configured: false, ready: false, reason: '还没有填 MiMo API Key', provider: c.provider, detail }
      }
      if (!c.mimoBaseUrl) {
        return { configured: false, ready: false, reason: '没有填 MiMo 服务地址', provider: c.provider, detail }
      }
      if (c.mimoClone) {
        this.ensureReference()
        if (!c.refAudio || !existsSync(c.refAudio)) {
          return { configured: true, ready: false, reason: '克隆音色需要参考音频', provider: c.provider, detail }
        }
      }
      return { configured: true, ready: true, reason: '', provider: c.provider, detail }
    }

    if (!c.endpoint) {
      return { configured: false, ready: false, reason: '没有填服务地址', provider: c.provider, detail: '本地 GPT-SoVITS' }
    }
    const detail = `本地 GPT-SoVITS（${this.shortName(c.refAudio)}）`
    if (!c.refAudio) {
      const bundled = this.installBundledReference()
      if (bundled) {
        c.refAudio = bundled
        return {
          configured: true,
          ready: true,
          reason: '',
          provider: c.provider,
          detail: `本地 GPT-SoVITS（${this.shortName(bundled)}）`
        }
      }
      return { configured: false, ready: false, reason: '还没有参考音频', provider: c.provider, detail }
    }
    if (!existsSync(c.refAudio)) {
      const bundled = this.installBundledReference()
      if (bundled) {
        c.refAudio = bundled
        return {
          configured: true,
          ready: true,
          reason: '',
          provider: c.provider,
          detail: `本地 GPT-SoVITS（${this.shortName(bundled)}）`
        }
      }
      return { configured: true, ready: false, reason: '参考音频文件不存在', provider: c.provider, detail }
    }
    return { configured: true, ready: true, reason: '', provider: c.provider, detail }
  }

  private shortName(p: string): string {
    if (!p) return '未设置'
    const name = p.split(/[\\/]/).pop() ?? p
    return name.length > 22 ? `${name.slice(0, 20)}…` : name
  }

  /* ---- 文本清洗 ---- */

  /**
   * Trims what should never be read aloud.
   *
   * MiMo honours inline `(情绪)` tags, so those are kept — only code blocks and markdown
   * punctuation are stripped.
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

  /* ---- 合成 ---- */

  async speak(rawText: string): Promise<TtsResult> {
    const text = this.clampText(rawText)
    if (!text) return { ok: false, audio: '', text: '', error: '没有要朗读的内容' }
    this.ensureReference()
    const status = this.status()
    if (!status.ready) return { ok: false, audio: '', text, error: status.reason || '语音合成不可用' }
    return this.config.provider === 'mimo' ? this.speakMimo(text) : this.speakLocal(text)
  }

  /** 本地 GPT-SoVITS：GET + query，直接回 WAV。 */
  private async speakLocal(text: string): Promise<TtsResult> {
    const c = this.config
    const url = new URL(c.endpoint)
    url.searchParams.set('text', text)
    url.searchParams.set('text_lang', c.textLang || 'zh')
    url.searchParams.set('ref_audio_path', c.refAudio)
    // an empty transcript tells GPT-SoVITS to derive it from the audio
    url.searchParams.set('prompt_text', c.promptText ?? '')
    url.searchParams.set('prompt_lang', c.promptLang || 'zh')
    url.searchParams.set('media_type', 'wav')
    const speed = Number(c.speed)
    if (Number.isFinite(speed) && speed > 0.5 && speed < 2.5) {
      url.searchParams.set('speed_factor', String(speed))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(10_000, c.timeoutMs || 120_000))
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
      this.log('info', `tts(local) ${text.length} 字 → ${(bytes.length / 1024).toFixed(0)} KB`)
      return { ok: true, audio: `data:${mime};base64,${bytes.toString('base64')}`, text, error: null }
    } catch (e) {
      return { ok: false, audio: '', text, error: this.networkError(e) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 云端 MiMo-TTS.
   *
   * The request uses the chat-completions shape: a `user` message carries the style
   * direction, an `assistant` message carries the text to read, and the voice goes in
   * `audio.voice`. The WAV comes back base64-encoded in `message.audio.data`.
   */
  private async speakMimo(text: string): Promise<TtsResult> {
    const c = this.config
    const base = c.mimoBaseUrl.replace(/\/+$/, '')
    const clone = c.mimoClone
    const model = clone ? 'mimo-v2.5-tts-voiceclone' : 'mimo-v2.5-tts'

    let voice = c.mimoVoice || '冰糖'
    if (clone) {
      const dataUrl = this.refAsDataUrl()
      if (!dataUrl) {
        return { ok: false, audio: '', text, error: '参考音频读不出来（或超过 10MB），无法克隆音色' }
      }
      voice = dataUrl
    }

    // an empty user message is fine: MiMo then relies on the text's inline (情绪) tags
    const messages = [
      { role: 'user', content: (c.mimoStyle ?? '').trim() },
      { role: 'assistant', content: text }
    ]

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(15_000, c.timeoutMs || 120_000))
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${c.mimoApiKey}` },
        body: JSON.stringify({ model, messages, audio: { format: 'wav', voice } }),
        signal: controller.signal
      })
      if (!res.ok) {
        let detail = `HTTP ${res.status}`
        try {
          const payload = (await res.json()) as { error?: { message?: string }; message?: string }
          detail = payload.error?.message ?? payload.message ?? detail
        } catch {
          /* not JSON */
        }
        return { ok: false, audio: '', text, error: `MiMo 合成失败：${detail}` }
      }
      let payload: { choices?: { message?: { audio?: { data?: string } } }[] }
      try {
        payload = (await res.json()) as typeof payload
      } catch {
        return { ok: false, audio: '', text, error: 'MiMo 返回的不是 JSON' }
      }
      const audioData = payload.choices?.[0]?.message?.audio?.data
      if (!audioData) {
        return { ok: false, audio: '', text, error: 'MiMo 没有返回音频数据（检查音色名或 Key 权限）' }
      }
      const bytes = Buffer.from(audioData, 'base64')
      if (bytes.length < 200) return { ok: false, audio: '', text, error: 'MiMo 返回的音频是空的' }
      this.log('info', `tts(mimo) ${text.length} 字 → ${(bytes.length / 1024).toFixed(0)} KB`)
      return { ok: true, audio: `data:audio/wav;base64,${audioData}`, text, error: null }
    } catch (e) {
      return { ok: false, audio: '', text, error: this.networkError(e) }
    } finally {
      clearTimeout(timer)
    }
  }

  private networkError(e: unknown): string {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return aborted ? '合成超时（服务没有响应）' : `连不上语音服务：${e instanceof Error ? e.message : String(e)}`
  }

  /** Reads the reference clip as a `data:` URL — MiMo's clone input, and the preview. */
  private refAsDataUrl(): string | null {
    try {
      const p = this.config.refAudio
      if (!p || !existsSync(p)) return null
      // MiMo caps the encoded sample at 10 MB
      if (statSync(p).size > 9 * 1024 * 1024) return null
      const mime = extname(p).toLowerCase() === '.mp3' ? 'audio/mpeg' : 'audio/wav'
      return `data:${mime};base64,${readFileSync(p).toString('base64')}`
    } catch {
      return null
    }
  }

  /** Reads a local audio file as a data URL, for previewing the reference clip. */
  previewRefAudio(): string | null {
    return this.refAsDataUrl()
  }

  /** Keeps the last clip on disk so a wrong-sounding voice can be inspected later. */
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
