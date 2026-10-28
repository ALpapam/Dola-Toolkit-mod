// ---------------------------------------------------------------------------
// `react-dom/client` shim — createRoot 必须来自宿主。
//
// React 19 的经典 `react-dom` 入口不再导出 createRoot，只有 `react-dom/client` 有。
// 宿主 bridge 已经把两个入口合并进 `ReactDOM`，并额外暴露 `ReactDOMClient`，
// 这里两种形状都接受，缺失时报一条能直接定位问题的错误。
// ---------------------------------------------------------------------------

import type { DolaHostBridge } from '../host'

type ClientModule = typeof import('react-dom/client')
type CreateRoot = ClientModule['createRoot']
type RootContainer = Parameters<CreateRoot>[0]
type RootOptions = Parameters<CreateRoot>[1]
type RootType = ReturnType<CreateRoot>

const host = window as Window & { __DOLA__?: DolaHostBridge }

function resolveCreateRoot(): CreateRoot | undefined {
  const bridge = host.__DOLA__
  if (!bridge) return undefined
  const dom = bridge.ReactDOM as Partial<ClientModule>
  return dom.createRoot ?? bridge.ReactDOMClient?.createRoot
}

export function createRoot(container: RootContainer, options?: RootOptions): RootType {
  const create = resolveCreateRoot()
  if (!create) {
    throw new Error(
      '[hello] 宿主桥未暴露 createRoot：请确认 window.__DOLA__.ReactDOM 合并了 react-dom/client'
    )
  }
  return create(container, options)
}

export function hydrateRoot(
  container: Parameters<ClientModule['hydrateRoot']>[0],
  initialChildren: Parameters<ClientModule['hydrateRoot']>[1],
  options?: Parameters<ClientModule['hydrateRoot']>[2]
): ReturnType<ClientModule['hydrateRoot']> {
  const bridge = host.__DOLA__
  const hydrate = bridge?.ReactDOM.hydrateRoot
  if (!hydrate) throw new Error('[hello] 宿主桥未暴露 hydrateRoot')
  return hydrate(container, initialChildren, options)
}
