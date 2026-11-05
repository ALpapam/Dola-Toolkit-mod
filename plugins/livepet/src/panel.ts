// ---------------------------------------------------------------------------
// 桌宠 mod — 设置面板（独立窗口）
//
// 这个页面跑在宿主另开的、**可聚焦**的桌面窗口里，所以它的输入框能收到键盘 ——
// 桌宠本体那个窗口是 focusable:false，打不了字。
//
// 面板只做两件事：把当前状态读出来渲染，把用户的改动写回去。
// 所有业务逻辑仍在 main/index.ts，这里不重复实现。
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    api?: {
      mod: {
        invoke: <T = unknown>(id: string, channel: string, ...args: unknown[]) => Promise<T>
        on: (id: string, channel: string, cb: (payload: unknown) => void) => () => void
      }
    }
  }
}

const MOD = 'livepet'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return window.api!.mod.invoke<T>(MOD, channel, ...args)
}

/* ---- shape of what the service reports ---- */

interface TtsConfig {
  enabled: boolean
  provider: 'local' | 'mimo'
  volume: number
  endpoint: string
  refAudio: string
  promptText: string
  promptLang: string
  textLang: string
  speed: number
  mimoBaseUrl: string
  mimoApiKey: string
  mimoVoice: string
  mimoStyle: string
  mimoClone: boolean
}

interface PetState {
  modelDir: string
  modelFile: string
  showing: boolean
  scale: number
  alwaysOnTop: boolean
  speakReply: boolean
  rememberChat: boolean
  tts: TtsConfig
}

interface TtsStatus {
  configured: boolean
  ready: boolean
  reason: string
  provider: string
  detail: string
}

/* ---- element helpers ---- */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const sw = (id: string, on: boolean): void => {
  $(id).dataset['on'] = on ? '1' : '0'
}

const text = (id: string, value: string): void => {
  $(id).textContent = value
}

const shortPath = (p: string): string => {
  if (!p) return '未设置'
  const name = p.split(/[\\/]/).pop() ?? p
  return name.length > 26 ? `${name.slice(0, 24)}…` : name
}

let state: PetState | null = null
let cfg: TtsConfig | null = null
let status: TtsStatus | null = null

/* ---- load + render ---- */

async function refresh(): Promise<void> {
  try {
    const st = await invoke<PetState>('state')
    state = st
    cfg = st.tts
    status = await invoke<TtsStatus>('tts-status')
    render()
  } catch {
    /* service not loaded yet */
  }
}

function render(): void {
  if (!state || !cfg) return

  /* 桌宠 */
  sw('sw-show', Boolean(state.showing))
  text('d-shown', state.showing ? '正在桌面上显示' : '已隐藏')
  ;($('scale') as HTMLInputElement).value = String(Math.round(state.scale * 100))
  text('d-scale', `${Math.round(state.scale * 100)}%`)
  sw('sw-onTop', Boolean(state.alwaysOnTop))
  text('d-onTop', state.alwaysOnTop ? '保持在其他窗口之上' : '会被其他窗口盖住')
  text('d-model', state.modelFile ? state.modelDir : '还没有导入模型')

  /* 语音 */
  sw('sw-speak', Boolean(state.speakReply))
  text('d-speak', state.speakReply ? '回答后会自动念出来' : '只显示文字，不出声')
  ;($('vol') as HTMLInputElement).value = String(Math.round(cfg.volume * 100))
  text('d-vol', `${Math.round(cfg.volume * 100)}%`)

  for (const b of document.querySelectorAll<HTMLButtonElement>('#seg-provider button')) {
    b.classList.toggle('on', b.dataset['p'] === cfg.provider)
  }
  $('prov-local').dataset['active'] = cfg.provider === 'local' ? '1' : '0'
  $('prov-mimo').dataset['active'] = cfg.provider === 'mimo' ? '1' : '0'

  text('d-status', status?.ready ? status.detail : status?.reason || '不可用')
  const line = $('status-line')
  line.className = `status-line ${status?.ready ? 'ok' : 'err'}`
  line.textContent = status?.ready ? `就绪：${status.detail}` : `未就绪：${status?.reason || '未知'}`

  /* 本地 */
  ;($('endpoint') as HTMLInputElement).value = cfg.endpoint
  text('d-ref', shortPath(cfg.refAudio))
  ;($('text-lang') as HTMLSelectElement).value = cfg.textLang
  ;($('prompt-lang') as HTMLSelectElement).value = cfg.promptLang
  ;($('speed') as HTMLInputElement).value = String(Math.round(cfg.speed * 100))
  text('d-speed', `${cfg.speed.toFixed(2)}×`)

  /* 云端 */
  ;($('mimo-key') as HTMLInputElement).value = cfg.mimoApiKey
  ;($('mimo-base') as HTMLInputElement).value = cfg.mimoBaseUrl
  ;($('mimo-style') as HTMLTextAreaElement).value = cfg.mimoStyle
  for (const b of document.querySelectorAll<HTMLButtonElement>('#seg-clone button')) {
    b.classList.toggle('on', b.dataset['c'] === (cfg.mimoClone ? '1' : '0'))
  }
  $('row-voice').style.display = cfg.mimoClone ? 'none' : 'flex'

  /* 记忆 */
  sw('sw-mem', Boolean(state.rememberChat))
  text('d-mem', state.rememberChat ? '正在记住最近聊过的几句' : '每次都是单轮')
}

