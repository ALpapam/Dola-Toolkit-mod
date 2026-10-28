// ---------------------------------------------------------------------------
// `react` shim — 所有 React 调用都走宿主那一份实例。
//
// vite.config.ts 把裸说明符 `react` 精确别名到本文件，因此 JSX runtime、hooks、
// 任何第三方库内部的 `import React from 'react'` 全部落到宿主的 React 上。
// 一个页面两份 React → "Invalid hook call" / "Rendered more hooks than during
// the previous render"，所以这个 shim 是硬性要求，不是优化。
//
// 下面的 `import type` 在构建时被完全擦除（只用来拿类型），不会产生自引用。
// ---------------------------------------------------------------------------

import type { DolaHostBridge } from '../host'

type ReactModule = typeof import('react')

const host = window as Window & { __DOLA__?: DolaHostBridge }

function hostReact(): ReactModule {
  const bridge = host.__DOLA__
  if (!bridge) throw new Error('[hello] 宿主桥未安装：window.__DOLA__ 缺失')
  return bridge.React
}

const R = hostReact()

export default R

// React 19 的具名导出；宿主升级 React 时这里可能需要补名字，
// 但走 default（`R.xxx`）永远安全。
export const {
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  ViewTransition,
  act,
  cache,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version
} = R
