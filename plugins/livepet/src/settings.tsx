// ---------------------------------------------------------------------------
// 桌宠 mod — 设置页
//
// 上传模型、开关桌宠、调整大小与置顶。识屏 / 听音 / 聊天的配置会在这里逐步补齐，
// 它们共用一个「AI 与语音服务」区域。
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import { Button, Icon, SettingRow, Slider, Switch, toast } from './host'
import type { PetInfo } from './host'

export function PetSettingsPage(): JSX.Element {
  const [info, setInfo] = useState<PetInfo | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    try {
      setInfo(await petApi.state())
    } catch {
      /* service not loaded yet */
    }
  }

  useEffect(() => {
    void refresh()
    const off = window.api.mod.on('livepet', 'state-changed', () => void refresh())
    return off
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

  const toggleShow = async (on: boolean): Promise<void> => {
    const res = on ? await petApi.show() : await petApi.hide()
    if (!res.ok) toast.error(res.error ?? '操作失败')
    await refresh()
  }

  return (
    <>
      <h2 className="set-section-title">
        <Icon name="favorite" size={20} /> 桌宠
      </h2>
      <p className="set-section-desc">把 Live2D 模型放到桌面上。角色之外的区域不会挡住你的鼠标。</p>

      <div className="set-card">
        <SettingRow
          title="模型"
          desc={info?.modelFile ? `当前：${info.modelDir}` : '还没有导入模型'}
        >
          <Button variant="tonal" size="sm" icon="folderData" loading={busy} onClick={() => void pick()}>
            上传模型
          </Button>
        </SettingRow>

        <SettingRow title="显示桌宠" desc={info?.showing ? '正在桌面上显示' : '已隐藏'}>
          <Switch checked={Boolean(info?.showing)} onChange={(v) => void toggleShow(v)} />
        </SettingRow>

        <SettingRow title="大小" desc={`${Math.round((info?.scale ?? 1) * 100)}%`}>
          <div style={{ width: 200 }}>
            <Slider
              value={Math.round((info?.scale ?? 1) * 100)}
              min={50}
              max={200}
              step={10}
              onChange={(v) => {
                void petApi.setScale(v / 100).then(() => refresh())
              }}
            />
          </div>
        </SettingRow>

        <SettingRow title="保持置顶" desc="关闭后会被其他窗口盖住">
          <Switch
            checked={Boolean(info?.alwaysOnTop)}
            onChange={(v) => void petApi.setOnTop(v).then(() => refresh())}
          />
        </SettingRow>
      </div>

      <div className="set-card">
        <div className="tools-format">
          <div>
            <div className="tools-format-title">支持哪些模型</div>
            <p className="tools-format-body">
              选择包含 <code>.model3.json</code> 的文件夹即可（Cubism 4）。
              导入时会自动跳过 <code>.cmo3</code>、<code>.psd</code> 等编辑用大文件，只保留运行时需要的资源。
            </p>
          </div>
        </div>
      </div>
    </>
  )
}

/** Typed wrapper over the mod's main-process handlers. */
export const petApi = {
  state: () => window.api.mod.invoke<PetInfo>('livepet', 'state'),
  pickModel: () =>
    window.api.mod.invoke<{ ok: boolean; canceled?: boolean; name?: string; error?: string }>('livepet', 'pick-model'),
  show: () => window.api.mod.invoke<{ ok: boolean; error?: string }>('livepet', 'show'),
  hide: () => window.api.mod.invoke<{ ok: boolean }>('livepet', 'hide'),
  setScale: (scale: number) => window.api.mod.invoke<{ ok: boolean; scale: number }>('livepet', 'set-scale', scale),
  setOnTop: (on: boolean) => window.api.mod.invoke<{ ok: boolean }>('livepet', 'set-on-top', on)
}
