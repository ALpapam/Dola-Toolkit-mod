/// <reference types="vite/client" />

// React 19 从 @types/react 里移除了全局 JSX 命名空间，宿主自己补了一份
// （dola-toolkit/src/renderer/src/global.d.ts）。插件独立构建，所以要自带这份增强，
// 否则 `JSX.Element` 这类写法会报 "Cannot find namespace 'JSX'"。

import type { JSX as ReactJSX } from 'react'

declare global {
  namespace JSX {
    type Element = ReactJSX.Element
    type ElementType = ReactJSX.ElementType
    interface ElementClass extends ReactJSX.ElementClass {}
    interface ElementAttributesProperty extends ReactJSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute extends ReactJSX.ElementChildrenAttribute {}
    interface IntrinsicAttributes extends ReactJSX.IntrinsicAttributes {}
    interface IntrinsicClassAttributes<T> extends ReactJSX.IntrinsicClassAttributes<T> {}
    interface IntrinsicElements extends ReactJSX.IntrinsicElements {}
  }
}

export {}
