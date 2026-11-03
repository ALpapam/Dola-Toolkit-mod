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

interface PetState {
  /** character box in window coordinates, reported by the page */
  hitBox: { x: number; y: number; width: number; height: number } | null
  /** folder under the plugin's data dir that holds the current model */
  modelDir: string
  /** model3.json path relative to the model folder */
  modelFile: string
  /** window id while the pet is shown */
  windowId: string | null
  scale: number
  alwaysOnTop: boolean
}

const DEFAULTS: PetState = {
  hitBox: null,
  modelDir: '',
  modelFile: '',
  windowId: null,
  scale: 1,
  alwaysOnTop: true
}

/** Live2D models only reference a handful of file types; everything else is dead weight. */
const KEEP = new Set(['.json', '.moc3', '.png', '.jpg', '.jpeg', '.webp', '.wav', '.mp3', '.motion3.json'])

export function register(dola: ModHostApi): void {
  const stateFile = join(dola.dataDir, 'pet.json')
  const modelsRoot = join(dola.dataDir, 'models')
  mkdirSync(modelsRoot, { recursive: true })

  let state: PetState = { ...DEFAULTS }
  try {
    if (existsSync(stateFile)) state = { ...DEFAULTS, ...(JSON.parse(readFileSync(stateFile, 'utf8')) as PetState) }
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
    save()
    return { ok: true, windowId: id }
  }

  const closePet = (): { ok: boolean } => {
    if (state.windowId) {
      dola.desktop.close(state.windowId)
      state.windowId = null
      save()
    }
    return { ok: true }
  }

  /* ---- handlers the UI calls ---- */

  dola.ipc.handle('state', () => ({
    modelDir: state.modelDir,
    modelFile: state.modelFile,
    showing: Boolean(state.windowId),
    scale: state.scale,
    alwaysOnTop: state.alwaysOnTop
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
      if (kind === 'listen') {
        return { ok: false, error: '语音识别尚未启用（下一版接入本地 whisper）' }
      }
      return { ok: false, error: `未知操作：${kind}` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '操作失败' }
    }
  })

  /* ---- lifecycle ---- */

  dola.on('boot', async () => {
    // the orb comes back with the pet, since it is how the pet is operated
    void openOrb().catch(() => undefined)
    // a pet that was open when the app closed comes back
    if (!state.modelFile) return
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
