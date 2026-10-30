// ---------------------------------------------------------------------------
// 代理 mod — 宿主适配层
//
// The mod never bundles React or the UI kit: everything shared is read from the
// single `window.__DOLA__` global the host installs before any mod script runs. This
// file is the only place that knows about that global.
//
// The `@host/*` imports are type-only (erased at build time); they exist so the props
// and icon names are checked against the host's real definitions.
// ---------------------------------------------------------------------------

import type { IconName } from '@host/ui/Icon'

export type { IconName }

import type * as Controls from '@host/ui/controls'
import type * as HostIcon from '@host/ui/Icon'
import type * as HostToast from '@host/ui/toast'
import type * as HostFormat from '@host/ui/format'
import type * as HostHooks from '@host/ui/hooks'
import type * as HostApp from '@host/state/app'

export interface DolaHostBridge {
  React: typeof import('react')
  ReactDOM: typeof import('react-dom') & Partial<typeof import('react-dom/client')>
  ui: typeof Controls & {
    Icon: typeof HostIcon.Icon
    hashHue: typeof HostFormat.hashHue
    useHotkey: typeof HostHooks.useHotkey
  }
  toast: typeof HostToast.toast
  useApp: typeof HostApp.useApp
  version: string
}

declare global {
  interface Window {
    __DOLA__?: DolaHostBridge
    __DOLA_MODS__?: Record<string, unknown>
  }
}

function bridge(): DolaHostBridge {
  const b = window.__DOLA__
  if (!b) throw new Error('[proxy] 宿主桥未安装：window.__DOLA__ 缺失（mod 只能在 Dola Toolkit 渲染器中加载）')
  return b
}

const host = bridge()

/* ---- UI kit ---- */
export const Button = host.ui.Button
export const IconButton = host.ui.IconButton
export const TextInput = host.ui.TextInput
export const TextArea = host.ui.TextArea
export const Select = host.ui.Select
export const Slider = host.ui.Slider
export const Segmented = host.ui.Segmented
export const Tabs = host.ui.Tabs
export const Dialog = host.ui.Dialog
export const Menu = host.ui.Menu
export const Empty = host.ui.Empty
export const Spinner = host.ui.Spinner
export const Switch = host.ui.Switch
export const SettingRow = host.ui.SettingRow
export const Badge = host.ui.Badge
export const Field = host.ui.Field
export const Chip = host.ui.Chip

/* ---- shared helpers ---- */
export const Icon = host.ui.Icon
export const toast = host.toast
export const hashHue = host.ui.hashHue
export const useHotkey = host.ui.useHotkey
export const useApp = host.useApp
export const hostVersion: string = host.version

/* ---- formatting helpers: pure functions, copied into the mod on purpose so it
   does not depend on host internals ---- */
export {
  engineLabel,
  fmtBytes,
  fmtDate,
  fmtClock,
  fmtDuration,
  formatProtocol
} from './format'
/* ------------------------------------------------------------------ */
/* Proxy service bridge                                                */
/*                                                                     */
/* The feature's main-process half is a mod service now, reached through */
/* the host's generic `window.api.mod` bridge instead of a bespoke      */
/* `window.api.proxy` namespace. Keeping the same method names here     */
/* means the UI did not have to change shape.                           */
/* ------------------------------------------------------------------ */

const MOD_ID = 'proxy'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return window.api.mod.invoke<T>(MOD_ID, channel, ...args)
}

export const proxyApi = {
  state: () => invoke('state'),
  engines: () => invoke('engines'),
  saveNode: (node: unknown) => invoke('save-node', node),
  deleteNode: (id: string) => invoke('delete-node', id),
  importLinks: (text: string) => invoke('import-links', text),
  selectNode: (id: string | null) => invoke('select-node', id),
  start: () => invoke('start'),
  stop: () => invoke('stop'),
  testNode: (id: string) => invoke('test-node', id),
  setSystemProxy: (on: boolean) => invoke('system-proxy', on),
  importGeo: () => invoke('import-geo'),
  updateGeo: () => invoke('update-geo'),
  clearLogs: (engine: string) => invoke('clear-logs', engine),
  onState: (cb: (s: unknown) => void) => window.api.mod.on(MOD_ID, 'state-changed', cb),
  onLog: (cb: (e: unknown) => void) => window.api.mod.on(MOD_ID, 'log', cb)
}

/* ---- core updates: the plugin owns these too ---- */

export const coreUpdateApi = {
  check: () => invoke('check-core-updates'),
  stageCore: (engine: string) => invoke('stage-core', engine),
  stageAll: () => invoke('stage-all-cores'),
  staged: () => invoke('staged-cores'),
  clearStaged: () => invoke('clear-staged'),
  applyStaged: () => invoke('apply-staged'),
  onProgress: (cb: (p: unknown) => void) => window.api.mod.on(MOD_ID, 'update-progress', cb)
}
