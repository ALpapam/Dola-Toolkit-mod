// ---------------------------------------------------------------------------
// 桌宠 mod — 悬浮窗页面入口
//
// 这个页面跑在宿主创建的透明桌面上，只负责把模型画出来，并把自己的角色包围盒回报
// 给主进程（宿主据此决定哪些像素接收点击、哪些穿透到桌面）。
// ---------------------------------------------------------------------------

import { PetStage } from './stage'

declare global {
  interface Window {
    api: {
      mod: {
        invoke: <T = unknown>(id: string, channel: string, ...args: unknown[]) => Promise<T>
      }
    }
  }
}

/** The preload bridge, when this page is given one. */
function apiRef(): { mod?: { invoke: (...a: unknown[]) => Promise<unknown> } } | undefined {
  return (window as unknown as { api?: { mod?: { invoke: (...a: unknown[]) => Promise<unknown> } } }).api
}

const status = document.getElementById('status') as HTMLDivElement
const canvas = document.getElementById('pet') as HTMLCanvasElement

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = src
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`无法加载 ${src}`))
    document.head.appendChild(el)
  })
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search)
  // the host passes the model the user selected
  const model = params.get('model') ?? ''
  if (!model) {
    status.textContent = '还没有选择模型，请在「设置 → 桌宠」里上传 Live2D 模型'
    status.classList.add('error')
    return
  }

  try {
    // pet.html loads cubismcore.min.js synchronously before this bundle runs
    if (!(window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) {
      throw new Error('Cubism Core 未加载')
    }

    const stage = new PetStage(canvas)
    await stage.load(model)
    stage.start()
    status.textContent = ''

    // report the character box so the host can route clicks.
    // This page has no preload bridge (it is not the main window), so the report is
    // simply skipped when `window.api` is absent — the pet still renders.
    const report = (): void => {
      const api = (window as unknown as { api?: { mod?: { invoke: (...a: unknown[]) => Promise<unknown> } } }).api
      if (!api?.mod?.invoke) return
      void api.mod.invoke('livepet', 'hit-box', stage.hitBox()).catch(() => undefined)
    }
    report()
    setInterval(report, 1500)
    window.addEventListener('resize', report)
  } catch (e) {
    status.textContent = `模型加载失败：${e instanceof Error ? e.message : String(e)}`
    status.classList.add('error')
  }
}

void boot()
