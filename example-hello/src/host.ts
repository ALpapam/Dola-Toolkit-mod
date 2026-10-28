// ---------------------------------------------------------------------------
// hello mod — 宿主桥适配层（bridge adapter）
//
// 插件永远不打包自己的 React / UI 组件库 / 应用状态：宿主在渲染任何页面之前会先安装
// 一个全局对象 `window.__DOLA__`，这里就是唯一读取它的地方。
//
// 为什么必须这样做：
//   * 一个页面里出现两份 React → hooks 报 "Invalid hook call"（调试时最难查的坑之一）
//   * UI 组件来自宿主 → 主题、深浅色、圆角、密度自动跟随，插件不需要任何样式表
//   * useApp 是宿主的 zustand store → 插件能读到 settings / page / mods，并与宿主同步
//
// 关于类型：下面的 props 接口是照着宿主源码
//   dola-toolkit/src/renderer/src/ui/controls.tsx
//   dola-toolkit/src/renderer/src/ui/Icon.tsx
//   dola-toolkit/src/renderer/src/ui/hooks.tsx
//   dola-toolkit/src/preload/index.d.ts
// 手写的一份「结构副本」，好处是插件仓库不需要宿主源码就能通过 tsc。
// 如果你把插件放在宿主仓库里（像 mods/library 那样），可以改成
//   import type { ButtonProps } from '@host/ui/controls'
// 的 type-only 引用，见 README 的「类型从哪来」一节。
// ---------------------------------------------------------------------------

import type {
  CSSProperties,
  InputHTMLAttributes,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
  TextareaHTMLAttributes
} from 'react'

/* ========================================================================== */
/* UI 组件 props（逐条对齐宿主 ui/controls.tsx）                               */
/* ========================================================================== */

export type BtnVariant = 'filled' | 'tonal' | 'outlined' | 'text' | 'elevated' | 'danger'
/** 宿主 Material Symbols 图标名，如 "add" / "settings" / "sparkle"。未知名字会退化成 info。 */
export type IconName = string

export interface IconProps {
  name: IconName
  /** 数字按 px 处理，默认 20 */
  size?: number | string
  className?: string
  style?: CSSProperties
  title?: string
}

export interface ButtonProps {
  /** 默认 'filled' */
  variant?: BtnVariant
  icon?: IconName
  /** 默认 'md' */
  size?: 'sm' | 'md' | 'xs'
  loading?: boolean
  disabled?: boolean
  className?: string
  title?: string
  type?: 'button' | 'submit' | 'reset'
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void
  children?: ReactNode
}

export interface IconButtonProps {
  icon: IconName
  /** 默认 20 */
  size?: number
  small?: boolean
  active?: boolean
  /** 同时作为 title 与 aria-label */
  label?: string
  className?: string
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void
}

export interface FieldProps {
  label?: string
  hint?: string
  error?: string | null
  prefixIcon?: IconName
  suffix?: ReactNode
  outlined?: boolean
  className?: string
  children: ReactNode
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: string
  error?: string | null
  prefixIcon?: IconName
  suffix?: ReactNode
  outlined?: boolean
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  hint?: string
  outlined?: boolean
}

export interface SelectProps {
  label?: string
  hint?: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  outlined?: boolean
}

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
}

export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
}

export interface SliderProps {
  value: number
  /** 默认 0 */
  min?: number
  /** 默认 100 */
  max?: number
  /** 默认 1 */
  step?: number
  onChange: (value: number) => void
  style?: CSSProperties
}

export interface SegmentedProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: { value: T; icon?: IconName; label?: string }[]
}

export interface TabsProps<T extends string> {
  value: T
  onChange: (value: T) => void
  items: { value: T; label: string; icon?: IconName }[]
}

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  icon?: IconName
  children: ReactNode
  footer?: ReactNode
  /** 默认 'normal' */
  width?: 'normal' | 'wide' | 'slim'
}

export interface SheetProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  icon?: IconName
}

export interface MenuItem {
  label: string
  icon?: IconName
  onClick?: () => void
  danger?: boolean
  separator?: boolean
  disabled?: boolean
}

