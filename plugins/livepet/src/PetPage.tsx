// ---------------------------------------------------------------------------
// 桌宠 mod — 工具页
//
// The place behind the rail icon: shows whether the pet is running, lets the user show /
// hide it, and lists what is still missing (model upload).
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import { Button, Icon, toast } from './host'
import { petApi } from './settings'
import type { PetInfo } from './host'

export function PetPage(): JSX.Element {
  const [info, setInfo] = useState<PetInfo | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    try {
      setInfo(await petApi.state())
    } catch {
      /* service not ready */
    }
  }

  useEffect(() => {
    void refresh()
    const off = window.api.mod.on('livepet', 'state-changed', () => void refresh())
    const t = setInterval(() => void refresh(), 3000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])

  const pick = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await petApi.pickModel()
      if (res.canceled) return
      if (!res.ok) {
        toast.error(res.error ?? '导入失败')
        return
      }
      toast.success(`已导入「${res.name}」`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (): Promise<void> => {
    const res = info?.showing ? await petApi.hide() : await petApi.show()
    if (!res.ok) toast.error(res.error ?? '操作失败')
    await refresh()
  }

  const hasModel = Boolean(info?.modelFile)

  return (
    <div className="page" style={{ padding: 'var(--sp-6)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      <div className="hstack" style={{ gap: 14, alignItems: 'center' }}>
        <span
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 52,
            height: 52,
            borderRadius: 16,
            background: 'color-mix(in srgb, var(--md-primary) 14%, transparent)',
            color: 'var(--md-primary)'
          }}
        >
          <Icon name="favorite" size={26} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>桌宠</div>
          <div className="tiny muted">
            {hasModel ? `模型：${info?.modelDir}` : '还没有导入模型'}
          </div>
        </div>
      </div>

      {!hasModel ? (
        <div className="set-card" style={{ padding: 20 }}>
          <p style={{ margin: 0, lineHeight: 1.8 }}>
            先上传一个 Live2D 模型：选择一个包含 <code>.model3.json</code> 的文件夹。
            模型会复制到软件的数据目录，原文件夹可以随意移动或删除。
          </p>
          <div style={{ marginTop: 14 }}>
            <Button variant="filled" icon="folderData" loading={busy} onClick={() => void pick()}>
              上传 Live2D 模型
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="set-card" style={{ padding: 20 }}>
            <div className="hstack" style={{ gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{info?.showing ? '桌宠正在桌面上' : '桌宠已隐藏'}</div>
                <div className="tiny muted" style={{ marginTop: 4 }}>
                  角色以外的区域不会挡住鼠标点击
                </div>
              </div>
              <Button variant="filled" icon={info?.showing ? 'close' : 'play'} onClick={() => void toggle()}>
                {info?.showing ? '收起桌宠' : '放到桌面'}
              </Button>
            </div>
          </div>

          <div className="set-card" style={{ padding: 20 }}>
            <div className="hstack" style={{ gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 600 }}>换一个模型</div>
                <div className="tiny muted" style={{ marginTop: 4 }}>
                  当前模型会保留，可随时重新选择
                </div>
              </div>
              <Button variant="tonal" icon="folderData" loading={busy} onClick={() => void pick()}>
                上传模型
              </Button>
            </div>
          </div>
        </>
      )}

      <div className="tiny muted" style={{ marginTop: 'auto' }}>
        识屏、听音、聊天与语音设置正在开发中，可在「设置 → 工具 → 桌宠 → 设置」中查看进度。
      </div>
    </div>
  )
}
