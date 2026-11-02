// ---------------------------------------------------------------------------
// 桌宠 mod — Live2D 舞台（pixi-live2d-display 实现）
//
// 之前手写 WebGL 渲染器卡在 Cubism 的遮罩与裁切上：Core 只给顶点数据，不给绘制矩阵和
// 遮罩通道，自己拼模板缓冲很难画不出东西。
//
// 这里改用 pixi-live2d-display：它内部实现了完整的 Cubism 4 渲染（遮罩、裁切、物理、
// 动作），代价是约 700 KB 依赖，换一个可靠、可维护的实现。
//
// 约定：Cubism Core 由页面脚本加载，pixi-live2d 读 window.Live2DCubismCore；模型文件
// 通过 dola-mod:// 拉取（pixi 的 loader 用 XHR/Image，自定义协议都能吃）。
// ---------------------------------------------------------------------------

import { Application, Ticker } from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display/cubism4'

export class PetStage {
  private app: Application | null = null
  private model: Live2DModel | null = null
  private canvas: HTMLCanvasElement
  private loaded = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    // the model animates on pixi's shared ticker
    Live2DModel.registerTicker(Ticker)
  }

  /** Loads the model and fits it into the window. */
  async load(modelPath: string): Promise<void> {
    const app = new Application({
      view: this.canvas,
      // the desktop window is transparent, so the stage must not paint a background
      backgroundAlpha: 0,
      antialias: true,
      autoStart: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      resizeTo: document.body,
      powerPreference: 'high-performance'
    })
    this.app = app

    const model = await Live2DModel.from(assetUrl(modelPath), {
      // no pointer interaction inside a click-through window
      autoInteract: false,
      autoUpdate: true
    })
    this.model = model
    app.stage.addChild(model)

    this.fit()
    window.addEventListener('resize', () => this.fit())
    this.loaded = true
  }

  /** Scales the model to fill the window, anchored to the bottom centre. */
  private fit(): void {
    const app = this.app
    const model = this.model
    if (!app || !model) return
    const w = app.renderer.width / app.renderer.resolution
    const h = app.renderer.height / app.renderer.resolution
    const modelW = model.width || 1
    const modelH = model.height || 1
    // contain-fit: never crop the character
    const scale = Math.min(w / modelW, h / modelH)
    model.scale.set(scale)
    model.x = (w - modelW * scale) / 2
    model.y = h - modelH * scale
  }

  /** Character box in CSS pixels, for the host's click routing. */
  hitBox(): { x: number; y: number; width: number; height: number } {
    const model = this.model
    if (!model) return { x: 0, y: 0, width: 0, height: 0 }
    return {
      x: Math.round(model.x),
      y: Math.round(model.y),
      width: Math.round(model.width),
      height: Math.round(model.height)
    }
  }

  start(): void {
    if (!this.loaded) return
    this.app?.ticker.start()
  }

  stop(): void {
    this.app?.ticker.stop()
  }

  destroy(): void {
    this.app?.destroy(false, { children: true })
    this.app = null
    this.model = null
  }
}

function assetUrl(path: string): string {
  return `dola-mod://livepet/${path.replace(/^\/+/, '')}`
}
