// ---------------------------------------------------------------------------
// 桌宠 mod — 主进程服务
//
// 宿主负责窗口本身（透明 / 置顶 / 穿透），这个服务负责「桌宠」的业务：
//   · 导入 Live2D 模型（用户选一个文件夹，只要 .model3.json 及其引用到的文件）
//   · 记住当前模型
//   · 打开 / 关闭桌宠窗口
//   · 根据角色包围盒切换点击穿透
// ---------------------------------------------------------------------------

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import type { ModHostApi } from '../../../src/main/modService'
import { MODELS, SttEngine } from './stt'
import { TTS_DEFAULTS, TtsEngine, type TtsConfig } from './tts'
import { Memory } from './memory'

interface PetState {
  /** character box in window coordinates, reported by the page */
  hitBox: { x: number; y: number; width: number; height: number } | null
  /** folder under the plugin's data dir that holds the current model */
  modelDir: string
  /** model3.json path relative to the model folder */
  modelFile: string
  /** window id while the pet is shown */
  windowId: string | null
  /** whether the pet should be visible — survives a restart, unlike `windowId` */
  shown: boolean
  scale: number
  alwaysOnTop: boolean
  /** whisper model id used by 听音 */
  sttModel: string
  /** read the AI's reply out loud */
  speakReply: boolean
  /** keep the last few turns so the pet remembers the conversation */
  rememberChat: boolean
  /** voice output config — owned here, not by the host */
  tts: TtsConfig
}

const DEFAULTS: PetState = {
  hitBox: null,
  modelDir: '',
  modelFile: '',
  windowId: null,
  shown: true,
  scale: 1,
  alwaysOnTop: true,
  sttModel: 'base-q5',
  speakReply: true,
  rememberChat: true,
  tts: { ...TTS_DEFAULTS }
}

/**
 * The pet's voice, sent on every request.
 *
 * Kept short and concrete: a long persona prompt tends to be performed rather than
 * followed, and every turn pays for it.
 */
const PET_SYSTEM_PROMPT = [
  '你是用户电脑上的桌面伙伴，正在陪着他。',
  '用口语化的中文回答，一到三句话，不要列表、标题、Markdown。',
  '不要说「作为 AI」这类话；不知道的事直接说不知道。',
  '如果用户提到上一轮聊过的事，可以自然地接上，但不要重复复述。'
].join('')

/** Live2D models only reference a handful of file types; everything else is dead weight. */
const KEEP = new Set(['.json', '.moc3', '.png', '.jpg', '.jpeg', '.webp', '.wav', '.mp3', '.motion3.json'])

