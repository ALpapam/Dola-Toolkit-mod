// ---------------------------------------------------------------------------
// 音色转换 mod — 工具页与设置页入口
// ---------------------------------------------------------------------------

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { RvcPage } from './RvcPage'
import { RvcSettingsPage } from './settings'

interface ModModule {
  mount: (container: HTMLElement) => () => void
  mountSettings: (container: HTMLElement) => () => void
}

export function mount(container: HTMLElement): () => void {
  const root = createRoot(container)
  root.render(createElement(RvcPage))
  return () => root.unmount()
}

export function mountSettings(container: HTMLElement): () => void {
  const root = createRoot(container)
  root.render(createElement(RvcSettingsPage))
  return () => root.unmount()
}

const registry = ((window as unknown as { __DOLA_MODS__?: Record<string, ModModule> }).__DOLA_MODS__ ??= {})
registry['rvc'] = { mount, mountSettings }
