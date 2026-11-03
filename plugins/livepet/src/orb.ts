// ---------------------------------------------------------------------------
// 桌宠 mod — 悬浮球页面
//
// A small always-on-top disc with the pet's actions: 识屏 (VLM), 听音 (STT), 聊天 (LLM)
// and 设置. Collapsed it is a single grip; tapping the grip expands the row.
//
// Dragging is handled here rather than by Electron: the window is repositioned through the
// host, so the ball follows the pointer without ever stealing focus from the desktop.
//
// 听音 records here because only a renderer has `getUserMedia`; the captured audio is
// resampled to 16 kHz mono, encoded as WAV and posted to the main process, which runs
// whisper locally.
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
const body = document.body
const grip = document.getElementById('grip') as HTMLButtonElement
const hint = document.getElementById('hint') as HTMLDivElement
const panel = document.getElementById('panel') as HTMLDivElement
const panelWho = document.getElementById('panel-who') as HTMLDivElement
const panelHeard = document.getElementById('panel-heard') as HTMLDivElement
const panelBody = document.getElementById('panel-body') as HTMLDivElement
const bar = document.getElementById('bar') as HTMLDivElement
const barFill = bar.firstElementChild as HTMLElement
const micBtn = document.querySelector<HTMLButtonElement>('.btn[data-action="listen"]') as HTMLButtonElement
const input = document.getElementById('chat-input') as HTMLInputElement
const sendBtn = document.getElementById('chat-send') as HTMLButtonElement

/** Window geometry the host keeps for us: the ball row plus room for the panel. */
const BALL_H = 60
const PANEL_W = 240
const TALL_MAX = 620

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return window.api!.mod.invoke<T>(MOD, channel, ...args)
}

/* ---- window positioning ---- */

/** Window position at drag start, in screen coordinates. */
let drag: { startX: number; startY: number; winX: number; winY: number; moved: boolean } | null = null

async function winBounds(): Promise<{ x: number; y: number; width: number; height: number }> {
  try {
    const list = await invoke<{ id: string; bounds: { x: number; y: number; width: number; height: number } }[]>(
      'orb-window'
    )
    const me = list?.find((w) => w.id)
    return me?.bounds ?? { x: 0, y: 0, width: PANEL_W, height: BALL_H }
  } catch {
    return { x: 0, y: 0, width: PANEL_W, height: BALL_H }
  }
}

async function setWindow(x: number, y: number, height: number): Promise<void> {
  await invoke('orb-resize', { x, y, width: PANEL_W, height })
}

grip.addEventListener('pointerdown', async (e) => {
  e.preventDefault()
  grip.setPointerCapture(e.pointerId)
  const origin = await winBounds()
  drag = { startX: e.screenX, startY: e.screenY, winX: origin.x, winY: origin.y, moved: false }
})

grip.addEventListener('pointermove', (e) => {
  if (!drag) return
  const dx = e.screenX - drag.startX
  const dy = e.screenY - drag.startY
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true
  if (!drag.moved) return
  void invoke('orb-move', { x: drag.winX + dx, y: drag.winY + dy })
})

grip.addEventListener('pointerup', async () => {
  const wasDrag = drag?.moved
  drag = null
  // a tap (not a drag) toggles the action row
  if (!wasDrag) {
    body.classList.toggle('collapsed')
    await invoke('orb-expanded', !body.classList.contains('collapsed'))
  }
})

/* ---- result panel ---- */

let panelOpen = false

/**
 * Shows a result above the desktop.
 *
 * The window is taller than the ball so the panel can render below it without being
 * clipped; the host resizes once the content height is known, and shrinks back when the
 * panel closes.
 */
async function showPanel(who: string, text: string, heard = '', busy = false): Promise<void> {
  panelWho.textContent = who
  panelHeard.textContent = heard
  panelBody.textContent = text
  panelBody.classList.toggle('error', false)
  panelBody.dataset.busy = busy ? '1' : ''
  panelOpen = true
  body.classList.add('separate-panel')
  await syncHeight()
}

async function showError(who: string, message: string, heard = ''): Promise<void> {
  panelWho.textContent = who
  panelHeard.textContent = heard
  panelBody.textContent = message
  panelBody.classList.add('error')
  panelOpen = true
  body.classList.add('separate-panel')
  await syncHeight()
}

/** Measured content height, clamped so a huge answer scrolls instead of covering the screen. */
async function syncHeight(): Promise<void> {
  const tall = panelOpen
  const content = tall ? Math.min(panel.scrollHeight + 18, TALL_MAX) : 0
  const b = await winBounds()
  await setWindow(b.x, b.y, tall ? BALL_H + content : BALL_H)
}

