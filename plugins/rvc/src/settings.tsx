// ---------------------------------------------------------------------------
// 音色转换 mod — 设置页
//
// 这里只做一件事：让用户指向本机的 RVC 整合包，并告诉他还缺什么。
// 插件不复制那个目录（十几个 GB），只借用它的 Python 环境。
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import { Badge, Button, Icon, SettingRow, Switch, toast } from './host'
import type { RvcState } from './host'
import { rvcApi } from './RvcPage'

export function RvcSettingsPage(): JSX.Element {
  const [state, setState] = useState<RvcState | null>(null)
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      setState(await rvcApi.state())
    } catch {
      /* 服务尚未加载 */
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const pickRoot = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.api.mod.invoke<{ ok: boolean; canceled?: boolean; root?: string; reason?: string; error?: string }>(
        'rvc',
        'set-root'
      )
      if (res.canceled) return
      if (!res.ok) {
        toast.error(res.reason ?? res.error ?? '这个目录不能用')
        return
      }
      toast.success('已设置 RVC 目录')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const runProbe = async (): Promise<void> => {
    setProbe({ ok: true, text: '正在检查…' })
    const res = await rvcApi.probe()
    if (!res.ok) {
      setProbe({ ok: false, text: res.error ?? '检查失败' })
      return
    }
    const info = res.info as { python?: string; torch?: string; cuda?: boolean; device?: string } | undefined
    const missing = (res.missing ?? []).length ? `；缺少：${(res.missing ?? []).join('、')}` : ''
    setProbe({
      ok: true,
      text: `Python ${info?.python ?? '?'} · torch ${info?.torch ?? '?'} · ${
        info?.cuda ? `GPU ${info?.device ?? ''}` : 'CPU 运行'
      }${missing}`
    })
  }

  return (
    <>
      <h2 className="set-section-title">
        <Icon name="recordVoiceOver" size={20} /> 音色转换
      </h2>
      <p className="set-section-desc">
        指定本机的 RVC 整合包目录。插件不复制它（通常十几 GB），只是借用里面的 Python 环境跑推理。
      </p>

      <div className="set-card">
        <SettingRow
          title="RVC 目录"
          desc={state?.root || '还没有设置'}
        >
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="tonal" size="sm" icon="folderData" loading={busy} onClick={() => void pickRoot()}>
              选择目录
            </Button>
          </div>
        </SettingRow>

        <SettingRow title="状态" desc={state?.rootOk ? '目录可用' : state?.rootReason || '不可用'}>
          {state?.rootOk ? <Badge tone="success">就绪</Badge> : <Badge tone="warning">未就绪</Badge>}
        </SettingRow>

        <SettingRow title="完成后打开输出位置" desc="转换成功时自动在资源管理器里定位结果">
          <Switch
            checked={Boolean(state?.openOnFinish)}
            onChange={(v) =>
              void window.api.mod
                .invoke<{ ok: boolean }>('rvc', 'set-params', { openOnFinish: v })
                .then(() => refresh())
            }
          />
        </SettingRow>

        <SettingRow title="运行时体检" desc="检查 Python、torch、CUDA 与必需模型">
          <Button variant="text" size="sm" icon="bolt" onClick={() => void runProbe()}>
            检查
          </Button>
        </SettingRow>
      </div>

      {probe ? (
        <div className="set-card">
          <div className="tools-format">
            <div>
              <div className="tools-format-title">{probe.ok ? '运行时信息' : '检查失败'}</div>
              <p className="tools-format-body" style={{ color: probe.ok ? undefined : 'var(--md-error)' }}>
                {probe.text}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {state?.missingModels && state.missingModels.length > 0 ? (
        <div className="set-card">
          <div className="tools-format">
            <div>
              <div className="tools-format-title">缺少必需模型</div>
              <p className="tools-format-body">
                {state.missingModels.map((m) => `${m.label}（${m.mb} MB）`).join('、')}
                <br />
                这些东西应该随 RVC 整合包一起存在；缺了说明目录不完整，或者选错了文件夹。
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="set-card">
        <div className="tools-format">
          <div>
            <div className="tools-format-title">这个插件做什么</div>
            <p className="tools-format-body">
              · 用 RVC 把一段音频换成指定音色<br />
              · 可选先分离人声再转换（BS-RoFormer / Mel-Band RoFormer Karaoke）<br />
              · 可选去混响、去回声（UVR-DeEcho-DeReverb）<br />
              <br />
              不包含训练、音色融合与实时变声。分离模型按需下载，不会有几十 GB 常驻。
            </p>
          </div>
        </div>
      </div>
    </>
  )
}
