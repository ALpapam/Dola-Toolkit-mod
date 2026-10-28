// ---------------------------------------------------------------------------
// `react-dom` shim — createPortal 等命令式 API 来自宿主。
//
// 宿主的 Dialog / Menu / Sheet 都用 createPortal 渲染到 document.body，
// 插件调用它们时 portal 也必须落在**宿主**root 之外，所以要用宿主的实现。
// createRoot 在 react-dom/client，见 ./react-dom-client.ts。
// ---------------------------------------------------------------------------

import type { DolaHostBridge } from '../host'

type ReactDOMModule = typeof import('react-dom')

const host = window as Window & { __DOLA__?: DolaHostBridge }

function hostReactDOM(): ReactDOMModule {
  const bridge = host.__DOLA__
  if (!bridge) throw new Error('[hello] 宿主桥未安装：window.__DOLA__ 缺失')
  return bridge.ReactDOM
}

const D = hostReactDOM()

export default D

export const {
  createPortal,
  flushSync,
  preconnect,
  prefetchDNS,
  preinit,
  preinitModule,
  preload,
  preloadModule,
  requestFormReset,
  unstable_batchedUpdates,
  useFormState,
  useFormStatus,
  version
} = D