async function closePanel(): Promise<void> {
  panelOpen = false
  body.classList.remove('separate-panel')
  body.classList.remove('chatting')
  bar.classList.remove('on')
  const b = await winBounds()
  await setWindow(b.x, b.y, BALL_H)
}

document.getElementById('panel-close')?.addEventListener('click', () => void closePanel())

/** Progress bar for the whisper model download (broadcast from the main process). */
window.api?.mod.on(MOD, 'stt-progress', (payload) => {
  const p = payload as { ratio: number; received: number; total: number }
  bar.classList.add('on')
  const ratio = p.ratio >= 0 ? p.ratio : Math.min(1, p.received / (p.total || 59_000_000))
  barFill.style.width = `${Math.round(ratio * 100)}%`
  if (ratio >= 1) setTimeout(() => bar.classList.remove('on'), 800)
})

/* ---- voice output ---- */

/** One shared player: a new line always interrupts the previous one. */
let player: HTMLAudioElement | null = null

function playVoice(dataUrl: string): void {
  if (!dataUrl) return
  if (!player) {
    player = new Audio()
    player.addEventListener('ended', () => micBtn.classList.remove('speaking'))
  }
  player.pause()
  player.src = dataUrl
  micBtn.classList.add('speaking')
  void player.play().catch(() => {
    // autoplay can be refused before the user interacts; not fatal
    micBtn.classList.remove('speaking')
  })
}

// the main process synthesises the line and broadcasts it when it is ready
window.api?.mod.on(MOD, 'voice', (payload) => {
  const v = payload as { audio?: string }
  if (v?.audio) playVoice(v.audio)
})

window.api?.mod.on(MOD, 'voice-error', () => {
  micBtn.classList.remove('speaking')
})

/* ---- recording ---- */

let recorder: {
  ctx: AudioContext
  stream: MediaStream
  proc: ScriptProcessorNode
  src: MediaStreamAudioSourceNode
  chunks: Float32Array[]
  startedAt: number
  timer: number
} | null = null

const MAX_SECONDS = 20

async function startRecording(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  })
  const ctx = new AudioContext()
  const src = ctx.createMediaStreamSource(stream)
  // A ScriptProcessor is deprecated but dependency-free: an AudioWorklet would need its
  // own module file, and this bundle is a single IIFE loaded from a custom scheme.
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  proc.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
  }
  src.connect(proc)
  // the processor only runs while it is connected to a destination
  proc.connect(ctx.destination)

  const startedAt = performance.now()
  const timer = window.setTimeout(() => {
    void stopRecording(true)
  }, MAX_SECONDS * 1000)
  recorder = { ctx, stream, proc, src, chunks, startedAt, timer }
}

async function stopRecording(_auto: boolean): Promise<void> {
  const rec = recorder
  if (!rec) return
  recorder = null
  clearTimeout(rec.timer)
  rec.proc.disconnect()
  rec.src.disconnect()
  rec.stream.getTracks().forEach((t) => t.stop())
  const sampleRate = rec.ctx.sampleRate
  await rec.ctx.close().catch(() => undefined)

  const seconds = (performance.now() - rec.startedAt) / 1000
  if (seconds < 0.45) {
    setBusyState(false)
    hint.textContent = '说话时间太短'
    return
  }
  // only keep the tail that actually contains speech: a very long silence wastes time
  const wav = encodeWav(rec.chunks, sampleRate)
  setBusyState(false)
  await runListen(wav)
}

/**
 * Concatenates the captured chunks, mixes to mono, resamples to 16 kHz and wraps it in a
 * RIFF/WAVE header — the only input whisper-cli reads without a decoder chain.
 */
function encodeWav(chunks: Float32Array[], sampleRate: number): string {
  let total = 0
  for (const c of chunks) total += c.length
  // silence at the very start would only slow whisper down
  const merged = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.length
  }

  const targetRate = 16_000
  const ratio = sampleRate / targetRate
  const frames = Math.max(1, Math.floor(merged.length / ratio))
  const pcm = new Int16Array(frames)
  for (let i = 0; i < frames; i++) {
    // average the source window: cheap decimation with a little anti-aliasing
    const from = Math.floor(i * ratio)
    const to = Math.min(merged.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = from; j < to; j++) sum += merged[j]
    const sample = to > from ? sum / (to - from) : merged[from] ?? 0
    const clamped = Math.max(-1, Math.min(1, sample))
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }

  const bytes = pcm.length * 2
  const buffer = new ArrayBuffer(44 + bytes)
  const view = new DataView(buffer)
  const writeStr = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + bytes, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, targetRate, true)
  view.setUint32(28, targetRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, bytes, true)
  new Int16Array(buffer, 44, pcm.length).set(pcm)

  // base64 in 8-bit safe chunks (a 20 s clip is ~640 KB, well under the IPC limit)
  let binary = ''
  const raw = new Uint8Array(buffer)
  const step = 0x8000
  for (let i = 0; i < raw.length; i += step) {
    binary += String.fromCharCode(...raw.subarray(i, i + step))
  }
  return btoa(binary)
}

