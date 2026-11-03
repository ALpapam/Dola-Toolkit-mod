// ---------------------------------------------------------------------------
// 桌宠 mod — 悬浮球页面
//
// A small always-on-top disc with the pet's actions: 识屏 (VLM), 听音 (STT), 聊天 (LLM)
// and 设置. Collapsed it is a single grip; tapping the grip expands the row.
//
// Dragging is handled here rather than by Electron: the window is repositioned through the
// host, so the ball follows the pointer without ever stealing focus from the desktop.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    api?: {
      mod: {
        invoke: <T = unknown>(id: string, channel: string, ...args: unknown[]) => Promise<T>
      }
    }
  }
}

const MOD = 'livepet'
const body = document.body
const grip = document.getElementById('grip') as HTMLButtonElement
const hint = document.getElementById('hint') as HTMLDivElement

/** Window position at drag start, in screen coordinates. */
let drag: { startX: number; startY: number; winX: number; winY: number; moved: boolean } | null = null

async function winOrigin(): Promise<{ x: number; y: number }> {
  try {
    const list = await window.api!.mod.invoke<{ id: string; bounds: { x: number; y: number } }[]>(MOD, 'orb-window')
    const me = list?.find((w) => w.id)
    return me?.bounds ? { x: me.bounds.x, y: me.bounds.y } : { x: 0, y: 0 }
  } catch {
    return { x: 0, y: 0 }
  }
}

async function moveTo(x: number, y: number): Promise<void> {
  await window.api!.mod.invoke(MOD, 'orb-move', { x, y })
}

grip.addEventListener('pointerdown', async (e) => {
  e.preventDefault()
  grip.setPointerCapture(e.pointerId)
  const origin = await winOrigin()
  drag = { startX: e.screenX, startY: e.screenY, winX: origin.x, winY: origin.y, moved: false }
})

grip.addEventListener('pointermove', (e) => {
  if (!drag) return
  const dx = e.screenX - drag.startX
  const dy = e.screenY - drag.startY
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true
  if (!drag.moved) return
  void moveTo(drag.winX + dx, drag.winY + dy)
})

grip.addEventListener('pointerup', async () => {
  const wasDrag = drag?.moved
  drag = null
  // a tap (not a drag) toggles the action row
  if (!wasDrag) {
    body.classList.toggle('collapsed')
    await window.api!.mod.invoke(MOD, 'orb-expanded', !body.classList.contains('collapsed'))
  }
})

/* ---- actions ---- */

function setBusy(label: string | null): void {
  hint.textContent = label ?? ''
}

document.querySelectorAll<HTMLButtonElement>('.btn[data-action]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action
    if (!action) return
    if (action === 'settings') {
      await window.api!.mod.invoke(MOD, 'orb-open-settings')
      return
    }
    setBusy(
      action === 'vision' ? '正在识屏…' : action === 'listen' ? '正在听音…' : '正在思考…'
    )
    try {
      const res = await window.api!.mod.invoke<{ ok: boolean; text?: string; error?: string }>(
        MOD,
        'orb-action',
        action
      )
      setBusy(res.ok ? res.text ?? '' : `失败：${res.error ?? '未知错误'}`)
    } catch (e) {
      setBusy(`失败：${e instanceof Error ? e.message : String(e)}`)
    }
  })
})

// the row starts collapsed; the host may ask it to remember the last state
void (async () => {
  try {
    const st = await window.api!.mod.invoke<{ expanded: boolean }>(MOD, 'orb-state')
    if (st?.expanded) body.classList.remove('collapsed')
  } catch {
    /* first run */
  }
})()