export interface MenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export interface EmptyProps {
  /** 默认 'autoAi' */
  icon?: IconName
  title: string
  desc?: string
  action?: ReactNode
}

export interface SpinnerProps {
  /** 默认 18 */
  size?: number
}

export interface BadgeProps {
  children: ReactNode
  /** 默认 'default' */
  tone?: 'default' | 'ok' | 'err' | 'warn'
  dot?: boolean
}

export interface ProgressProps {
  /** 0..1 */
  value?: number
  indeterminate?: boolean
}

export interface ChipProps {
  selected?: boolean
  onClick?: () => void
  icon?: IconName
  children: ReactNode
  danger?: boolean
}

export interface SettingRowProps {
  title: string
  desc?: string
  children?: ReactNode
  stacked?: boolean
}

/** 宿主 UI 组件集合（`window.__DOLA__.ui`）。 */
export interface DolaUiKit {
  Button: (props: ButtonProps) => ReactElement
  IconButton: (props: IconButtonProps) => ReactElement
  Field: (props: FieldProps) => ReactElement
  TextInput: (props: TextInputProps) => ReactElement
  TextArea: (props: TextAreaProps) => ReactElement
  Select: (props: SelectProps) => ReactElement
  Switch: (props: SwitchProps) => ReactElement
  Checkbox: (props: CheckboxProps) => ReactElement
  Slider: (props: SliderProps) => ReactElement
  Segmented: <T extends string>(props: SegmentedProps<T>) => ReactElement
  Tabs: <T extends string>(props: TabsProps<T>) => ReactElement
  Dialog: (props: DialogProps) => ReactElement | null
  Sheet: (props: SheetProps) => ReactElement | null
  Menu: (props: MenuProps) => ReactElement
  Badge: (props: BadgeProps) => ReactElement
  Empty: (props: EmptyProps) => ReactElement
  Progress: (props: ProgressProps) => ReactElement
  Spinner: (props: SpinnerProps) => ReactElement
  SettingRow: (props: SettingRowProps) => ReactElement
  Icon: (props: IconProps) => ReactElement
  /** 由字符串得到稳定色相（0..359），用来给头像/封面之类生成颜色 */
  hashHue: (input: string) => number
  /** 全局快捷键；输入框聚焦时自动忽略 */
  useHotkey: (combo: string, handler: () => void, enabled?: boolean) => void
}

/* ========================================================================== */
/* toast / 应用状态                                                            */
/* ========================================================================== */