/* ---- saving ---- */

async function save(patch: Record<string, unknown>): Promise<void> {
  try {
    const res = await invoke<{ ok: boolean; config?: TtsConfig; status?: TtsStatus; error?: string }>(
      'tts-set-config',
      patch
    )
    if (!res.ok) {
      toast(res.error ?? '保存失败')
      return
    }
    if (res.config) cfg = res.config
    if (res.status) status = res.status
    // the pet state fields (not tts) come from the state handler instead
    if (state) state.tts = cfg as TtsConfig
    render()
  } catch (e) {
    toast(e instanceof Error ? e.message : '保存失败')
  }
}

let toastTimer = 0
function toast(message: string): void {
  const line = $('status-line')
  const previous = line.className
  line.className = 'status-line err'
  line.textContent = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    line.className = previous
    render()
  }, 3000)
}

/* ---- wiring ---- */

/* 显示桌宠 */
$('sw-show').addEventListener('click', () => {
  const next = !(state?.showing ?? false)
  void (next ? invoke('show') : invoke('hide')).then(() => refresh())
})

/* 大小：拖动时只更新文字，松手才写（每次重建窗口，太频繁会闪） */
const scale = $('scale') as HTMLInputElement
scale.addEventListener('input', () => {
  text('d-scale', `${scale.value}%`)
})
scale.addEventListener('change', () => {
  void invoke('set-scale', Number(scale.value) / 100).then(() => refresh())
})

/* 置顶 */
$('sw-onTop').addEventListener('click', () => {
  void invoke('set-on-top', !(state?.alwaysOnTop ?? true)).then(() => refresh())
})

/* 换模型 */
$('pick-model').addEventListener('click', () => {
  void invoke<{ ok: boolean; canceled?: boolean; error?: string }>('pick-model').then((res) => {
    if (!res.ok && !res.canceled) toast(res.error ?? '导入失败')
    return refresh()
  })
})

/* 朗读开关 */
$('sw-speak').addEventListener('click', () => {
  void invoke('set-speak-reply', !(state?.speakReply ?? true)).then(() => refresh())
})

/* 音量：实时生效，不需要等下一次合成 */
const vol = $('vol') as HTMLInputElement
let volTimer = 0
vol.addEventListener('input', () => {
  text('d-vol', `${vol.value}%`)
  // debounce: a slider drag would otherwise write the settings file dozens of times
  window.clearTimeout(volTimer)
  volTimer = window.setTimeout(() => void save({ volume: Number(vol.value) / 100 }), 180)
})

/* 引擎切换 */
for (const b of document.querySelectorAll<HTMLButtonElement>('#seg-provider button')) {
  b.addEventListener('click', () => {
    void save({ provider: b.dataset['p'] })
  })
}

/* 试听 */
$('test-tts').addEventListener('click', () => {
  const btn = $('test-tts') as HTMLButtonElement
  btn.disabled = true
  void invoke<{ ok: boolean; audio?: string; error?: string }>('tts-test')
    .then((res) => {
      if (!res.ok) {
        toast(res.error ?? '试听失败')
        return
      }
      if (res.audio) {
        const audio = new Audio(res.audio)
        audio.volume = cfg?.volume ?? 1
        void audio.play().catch(() => toast('播放被拒绝，请再点一次'))
      }
    })
    .finally(() => {
      btn.disabled = false
      return refresh()
    })
})