export function register(dola: ModHostApi): void {
  const stateFile = join(dola.dataDir, 'pet.json')
  const modelsRoot = join(dola.dataDir, 'models')
  mkdirSync(modelsRoot, { recursive: true })
  // recordings are scratch data: they live under the plugin's private dir and are
  // overwritten, since the audio never needs to survive the transcription
  const audioDir = join(dola.dataDir, 'audio')
  mkdirSync(audioDir, { recursive: true })

  let state: PetState = { ...DEFAULTS }
  try {
    if (existsSync(stateFile)) {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as Partial<PetState>
      // tts is an object now: a shallow merge would drop newly added keys from the file's
      // older shape, so merge it explicitly
      state = { ...DEFAULTS, ...parsed, tts: { ...TTS_DEFAULTS, ...(parsed.tts ?? {}) } }
    }
  } catch {
    /* a corrupt state file just means "no model selected" */
  }
  const save = (): void => {
    try {
      mkdirSync(dola.dataDir, { recursive: true })
      // never persist a window id: the window is gone after a restart
      writeFileSync(stateFile, JSON.stringify({ ...state, windowId: null, hitBox: null }, null, 2))
    } catch {
      /* non-fatal */
    }
  }

  const tts = new TtsEngine(
    { installDir: dola.installDir, dataDir: dola.dataDir },
    state.tts,
    (level, msg) => dola.log(level, msg)
  )
  // the bundled voice is adopted before anything can ask for one
  tts.ensureReference()
  state.tts = tts.getConfig()

  /** Chat history lives with the plugin; the host has no business reading it. */
  const memory = new Memory(dola.dataDir, (messages) =>
    dola.ai.chat(messages).then((r) => ({ ok: r.ok, content: r.content, error: r.error }))
  )
  memory.load()

  const stt = new SttEngine(
    { installDir: dola.installDir, dataDir: dola.dataDir },
    (level, msg) => dola.log(level, msg),
    (p) => dola.ipc.broadcast('stt-progress', p)
  )

  /** Copies a model folder into the plugin's data dir, keeping only referenced files. */
  const importModel = async (sourceDir: string): Promise<{ name: string; entry: string }> => {
    // find the model3.json, allowing one level of nesting
    const findModel = (dir: string, depth = 0): string | null => {
      let entries: string[] = []
      try {
        entries = readdirSync(dir)
      } catch {
        return null
      }
      const direct = entries.find((n) => n.toLowerCase().endsWith('.model3.json'))
      if (direct) return join(dir, direct)
      if (depth >= 2) return null
      for (const name of entries) {
        const full = join(dir, name)
        try {
          if (readdirSync(full).length) {
            const nested = findModel(full, depth + 1)
            if (nested) return nested
          }
        } catch {
          /* not a directory */
        }
      }
      return null
    }

    const modelJson = findModel(sourceDir)
    if (!modelJson) throw new Error('这个文件夹里没有 .model3.json，可能不是 Live2D 模型')

    const root = dirname(modelJson)
    const settings = JSON.parse(readFileSync(modelJson, 'utf8')) as {
      FileReferences?: { Moc?: string; Textures?: string[]; Physics?: string; Motions?: Record<string, { File: string }[]> }
    }
    void settings.FileReferences

    const name = basename(root)
    const target = join(modelsRoot, name)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })

    /*
     * Copy the whole folder minus the heavy editor artefacts.
     *
     * A model folder usually also contains .cmo3 / .psd2live / .psd sources which can be
     * tens of megabytes and are never read at runtime — a 10MB model becomes ~2MB.
     */
    const copy = (from: string, to: string): void => {
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const src = join(from, entry.name)
        const dst = join(to, entry.name)
        if (entry.isDirectory()) {
          mkdirSync(dst, { recursive: true })
          copy(src, dst)
        } else {
          const lower = entry.name.toLowerCase()
          const ok = lower.endsWith('.json') || KEEP.has(extname(lower)) || lower.includes('.motion3.json')
          if (ok) cpSync(src, dst)
        }
      }
    }
    copy(root, target)

    const entry = relative(target, join(target, relative(root, modelJson))).replace(/\\/g, '/')
    return { name, entry }
  }

  /* ---- 悬浮球（声明在前面：开/关桌宠时要用它） ---- */

  let orbWindow: string | null = null
  let orbExpanded = false

  const openOrb = async (): Promise<string> => {
    if (orbWindow) return orbWindow
    orbWindow = await dola.desktop.open({
      modId: 'livepet',
      page: 'orb.html',
      // sized for the expanded row (grip + 4 buttons); the page keeps the disc centred
      width: 240,
      height: 60,
      // the ball must be clickable, so no passthrough
      ignoreMouse: false,
      alwaysOnTop: true
    })
    // enforce the declared size: a reused window id can keep stale bounds, and DPI
    // rounding can grow it
    dola.desktop.setBounds(orbWindow, { width: 240, height: 60 })
    return orbWindow
  }

  const closeOrb = (): void => {
    if (orbWindow) {
      dola.desktop.close(orbWindow)
      orbWindow = null
    }
  }

  const openPet = async (): Promise<{ ok: boolean; windowId?: string; error?: string }> => {
    if (!state.modelFile) return { ok: false, error: '请先在设置里上传 Live2D 模型' }
    if (state.windowId) return { ok: true, windowId: state.windowId }

    // assets live under the plugin's data dir, served as dola-mod://livepet/@data/...
    const modelPath = `@data/models/${state.modelDir}/${state.modelFile}`.replace(/\/+/g, '/')
    const id = await dola.desktop.open({
      modId: 'livepet',
      page: 'pet.html',
      width: 380,
      height: 520,
      ignoreMouse: true,
      alwaysOnTop: state.alwaysOnTop,
      query: { model: modelPath, scale: String(state.scale) }
    })
    state.windowId = id
    state.shown = true
    save()
    // the orb is how the pet is operated, so it appears with the pet
    await openOrb().catch(() => undefined)
    dola.ipc.broadcast('state-changed', { showing: true })
    return { ok: true, windowId: id }
  }

  /**
   * Hides the pet AND its orb.
   *
   * The orb exists only to operate the pet; leaving it floating over the desktop with
   * nothing to control is just clutter.
   */
  const closePet = (): { ok: boolean } => {
    if (state.windowId) {
      dola.desktop.close(state.windowId)
      state.windowId = null
    }
    state.shown = false
    save()
    closeOrb()
    dola.ipc.broadcast('state-changed', { showing: false })
    return { ok: true }
  }

  /* ---- handlers the UI calls ---- */

  dola.ipc.handle('state', () => ({
    modelDir: state.modelDir,
    modelFile: state.modelFile,
    showing: Boolean(state.windowId),
    scale: state.scale,
    alwaysOnTop: state.alwaysOnTop,
    // the UI reads these back, so omitting one makes its control render as "off"
    sttModel: state.sttModel,
    speakReply: state.speakReply,
    rememberChat: state.rememberChat,
    tts: tts.getConfig()
  }))

  dola.ipc.handle('pick-model', async () => {
    try {
      const picked = await dola.dialog.pickDirectory('选择 Live2D 模型文件夹（含 .model3.json）')
      if (!picked) return { ok: false, canceled: true }
      const { name, entry } = await importModel(picked)
      state.modelDir = name
      state.modelFile = entry
      state.windowId = null
      save()
      dola.ipc.broadcast('state-changed', { modelDir: name, modelFile: entry, showing: false })
      return { ok: true, name, entry }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '导入失败' }
    }
  })

  /** Import from an explicit path (also used by tests, since dialogs need a human). */
  dola.ipc.handle('import-model', async (dir: unknown) => {
    if (typeof dir !== 'string' || !dir) return { ok: false, error: '缺少路径' }
    try {
      const { name, entry } = await importModel(dir)
      state.modelDir = name
      state.modelFile = entry
      state.windowId = null
      save()
      dola.ipc.broadcast('state-changed', { modelDir: name, modelFile: entry, showing: false })
      return { ok: true, name, entry }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '导入失败' }
    }
  })

  dola.ipc.handle('show', () => openPet())
  dola.ipc.handle('hide', () => closePet())

  dola.ipc.handle('set-scale', (_scale: unknown) => {
    const s = Number(_scale)
    if (Number.isFinite(s) && s > 0.2 && s < 3) state.scale = s
    save()
    // re-open so the new scale takes effect immediately
    if (state.windowId) {
      dola.desktop.close(state.windowId)
      state.windowId = null
      void openPet()
    }
    return { ok: true, scale: state.scale }
  })

  dola.ipc.handle('set-on-top', (on: unknown) => {
    state.alwaysOnTop = Boolean(on)
    if (state.windowId) dola.desktop.setAlwaysOnTop(state.windowId, state.alwaysOnTop)
    save()
    return { ok: true, alwaysOnTop: state.alwaysOnTop }
  })

  /**
   * The page reports the character's box so the host can decide where clicks land.
   *
   * The window is created with passthrough on; the page then toggles it off whenever the
   * pointer is over the character and back on when it leaves. That needs the pointer
   * position, which only the page has (Electron's `forward: true` keeps mousemove flowing
   * while ignoring clicks), so the page drives it and the main side just stores the box.
   */
  dola.ipc.handle('hit-box', (box: unknown) => {
    if (!state.windowId || !box || typeof box !== 'object') return { ok: false }
    state.hitBox = box as { x: number; y: number; width: number; height: number }
    return { ok: true }
  })

  /** Called by the page as the pointer enters / leaves the character. */
  dola.ipc.handle('set-passthrough', (ignore: unknown) => {
    if (!state.windowId) return { ok: false }
    dola.desktop.setIgnoreMouse(state.windowId, Boolean(ignore))
    return { ok: true }
  })

  dola.ipc.handle('list-windows', () => dola.desktop.list())

  /* ---- 悬浮球 ---- */


  dola.ipc.handle('orb-show', async () => {
    if (orbWindow) return { ok: true }
    await openOrb()
    return { ok: true }
  })

  dola.ipc.handle('orb-hide', () => {
    closeOrb()
    return { ok: true }
  })

  dola.ipc.handle('orb-state', () => ({ expanded: orbExpanded, showing: Boolean(orbWindow) }))

  dola.ipc.handle('orb-expanded', (on: unknown) => {
    orbExpanded = Boolean(on)
    save()
    return { ok: true }
  })

  dola.ipc.handle('orb-window', () =>
    dola.desktop
      .list()
      .filter((w) => w.id === orbWindow)
      .map((w) => ({ id: w.id, bounds: w.bounds }))
  )

  dola.ipc.handle('orb-move', (pos: unknown) => {
    if (!orbWindow || !pos || typeof pos !== 'object') return { ok: false }
    const p = pos as { x: number; y: number }
    dola.desktop.setBounds(orbWindow, { x: p.x, y: p.y })
    return { ok: true }
  })

  /**
   * Grows / shrinks the orb window.
   *
   * The ball and the result panel share one window, so the page asks for a taller window
   * when a result arrives and shrinks back when it is dismissed. The width stays fixed at
   * the row width — resizing it would re-centre the disc and make it jump.
   */
  dola.ipc.handle('orb-resize', (spec: unknown) => {
    if (!orbWindow || !spec || typeof spec !== 'object') return { ok: false }
    const s = spec as { x?: number; y?: number; height?: number }
    const height = Math.max(60, Math.min(720, Math.round(Number(s.height) || 60)))
    dola.desktop.setBounds(orbWindow, {
      ...(typeof s.x === 'number' ? { x: Math.round(s.x) } : {}),
      ...(typeof s.y === 'number' ? { y: Math.round(s.y) } : {}),
      width: 240,
      height
    })
    return { ok: true }
  })

  dola.ipc.handle('orb-open-settings', () => {
    // bring the main window forward and land on this plugin's settings page
    const win = dola.windows.main()
    if (win) {
      win.show()
      win.focus()
    }
    return { ok: true }
  })

  /** The four orb buttons. Vision / STT / chat all route through the app's AI settings. */
  dola.ipc.handle('orb-action', async (action: unknown) => {
    const kind = String(action)
    try {
      if (kind === 'vision') {
        const shot = await captureScreen()
        if (!shot) return { ok: false, error: '无法截屏' }
        const res = await dola.ai.chat([
          { role: 'system', content: '你是一个桌面助手，请用简短中文描述这张屏幕截图的内容与当前用户在做什么。' },
          {
            role: 'user',
            content: [
              { type: 'text', text: '请描述这张截图。' },
              { type: 'image_url', image_url: { url: shot } }
            ]
          }
        ])
        return res.ok ? { ok: true, text: res.content } : { ok: false, error: res.error }
      }
      if (kind === 'chat') {
        const res = await dola.ai.chat([{ role: 'user', content: '你好，用一句话介绍你自己。' }])
        return res.ok ? { ok: true, text: res.content } : { ok: false, error: res.error }
      }
      return { ok: false, error: `未知操作：${kind}` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '操作失败' }
    }
  })

  /* ---- 听音（本地 whisper） ---- */

  /**
   * The orb records from the microphone itself (only a renderer has `getUserMedia`), then
   * posts the captured audio here as a base64 WAV. The main process writes it to disk and
   * runs whisper-cli, so the recognition happens locally and the audio never leaves the
   * machine.
   */
  dola.ipc.handle('stt-status', () => stt.status(state.sttModel))

  dola.ipc.handle('stt-set-model', (id: unknown) => {
    const model = MODELS.find((m) => m.id === String(id))
    if (!model) return { ok: false, error: '未知模型' }
    state.sttModel = model.id
    save()
    return { ok: true, modelId: model.id }
  })

  dola.ipc.handle('stt-download', async (id: unknown) => {
    const modelId = MODELS.some((m) => m.id === String(id)) ? String(id) : state.sttModel
    try {
      await stt.ensureModel(modelId)
      return { ok: true, modelId }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '下载失败' }
    }
  })

  dola.ipc.handle('stt-cancel-download', () => {
    stt.cancelDownload()
    return { ok: true }
  })

  /**
   * Writes the posted audio and runs whisper over it.
   *
   * Shared by 转写 (stt-transcribe) and 语音问答 (stt-ask) so both go through exactly the
   * same path — including the model auto-download on first use.
   */
  const transcribePosted = async (
    payload: unknown,
    opts: unknown
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
    const data = String(payload ?? '')
    if (!data) return { ok: false, error: '没有收到音频' }
    const language = typeof opts === 'object' && opts ? (opts as { language?: string }).language : undefined
    // one rolling file: the previous request's audio is never interesting afterwards
    const wavPath = join(audioDir, 'last.wav')
    try {
      writeFileSync(wavPath, Buffer.from(data, 'base64'))
    } catch (e) {
      return { ok: false, error: `写入音频失败：${e instanceof Error ? e.message : '未知错误'}` }
    }
    try {
      return { ok: true, text: await stt.transcribe(wavPath, state.sttModel, { language }) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '识别失败' }
    }
  }

  dola.ipc.handle('stt-transcribe', async (payload: unknown, opts: unknown) => {
    const res = await transcribePosted(payload, opts)
    return res.ok ? { ok: true, text: res.text, modelId: state.sttModel } : res
  })

  /**
   * 听音 = 说话 → 本地转写 → 带着最近几轮对话去问 AI → 念出回答。
   *
   * The history is what makes this feel like a companion rather than a command line:
   * "那明天呢？" only makes sense if the previous turn is still in context.
   */
  dola.ipc.handle('stt-ask', async (payload: unknown, opts: unknown) => {
    const res = await transcribePosted(payload, opts)
    if (!res.ok) return { ok: false, error: res.error }
    const heard = res.text
    if (!heard) return { ok: true, heard: '', reply: '', text: '', error: '没听清，再说一遍？' }

    const status = dola.ai.status()
    if (!status.configured) {
      return { ok: true, heard, reply: '', text: '', error: '软件设置里还没有配置 AI，只能先给你转写结果' }
    }

    const history = state.rememberChat ? memory.contextMessages() : []
    const chat = await dola.ai.chat([
      { role: 'system', content: PET_SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: heard }
    ])
    if (!chat.ok) return { ok: true, heard, reply: '', text: '', error: chat.error ?? 'AI 没有返回内容' }

    if (state.rememberChat) {
      memory.push({ role: 'user', text: heard, source: 'voice' })
      memory.push({ role: 'pet', text: chat.content, source: 'voice' })
    }

    /*
     * Speak the reply right after it is shown.
     *
     * Deliberately not awaited: synthesis takes a second or two, and the text should
     * appear the moment the model answers. The audio arrives as a separate broadcast.
     */
    if (state.speakReply && tts.status().ready) {
      void tts
        .speak(chat.content)
        .then((voice) => {
          if (voice.ok) {
            tts.cacheLast(voice.audio)
            dola.ipc.broadcast('voice', { audio: voice.audio, text: voice.text })
          } else {
            dola.ipc.broadcast('voice-error', { error: voice.error })
          }
        })
        .catch(() => undefined)
    }
    return { ok: true, heard, reply: chat.content, text: chat.content }
  })

  /** 聊天按钮：带上下文的闲聊，不需要麦克风。 */
  dola.ipc.handle('chat-ask', async (text: unknown) => {
    const said = String(text ?? '').trim()
    if (!said) return { ok: false, error: '没有要发送的内容' }
    if (!dola.ai.status().configured) return { ok: false, error: '软件设置里还没有配置 AI' }

    const history = state.rememberChat ? memory.contextMessages() : []
    const chat = await dola.ai.chat([
      { role: 'system', content: PET_SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: said }
    ])
    if (!chat.ok) return { ok: false, error: chat.error ?? 'AI 没有返回内容' }

    if (state.rememberChat) {
      memory.push({ role: 'user', text: said, source: 'chat' })
      memory.push({ role: 'pet', text: chat.content, source: 'chat' })
    }
    if (state.speakReply && tts.status().ready) {
      void tts.speak(chat.content).then((voice) => {
        if (voice.ok) dola.ipc.broadcast('voice', { audio: voice.audio, text: voice.text })
      })
    }
    return { ok: true, reply: chat.content, text: chat.content }
  })

  /* ---- 对话记忆 ---- */

  dola.ipc.handle('memory-get', () => ({
    enabled: state.rememberChat,
    turns: memory.all().map((t) => ({ role: t.role, text: t.text, at: t.at }))
  }))

  dola.ipc.handle('memory-clear', () => {
    memory.clear()
    return { ok: true }
  })

  dola.ipc.handle('set-remember-chat', (on: unknown) => {
    state.rememberChat = Boolean(on)
    save()
    if (!state.rememberChat) memory.clear()
    return { ok: true, rememberChat: state.rememberChat }
  })

  /* ---- 朗读（本地 GPT-SoVITS，配置在插件自己这里） ---- */

  dola.ipc.handle('tts-status', () => tts.status())

  dola.ipc.handle('tts-config', () => tts.getConfig())

  dola.ipc.handle('tts-set-config', (patch: unknown) => {
    if (!patch || typeof patch !== 'object') return { ok: false, error: '缺少配置' }
    const p = patch as Partial<TtsConfig>
    const next: Partial<TtsConfig> = {}
    if (typeof p.enabled === 'boolean') next.enabled = p.enabled
    if (typeof p.endpoint === 'string') next.endpoint = p.endpoint.trim()
    if (typeof p.refAudio === 'string') next.refAudio = p.refAudio.trim()
    if (typeof p.promptText === 'string') next.promptText = p.promptText
    if (typeof p.promptLang === 'string') next.promptLang = p.promptLang
    if (typeof p.textLang === 'string') next.textLang = p.textLang
    if (typeof p.speed === 'number' && p.speed > 0.5 && p.speed < 2.5) next.speed = p.speed
    state.tts = tts.setConfig(next)
    save()
    return { ok: true, config: state.tts, status: tts.status() }
  })

  /** Picks a reference clip through the host's file dialog. */
  dola.ipc.handle('tts-pick-ref', async () => {
    try {
      const picked = await dola.dialog.pickFile('选择参考音频（3~10 秒，无背景音乐）', [
        { name: '音频', extensions: ['wav', 'flac', 'ogg', 'mp3'] }
      ])
      if (!picked) return { ok: false, canceled: true }
      state.tts = tts.setConfig({ refAudio: picked })
      save()
      return { ok: true, path: picked, preview: tts.previewRefAudio() }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '选择失败' }
    }
  })

  /** Restores the clip that ships with the plugin (or copies it if missing). */
  dola.ipc.handle('tts-reset-ref', () => {
    const path = tts.installBundledReference()
    if (!path) return { ok: false, error: '插件里没有自带参考音频' }
    state.tts = tts.setConfig({ refAudio: path })
    save()
    return { ok: true, path, preview: tts.previewRefAudio() }
  })

  dola.ipc.handle('tts-preview-ref', () => ({ audio: tts.previewRefAudio() }))

  /** Speaks a fixed line so the user can hear the configured voice. */
  dola.ipc.handle('tts-test', async () => {
    const sample = '你好，我是你的桌面伙伴。'
    const res = await tts.speak(sample)
    return { ...res, status: tts.status() }
  })

  /** Speaks arbitrary text (the 朗读 button and 识屏 results use this). */
  dola.ipc.handle('tts-speak', async (text: unknown) => {
    const res = await tts.speak(String(text ?? ''))
    if (res.ok) tts.cacheLast(res.audio)
    return res
  })

  dola.ipc.handle('set-speak-reply', (on: unknown) => {
    state.speakReply = Boolean(on)
    save()
    return { ok: true, speakReply: state.speakReply }
  })

  /* ---- lifecycle ---- */

  dola.on('boot', async () => {
    /*
     * The orb belongs to the pet: it is opened by `openPet`, and hidden by `closePet`.
     * Booting with no model (or with the pet hidden) must therefore show neither —
     * a floating orb with no character to control is just desktop clutter.
     */
    if (!state.modelFile) return
    if (!state.shown) return
    try {
      await openPet()
    } catch {
      /* surfaced in the UI */
    }
  })

  dola.on('quit', () => {
    closeOrb()
    if (state.windowId) dola.desktop.close(state.windowId)
    state.windowId = null
  })
}

/**
 * Captures the primary display as a PNG data URL.
 *
 * `desktopCapturer` is a main-process API; the renderer cannot reach the screen without
 * a permission prompt, so the screenshot for 识屏 is taken here.
 */
async function captureScreen(): Promise<string | null> {
  try {
    const { desktopCapturer, screen } = await import('electron')
    const display = screen.getPrimaryDisplay()
    const { width, height } = display.size
    const scale = display.scaleFactor || 1
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) }
    })
    const source = sources[0]
    if (!source) return null
    return source.thumbnail.toDataURL()
  } catch {
    return null
  }
}

export type { PetState }
