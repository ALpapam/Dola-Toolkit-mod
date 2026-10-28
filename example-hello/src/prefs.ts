// ---------------------------------------------------------------------------
// hello mod — 插件自己的偏好设置
//
// 宿主没有给插件单独的 settings 存储，推荐做法是存 localStorage 并用
// `dola.<modId>.` 前缀命名空间（宿主自己也用 `dola.` 前缀，所以第二段必须是插件 id，
// 避免和宿主的 dola.railExpanded / dola.railOrder 撞车）。
//
// 注意：`window.api.settings` 是**宿主**的设置，schema 固定（appearance/ai/sync/
// proxy/library/reader/general），往里面塞自定义字段会被主进程的 sanitize 丢掉。
// ---------------------------------------------------------------------------

import { useCallback, useState } from 'react'

const KEY = 'dola.hello.prefs'

export interface ModPrefs {
  /** 打招呼用的语言 */
  greeting: string
  /** 主界面是否显示宿主版本 */
  showVersion: boolean
  /** 计数器每次+几 */
  step: number
}

export const DEFAULT_PREFS: ModPrefs = {
  greeting: '你好',
  showVersion: true,
  step: 1
}

function readPrefs(): ModPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<ModPrefs>
    return { ...DEFAULT_PREFS, ...parsed }
  } catch {
    return DEFAULT_PREFS
  }
}

/**
 * 读写插件偏好。
 *
 * 主界面与设置页由宿主分别 mount，切换页面时组件会重新挂载，所以每次 mount 读一次
 * 磁盘即可保持一致；同一页面内通过返回值更新。
 */
export function useModPrefs(): [ModPrefs, (patch: Partial<ModPrefs>) => void] {
  const [prefs, setPrefs] = useState<ModPrefs>(readPrefs)

  const update = useCallback((patch: Partial<ModPrefs>) => {
    setPrefs((old) => {
      const next = { ...old, ...patch }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* 存储不可用时只保留内存态 */
      }
      return next
    })
  }, [])

  return [prefs, update]
}

/** 清空插件偏好（设置页里的「恢复默认」用）。 */
export function resetPrefs(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