/* ---- actions ---- */

function setBusyState(busy: boolean): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.btn[data-action]')) {
    b.disabled = busy
  }
  micBtn.classList.toggle('recording', recorder !== null)
}

function setHint(label: string | null): void {
  hint.textContent = label ?? ''
}

/** 听音: record → local whisper → answer through the app's AI. */
async function runListen(wavBase64: string): Promise<void> {
  setBusyState(true)
  setHint('本地识别中…')
  await showPanel('听音', '正在本地识别…', '', true)
  try {
    const res = await invoke<{
      ok: boolean
      heard?: string
      reply?: string
      text?: string
      error?: string
    }>('stt-ask', wavBase64, { language: 'zh' })

    if (!res.ok) {
      await showError('听音', res.error ?? '识别失败')
    } else if (res.error) {
      // transcription worked but the answer did not: still show what was heard
      await showError('听音', res.error, res.heard ?? '')
    } else {
      await showPanel('听音', res.reply ?? '', res.heard ?? '')
      setHint('')
    }
  } catch (e) {
    await showError('听音', e instanceof Error ? e.message : String(e))
  } finally {
    setBusyState(false)
    setHint('')
  }
}

micBtn.addEventListener('click', async (e) => {
  e.stopPropagation()
  if (recorder) {
    await stopRecording(false)
    return
  }
  try {
    await startRecording()
    setBusyState(false)
    micBtn.classList.add('recording')
    setHint('正在录音…再点一下结束')
    if (panelOpen) await closePanel()
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    await showError(
      '听音',
      name === 'NotAllowedError'
        ? '麦克风权限被拒绝，请在 Windows「设置 → 隐私 → 麦克风」里允许桌面应用使用麦克风'
        : `打不开麦克风：${err instanceof Error ? err.message : String(err)}`
    )
  }
})

/** 聊天: ask something in text, with the conversation history behind it. */
async function askChat(): Promise<void> {
  panelWho.textContent = '聊天'
  panelHeard.textContent = ''
  // turn the result panel into an input row for this one question
  body.classList.add('chatting')
  panelBody.textContent = ''
  panelOpen = true
  body.classList.add('separate-panel')
  await syncHeight()
  input.focus()
}

async function sendChat(): Promise<void> {
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  setBusyState(true)
  await showPanel('聊天', '正在思考…', `你说：${text}`, true)
  try {
    const res = await invoke<{ ok: boolean; reply?: string; text?: string; error?: string }>('chat-ask', text)
    if (res.ok) await showPanel('聊天', res.reply ?? res.text ?? '')
    else await showError('聊天', res.error ?? '未知错误')
  } catch (e) {
    await showError('聊天', e instanceof Error ? e.message : String(e))
  } finally {
    setBusyState(false)
  }
}

document.querySelectorAll<HTMLButtonElement>('.btn[data-action]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action
    if (!action || action === 'listen') return
    if (action === 'settings') {
      await invoke('orb-open-settings')
      return
    }
    if (action === 'chat') {
      await askChat()
      return
    }
    setBusyState(true)
    const who = '识屏'
    setHint('正在识屏…')
    await showPanel(who, '正在截屏并识别…', '', true)
    try {
      const res = await invoke<{ ok: boolean; text?: string; error?: string }>('orb-action', action)
      if (res.ok) {
        await showPanel(who, res.text ?? '')
        // read the description out loud too, so the pet narrates what it sees
        const said = res.text ?? ''
        if (said) {
          const voice = await invoke<{ ok: boolean; audio?: string }>('tts-speak', said)
          if (voice.ok && voice.audio) playVoice(voice.audio)
        }
      } else {
        await showError(who, res.error ?? '未知错误')
      }
      setHint('')
    } catch (e) {
      await showError(who, e instanceof Error ? e.message : String(e))
    } finally {
      setBusyState(false)
    }
  })
})

/* ---- chat input wiring ---- */

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void sendChat()
  }
  // Escape closes the row without sending
  if (e.key === 'Escape') void closePanel()
})
sendBtn.addEventListener('click', () => void sendChat())

// the row starts collapsed; the host may ask it to remember the last state
void (async () => {
  try {
    const st = await invoke<{ expanded: boolean }>('orb-state')
    if (st?.expanded) body.classList.remove('collapsed')
  } catch {
    /* first run */
  }
})()
