// ---------------------------------------------------------------------------
// 桌宠 mod — 工具页入口
//
// 渲染层 bundle：工具页（PetPage）+ 设置页（PetSettingsPage）。桌宠本体不在这个
// bundle 里，它在宿主另开的透明窗口里加载 pet.html。
// ---------------------------------------------------------------------------

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { PetPage } from './PetPage'
import { PetSettingsPage } from './settings'

interface ModModule {
  mount: (container: HTMLElement) => () => void
  mountSettings: (container: HTMLElement) => () => void
}

export function mount(container: HTMLElement): () => void {
  const root = createRoot(container)
  root.render(createElement(PetPage))
  return () => root.unmount()
}

export function mountSettings(container: HTMLElement): () => void {
  const root = createRoot(container)
  root.render(createElement(PetSettingsPage))
  return () => root.unmount()
}

const registry = ((window as unknown as { __DOLA_MODS__?: Record<string, ModModule> }).__DOLA_MODS__ ??= {})
registry['livepet'] = { mount, mountSettings }