export interface DolaToast {
  info: (message: string) => void
  success: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

/** 侧边栏里一个已安装插件的快照（宿主 ModRecord / ModEntry）。 */
export interface HostModEntry {
  id: string
  name: string
  version: string
  description: string
  icon: string
  settingsIcon: string
  settingsName: string
  createdAt: string
  entry: string
  firstRun: boolean
  enabled: boolean
  installedAt: number
}

/**
 * 宿主设置的「用到的子集」。
 *
 * 完整定义在宿主 src/shared/types.ts 的 `Settings`。这里只声明示例会碰到的字段，
 * 够用且不会随着宿主加字段而崩；需要更多字段时照着宿主源码补。
 */
export interface HostSettings {
  schema: 1
  appearance: {
    themeMode: 'system' | 'light' | 'dark'
    monet: boolean
    seedSource: 'auto' | 'wallpaper' | 'accent' | 'custom'
    preset: string
    customSeed: string
    contrast: number
    roundness: number
    reduceMotion: boolean
  }
  general: {
    language: 'zh' | 'en'
    zoom: number
    closeToTray: boolean
    downloadChannel: 'github' | 'mirror'
    launchAtLogin: boolean
    checkUpdates: boolean
  }
  reader: {
    fontFamily: string
    fontSize: number
    lineHeight: number
    flipAnimation: 'slide' | 'cover' | 'curl' | 'none'
    gpuAcceleration: boolean
  }
}

/** 宿主 store（`useApp` 的 state 子集）。 */
export interface HostAppState {
  page: string
  settings: HostSettings | null
  railExpanded: boolean
  railOrder: string[]
  mods: HostModEntry[]
  ready: boolean
  setPage: (page: string) => void
  setSettings: (settings: HostSettings) => void
  setMods: (mods: HostModEntry[]) => void
  refreshMods: () => Promise<void>
}

export type UseApp = <T>(selector: (state: HostAppState) => T) => T

/* ========================================================================== */
/* window.api（preload 暴露；这里只声明示例用到的分组）                         */
/* ========================================================================== */

export interface DolaApiLite {
  mods: {
    list: () => Promise<HostModEntry[]>
    openFolder: () => Promise<string>
    onChanged: (cb: () => void) => () => void
  }
  app: {
    info: () => Promise<{
      version: string
      electron: string
      chrome: string
      node: string
      platform: string
      arch: string
      userData: string
      logsDir: string
    }>
    openExternal: (url: string) => Promise<void>
  }
  settings: {
    get: () => Promise<HostSettings>
    onChanged: (cb: (settings: HostSettings) => void) => () => void
  }
  env: {
    platform: string
    versions: Record<string, string>
  }
}

/* ========================================================================== */
/* 全局桥                                                                      */
/* ========================================================================== */

export interface DolaHostBridge {
  /** 宿主自己的 React 实例（19.x） */
  React: typeof import('react')
  /** react-dom 与 react-dom/client 合并后的对象：createRoot / createPortal 都在这里 */
  ReactDOM: typeof import('react-dom') & Partial<typeof import('react-dom/client')>
  ReactDOMClient: typeof import('react-dom/client')
  ui: DolaUiKit
  toast: DolaToast
  useApp: UseApp
  /** 宿主版本号，例如 "0.2.1" */
  version: string
}

declare global {
  interface Window {
    __DOLA__?: DolaHostBridge
    /** 插件在这里注册自己的模块：__DOLA_MODS__["hello"] = { mount, mountSettings } */
    __DOLA_MODS__?: Record<string, unknown>
    /** preload 暴露的 IPC 能力 */
    api: DolaApiLite
  }
}

/** 取宿主桥；不在 Dola Toolkit 里运行时会给出明确报错。 */
export function getHostBridge(): DolaHostBridge {
  const bridge = window.__DOLA__
  if (!bridge) {
    throw new Error(
      '[hello] 宿主桥未安装：window.__DOLA__ 缺失。插件只能由 Dola Toolkit 渲染器加载。'
    )
  }
  return bridge
}

const bridge = getHostBridge()

/* ---------------------------------------------------------------- */
/* React / ReactDOM                                                  */
/* ---------------------------------------------------------------- */
export const React = bridge.React
export const ReactDOM = bridge.ReactDOM
export const ReactDOMClient = bridge.ReactDOMClient

/* ---------------------------------------------------------------- */
/* UI 组件（window.__DOLA__.ui）                                      */
/* ---------------------------------------------------------------- */
export const Button = bridge.ui.Button
export const IconButton = bridge.ui.IconButton
export const Field = bridge.ui.Field
export const TextInput = bridge.ui.TextInput
export const TextArea = bridge.ui.TextArea
export const Select = bridge.ui.Select
export const Switch = bridge.ui.Switch
export const Checkbox = bridge.ui.Checkbox
export const Slider = bridge.ui.Slider
export const Segmented = bridge.ui.Segmented
export const Tabs = bridge.ui.Tabs
export const Dialog = bridge.ui.Dialog
export const Sheet = bridge.ui.Sheet
export const Menu = bridge.ui.Menu
export const Badge = bridge.ui.Badge
export const Empty = bridge.ui.Empty
export const Progress = bridge.ui.Progress
export const Spinner = bridge.ui.Spinner
export const SettingRow = bridge.ui.SettingRow
export const Icon = bridge.ui.Icon
export const hashHue = bridge.ui.hashHue
export const useHotkey = bridge.ui.useHotkey

/* ---------------------------------------------------------------- */
/* toast / store / 版本                                              */
/* ---------------------------------------------------------------- */
export const toast = bridge.toast
export const useApp = bridge.useApp
/** 宿主版本号，便于在插件里做版本判断或在设置页展示 */
export const hostVersion: string = bridge.version
