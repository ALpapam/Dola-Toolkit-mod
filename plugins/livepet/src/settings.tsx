// ---------------------------------------------------------------------------
// 桌宠 mod — 设置页
//
// 上传模型、开关桌宠、调整大小与置顶。识屏 / 听音 / 聊天的配置会在这里逐步补齐，
// 它们共用一个「AI 与语音服务」区域。
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import { Button, Icon, SettingRow, Slider, Switch, toast } from './host'
import type { PetInfo, SttStatus } from './host'

export function PetSettingsPage(): JSX.Element {
  const [info, setInfo] = useState<PetInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [stt, setStt] = useState<SttStatus | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState(0)

  const refresh = async (): Promise<void> => {
    try {
      setInfo(await petApi.state())
    } catch {
      /* service not loaded yet */
    }
  }

  const refreshStt = async (): Promise<void> => {
    try {
      setStt(await petApi.sttStatus())
    } catch {
      /* service not loaded yet */
    }
  }

  useEffect(() => {
    void refresh()
    void refreshStt()
    const off = window.api.mod.on('livepet', 'state-changed', () => void refresh())
    // download progress arrives as a broadcast, so the bar moves without polling
    const offProgress = window.api.mod.on('livepet', 'stt-progress', (payload) => {
      const p = payload as { ratio: number }
      setProgress(p.ratio >= 0 ? p.ratio : 0)
    })
    return () => {
      off()
      offProgress()
    }
  }, [])

  const downloadModel = async (): Promise<void> => {
    setDownloading(true)
    setProgress(0)
    try {
      const res = await petApi.sttDownload(info?.sttModel ?? 'base-q5')
      if (!res.ok) {
        toast.error(res.error ?? '下载失败')
        return
      }
      toast.success('语音模型已就绪，可以点悬浮球上的麦克风了')
      await refreshStt()
    } finally {
      setDownloading(false)
    }
  }

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

      <h2 className="set-section-title" style={{ marginTop: 28 }}>
        <Icon name="autoAi" size={20} /> 听音
      </h2>
      <p className="set-section-desc">
        悬浮球上的麦克风按钮会录一段话，交给本地的 whisper 识别，再让 AI 回答。
        语音不上传，识别完全在这台电脑上完成。
      </p>

      <div className="set-card">
        <SettingRow
          title="语音模型"
          desc={
            !stt?.runtime
              ? '插件里缺少识别组件，请重新安装插件'
              : stt?.model
                ? `已就绪（${(stt.bytes / 1024 / 1024).toFixed(0)} MB）`
                : downloading
                  ? `正在下载… ${Math.round(progress * 100)}%`
                  : '还没下载，点右边按钮下载一次即可'
          }
        >
          {stt?.model ? (
            <Badge tone="success">已下载</Badge>
          ) : (
            <Button
              variant="tonal"
              size="sm"
              icon="download"
              loading={downloading}
              disabled={!stt?.runtime}
              onClick={() => void downloadModel()}
            >
              下载模型
            </Button>
          )}
        </SettingRow>

        <SettingRow
          title="模型大小"
          desc={
            info?.sttModel === 'tiny-q5'
              ? 'tiny：32 MB，更快，个别字可能听错'
              : 'base：59 MB，准确度更高（推荐）'
          }
        >
          <div style={{ width: 200 }}>
            <Slider
              value={info?.sttModel === 'tiny-q5' ? 1 : 2}
              min={1}
              max={2}
              step={1}
              onChange={(v) => {
                const id = v === 1 ? 'tiny-q5' : 'base-q5'
                void petApi.sttSetModel(id).then(() => {
                  void refresh()
                  void refreshStt()
                })
              }}
            />
          </div>
        </SettingRow>
      </div>

      <div className="set-card">
        <div className="tools-format">
          <div>
            <div className="tools-format-title">第一次使用听音</div>
            <p className="tools-format-body">
              1. 在上面点「下载模型」（59 MB，从国内镜像下载，一次就好）。<br />
              2. 点悬浮球，展开后点麦克风，说一句话。<br />
              3. 再点一次麦克风结束录音，识别结果和回答会显示在球下面。<br />
              如果提示「打不开麦克风」，到 Windows 设置 → 隐私 → 麦克风 里允许桌面应用使用麦克风。
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
  setOnTop: (on: boolean) => window.api.mod.invoke<{ ok: boolean }>('livepet', 'set-on-top', on),
  /* ---- 听音 ---- */
  sttStatus: () => window.api.mod.invoke<SttStatus>('livepet', 'stt-status'),
  sttDownload: (modelId: string) =>
    window.api.mod.invoke<{ ok: boolean; modelId?: string; error?: string }>('livepet', 'stt-download', modelId),
  sttSetModel: (modelId: string) =>
    window.api.mod.invoke<{ ok: boolean; modelId?: string; error?: string }>('livepet', 'stt-set-model', modelId)
}
