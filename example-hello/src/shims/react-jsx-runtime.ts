// ---------------------------------------------------------------------------
// `react/jsx-runtime` shim — 自动 JSX 转换的落点。
//
// 编译器把 `const a = <div />` 变成 `import { jsx } from 'react/jsx-runtime'`。
// 这里把 jsx/jsxs/jsxDEV 全部转发给宿主的 React.createElement，元素对象才由
// 宿主那份 React 创建，宿主组件与插件组件共享同一个 reconciler。
// ---------------------------------------------------------------------------

import type { DolaHostBridge } from '../host'

type ReactModule = typeof import('react')
type ElementType = import('react').ElementType

const host = window as Window & { __DOLA__?: DolaHostBridge }

function hostReact(): ReactModule {
  const bridge = host.__DOLA__
  if (!bridge) throw new Error('[hello] 宿主桥未安装：window.__DOLA__ 缺失')
  return bridge.React
}

const R = hostReact()

export const Fragment = R.Fragment

/**
 * `key` 由 runtime 单独传入，而 React.createElement 从 props 里读它，
 * 所以必须把它折回 config；`children` 已经在 props 里面（自动 runtime 不单独传）。
 */
function jsx(type: ElementType, props: unknown, key?: string | number | bigint | null): JSX.Element {
  const config =
    key === undefined
      ? props
      : { ...((props as Record<string, unknown> | null | undefined) ?? {}), key }
  return R.createElement(type, config as Parameters<ReactModule['createElement']>[1])
}

export { jsx, jsx as jsxs }

/** 开发期 runtime（jsx-dev-runtime）也会被别名到这里。 */
export function jsxDEV(
  type: ElementType,
  props: unknown,
  key?: string | number | bigint | null,
  _isStaticChildren?: boolean,
  _source?: unknown,
  _self?: unknown
): JSX.Element {
  return jsx(type, props, key)
}

export default { jsx, jsxs: jsx, jsxDEV, Fragment }
