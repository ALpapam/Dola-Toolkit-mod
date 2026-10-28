// ---------------------------------------------------------------------------
// hello mod — 入口（bundle 的 root module）
//
// 宿主加载流程（src/renderer/src/modHost/ModHost.tsx）：
//   1. <script src="dola-mod://hello/index.js">  ← 本文件被构建出来的 IIFE
//   2. bundle 执行，把自己注册进 window.__DOLA_MODS__['hello']
//   3. 宿主调用 mount(container) / mountSettings(container)，各自返回卸载函数
//
// 注意：
//   * 必须**同步**返回卸载函数（createRoot().render 是异步提交的，但函数本身同步返回）
//   * 注册的 key 必须和 dola-mod.json 的 id 完全一致，否则宿主会报
//     「插件没有正确注册，可能不是有效的 Dola Toolkit 插件」
// ---------------------------------------------------------------------------

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { HelloPage } from './HelloPage'
import { HelloSettingsPage } from './SettingsPage'

export function mount(container: HTMLElement): () => void {
  const root = createRoot(container)
  root.render(createElement(HelloPage))
  return () => root.unmount()
}

export function mountSettings(container: HTMLElement): () => void {
  const root = createRoot(container)
  root.render(createElement(HelloSettingsPage))
  return () => root.unmount()
}

export interface HelloMod {
  mount(container: HTMLElement): () => void
  mountSettings(container: HTMLElement): () => void
}

const mod: HelloMod = { mount, mountSettings }

// 用 ??= 保留已有注册表：开发时 bundle 被重复加载也不会炸掉别的插件
;(window.__DOLA_MODS__ ??= {})['hello'] = mod

export default mod