/* 本地设置 */
const endpoint = $('endpoint') as HTMLInputElement
endpoint.addEventListener('blur', () => void save({ endpoint: endpoint.value }))

$('pick-ref').addEventListener('click', () => {
  void invoke<{ ok: boolean; canceled?: boolean; error?: string }>('tts-pick-ref').then((res) => {
    if (!res.ok && !res.canceled) toast(res.error ?? '选择失败')
    return refresh()
  })
})
$('reset-ref').addEventListener('click', () => {
  void invoke<{ ok: boolean; error?: string }>('tts-reset-ref').then((res) => {
    if (!res.ok) toast(res.error ?? '失败')
    return refresh()
  })
})

;($('text-lang') as HTMLSelectElement).addEventListener('change', () => {
  void save({ textLang: ($('text-lang') as HTMLSelectElement).value })
})
;($('prompt-lang') as HTMLSelectElement).addEventListener('change', () => {
  void save({ promptLang: ($('prompt-lang') as HTMLSelectElement).value })
})

const speed = $('speed') as HTMLInputElement
speed.addEventListener('input', () => text('d-speed', `${(Number(speed.value) / 100).toFixed(2)}×`))
speed.addEventListener('change', () => void save({ speed: Number(speed.value) / 100 }))

/* 云端设置 */
const key = $('mimo-key') as HTMLInputElement
key.addEventListener('blur', () => void save({ mimoApiKey: key.value }))

const base = $('mimo-base') as HTMLInputElement
base.addEventListener('blur', () => void save({ mimoBaseUrl: base.value }))

for (const b of document.querySelectorAll<HTMLButtonElement>('#seg-clone button')) {
  b.addEventListener('click', () => void save({ mimoClone: b.dataset['c'] === '1' }))
}

const voiceSel = $('mimo-voice') as HTMLSelectElement
voiceSel.addEventListener('change', () => void save({ mimoVoice: voiceSel.value }))

const style = $('mimo-style') as HTMLTextAreaElement
style.addEventListener('blur', () => void save({ mimoStyle: style.value }))

/* 记忆 */
$('sw-mem').addEventListener('click', () => {
  void invoke('set-remember-chat', !(state?.rememberChat ?? true)).then(() => refresh())
})
$('clear-mem').addEventListener('click', () => {
  void invoke('memory-clear').then(() => toast('对话记忆已清空'))
})

/* 关闭 */
$('close').addEventListener('click', () => void invoke('panel-close'))

/* ---- title-bar dragging ----
 *
 * The window itself is created with `movable: false`, so the page drives the movement:
 * it reports pointer deltas to the main process, which owns the real window bounds.
 */
const bar = $('bar')
let drag: { startX: number; startY: number; winX: number; winY: number } | null = null

bar.addEventListener('pointerdown', async (e) => {
  if ((e.target as HTMLElement).closest('button')) return
  bar.setPointerCapture(e.pointerId)
  try {
    const list = await invoke<{ id: string; bounds: { x: number; y: number } }[]>('panel-window')
    const me = list?.[0]
    drag = me
      ? { startX: e.screenX, startY: e.screenY, winX: me.bounds.x, winY: me.bounds.y }
      : null
  } catch {
    drag = null
  }
})

bar.addEventListener('pointermove', (e) => {
  if (!drag) return
  void invoke('panel-move', {
    x: drag.winX + (e.screenX - drag.startX),
    y: drag.winY + (e.screenY - drag.startY)
  })
})

bar.addEventListener('pointerup', () => {
  drag = null
})

/* the volume the orb uses must match what the panel shows */
window.api?.mod.on(MOD, 'tts-changed', () => void refresh())

/* ---- voice list ---- */
async function loadVoices(): Promise<void> {
  try {
    const list = await invoke<string[]>('tts-voices')
    voiceSel.innerHTML = ''
    for (const v of list) {
      const opt = document.createElement('option')
      opt.value = v
      opt.textContent = v
      voiceSel.appendChild(opt)
    }
    if (cfg) voiceSel.value = cfg.mimoVoice
  } catch {
    /* keep the empty select */
  }
}

void loadVoices().then(() => refresh())
