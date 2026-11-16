// ---------------------------------------------------------------------------
// 音色转换 mod — 工具页
//
// 一屏完成：选音频 →（可选）分离人声 → 选音色 → 转换 → 听结果。
// 所有耗时操作都在主进程，这里只负责收集参数、展示进度与结果。
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import { Badge, Button, Icon, Select, SettingRow, Slider, Switch, toast } from './host'
import type { RvcState, SepModel, Voice } from './host'

interface Output {
  label: string
  path: string
}

export function RvcPage(): JSX.Element {
  const [state, setState] = useState<RvcState | null>(null)
  const [voices, setVoices] = useState<Voice[]>([])
  const [input, setInput] = useState<{ path: string; name: string } | null>(null)
  const [voice, setVoice] = useState<{ path: string; name: string; index?: string } | null>(null)
  const [sepModel, setSepModel] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [outputs, setOutputs] = useState<Output[]>([])
  const [playing, setPlaying] = useState<string | null>(null)
  const [probe, setProbe] = useState<{ text: string; ok: boolean } | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const [st, vs] = await Promise.all([rvcApi.state(), rvcApi.voices()])
      setState(st)
      setVoices(vs)
    } catch {
      /* 服务尚未加载 */
    }
  }

  useEffect(() => {
    void refresh()
    // 主进程会把分离/转换的阶段和进度广播过来
    const offStage = window.api.mod.on('rvc', 'stage', (payload) => {
      const p = payload as { label?: string }
      if (p?.label) setStage(p.label)
    })
    return offStage
  }, [])

  const pickInput = async (): Promise<void> => {
    const res = await rvcApi.pickAudio()
    if (res.canceled) return
    if (!res.ok || !res.path) {
      toast.error(res.error ?? '选择失败')
      return
    }
    setInput({ path: res.path, name: res.name ?? '' })
    setOutputs([])
  }

  const run = async (): Promise<void> => {
    if (!input || !voice) {
      toast.error('先选好输入音频和音色模型')
      return
    }
    setBusy(true)
    setOutputs([])
    setStage('准备中…')
    try {
      const res = await rvcApi.convert({
        inputPath: input.path,
        voicePath: voice.path,
        indexPath: voice.index ?? '',
        sepModel: sepModel || undefined
      })
      if (!res.ok) {
        toast.error(res.error ?? '转换失败')
        setStage('')
        return
      }
      setOutputs(res.outputs ?? [])
      setStage(`完成，用时 ${res.seconds} 秒`)
      toast.success('转换完成')
    } finally {
      setBusy(false)
    }
  }

  const play = async (path: string): Promise<void> => {
    setPlaying(path)
    try {
      const res = await rvcApi.readAudio(path)
      if (!res.ok || !res.audio) {
        toast.error(res.error ?? '无法播放')
        return
      }
      const audio = new Audio(res.audio)
      audio.onended = () => setPlaying(null)
      void audio.play().catch(() => {
        setPlaying(null)
        toast.error('播放被拒绝，请再点一次')
      })
    } finally {
      /* 播放状态在 onended 里清 */
    }
  }

  const doProbe = async (): Promise<void> => {
    setProbe({ ok: true, text: '正在检查运行时…' })
    const res = await rvcApi.probe()
    if (!res.ok) {
      setProbe({ ok: false, text: res.error ?? '检查失败' })
      return
    }
    const info = res.info as { python?: string; torch?: string; cuda?: boolean; device?: string } | undefined
    const missing = (res.missing ?? []).length ? `；缺少：${(res.missing ?? []).join('、')}` : ''
    setProbe({
      ok: true,
      text: `Python ${info?.python ?? '?'} · torch ${info?.torch ?? '?'} · ${info?.cuda ? `GPU ${info?.device ?? ''}` : 'CPU'}${missing}`
    })
  }

  /* ---- 未配置时的引导 ---- */
  if (state && !state.rootOk) {
    return (
      <>
        <h2 className="set-section-title">
          <Icon name="recordVoiceOver" size={20} /> 音色转换
        </h2>
        <p className="set-section-desc">
          用 RVC 把一段音频换成另一个人的音色。需要本机已经装好 RVC 整合包。
        </p>
        <div className="set-card">
          <div className="tools-format">
            <div>
              <div className="tools-format-title">{state.rootReason || '还没有指定 RVC 目录'}</div>
              <p className="tools-format-body">
                到「设置 → 工具 → 音色转换 → 设置」里指定 RVC 整合包的根目录
                （那个含 <code>runtime</code> 和 <code>infer</code> 的文件夹）。
                插件不会复制或修改它，只是借用它的 Python 环境做推理。
              </p>
            </div>
          </div>
        </div>
      </>
    )
  }

  const sepModels: SepModel[] = state?.sepModels ?? []

  return (
    <>
      <h2 className="set-section-title">
        <Icon name="recordVoiceOver" size={20} /> 音色转换
      </h2>
      <p className="set-section-desc">
        选一段音频和一个 RVC 音色模型，转成那个声音。可以在转换前先分离出人声，效果会好不少。
      </p>

      {/* 输入 */}
      <div className="set-card">
        <SettingRow title="输入音频" desc={input ? input.name : '还没有选择'}>
          <Button variant="tonal" size="sm" icon="folderData" onClick={() => void pickInput()}>
            选择文件
          </Button>
        </SettingRow>
        <SettingRow title="输出" desc="转换结果会放在插件数据目录，完成后自动定位">
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="text" size="sm" icon="bolt" onClick={() => void doProbe()}>
              检查运行时
            </Button>
          </div>
        </SettingRow>
      </div>

      {probe ? (
        <div className="set-card">
          <div className="tools-format">
            <div>
              <div className="tools-format-title">{probe.ok ? '运行时可用' : '运行时有问题'}</div>
              <p className="tools-format-body" style={{ color: probe.ok ? undefined : 'var(--md-error)' }}>
                {probe.text}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/* 音色 */}
      <div className="set-card">
        <SettingRow
          title="音色模型"
          desc={voice ? `${voice.name}${voice.index ? '（带索引）' : '（无索引）'}` : '从已有列表挑，或选任意 .pth'}
        >
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="text"
              size="sm"
              icon="folderData"
              onClick={() => {
                void rvcApi.pickVoice().then((res) => {
                  if (res.canceled) return
                  if (!res.ok || !res.path) {
                    toast.error(res.error ?? '选择失败')
                    return
                  }
                  setVoice({ path: res.path, name: res.name ?? '' })
                })
              }}
            >
              选择
            </Button>
          </div>
        </SettingRow>

        {voices.length > 0 ? (
          <SettingRow title="已有音色" desc={`${voices.length} 个（来自 RVC 的 assets/weights）`}>
            <div style={{ width: 260 }}>
              <Select
                value={voice?.path ?? ''}
                onChange={(v) => {
                  const hit = voices.find((x) => x.path === v)
                  setVoice(hit ? { path: hit.path, name: hit.name, index: hit.index } : null)
                }}
                options={[{ value: '', label: '未选择' }, ...voices.map((v) => ({ value: v.path, label: v.name }))]}
              />
            </div>
          </SettingRow>
        ) : null}
      </div>

      {/* 参数 */}
      <div className="set-card">
        <SettingRow title="音高" desc={`${state?.pitch ?? 0} 半音（男声→女声一般 +12）`}>
          <div style={{ width: 200 }}>
            <Slider
              value={state?.pitch ?? 0}
              min={-24}
              max={24}
              step={1}
              onChange={(v) => void rvcApi.setParams({ pitch: v }).then(() => refresh())}
            />
          </div>
        </SettingRow>

        <SettingRow title="音高提取算法" desc="rmvpe 最准，harvest 更适合清唱">
          <div style={{ width: 150 }}>
            <Select
              value={state?.f0Method ?? 'rmvpe'}
              onChange={(v) => void rvcApi.setParams({ f0Method: v }).then(() => refresh())}
              options={[
                { value: 'rmvpe', label: 'rmvpe' },
                { value: 'harvest', label: 'harvest' },
                { value: 'pm', label: 'pm' },
                { value: 'crepe', label: 'crepe' }
              ]}
            />
          </div>
        </SettingRow>

        <SettingRow title="索引混合比例" desc={`${((state?.indexRate ?? 0.75) * 100).toFixed(0)}%，越高越贴近音色但可能有杂音`}>
          <div style={{ width: 200 }}>
            <Slider
              value={Math.round((state?.indexRate ?? 0.75) * 100)}
              min={0}
              max={100}
              step={5}
              onChange={(v) => void rvcApi.setParams({ indexRate: v / 100 }).then(() => refresh())}
            />
          </div>
        </SettingRow>

        <SettingRow title="保护清辅音" desc={`${((state?.protect ?? 0.33) * 100).toFixed(0)}%，减少呼吸声与齿音失真`}>
          <div style={{ width: 200 }}>
            <Slider
              value={Math.round((state?.protect ?? 0.33) * 100)}
              min={0}
              max={50}
              step={1}
              onChange={(v) => void rvcApi.setParams({ protect: v / 100 }).then(() => refresh())}
            />
          </div>
        </SettingRow>
      </div>

      {/* 分离 */}
      <div className="set-card">
        <SettingRow
          title="转换前分离人声"
          desc={sepModel ? '先分离出人声再转换，伴奏会被丢弃' : '不分离，直接整段转换'}
        >
          <Switch checked={Boolean(sepModel)} onChange={(v) => setSepModel(v ? (sepModels[0]?.id ?? '') : '')} />
        </SettingRow>

        {sepModel ? (
          <SettingRow title="分离模型" desc={sepModels.find((m) => m.id === sepModel)?.note ?? ''}>
            <div style={{ width: 260 }}>
              <Select
                value={sepModel}
                onChange={setSepModel}
                options={sepModels.map((m) => ({ value: m.id, label: `${m.label} · ${m.sizeMB}MB` }))}
              />
            </div>
          </SettingRow>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 16, alignItems: 'center' }}>
        <Button variant="filled" icon="bolt" loading={busy} onClick={() => void run()}>
          开始转换
        </Button>
        {stage ? <span className="muted" style={{ fontSize: 12 }}>{stage}</span> : null}
      </div>

      {outputs.length > 0 ? (
        <div className="set-card" style={{ marginTop: 16 }}>
          {outputs.map((o) => (
            <SettingRow key={o.path} title={o.label} desc={o.path}>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  variant="text"
                  size="sm"
                  icon={playing === o.path ? 'pause' : 'play'}
                  onClick={() => void play(o.path)}
                >
                  试听
                </Button>
                <Button variant="text" size="sm" icon="folderData" onClick={() => void rvcApi.reveal(o.path)}>
                  定位
                </Button>
              </div>
            </SettingRow>
          ))}
        </div>
      ) : null}

      {state?.missingModels && state.missingModels.length > 0 ? (
        <div className="set-card" style={{ marginTop: 16 }}>
          <div className="tools-format">
            <div>
              <div className="tools-format-title">缺少必需模型</div>
              <p className="tools-format-body">
                {state.missingModels.map((m) => `${m.label}（${m.mb} MB）`).join('、')}
                <br />
                这些文件本应随 RVC 整合包一起提供，请检查目录是否完整。
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

/** 主进程处理器的小封装。 */
export const rvcApi = {
  state: () => window.api.mod.invoke<RvcState>('rvc', 'state'),
  voices: () => window.api.mod.invoke<Voice[]>('rvc', 'voices'),
  probe: () =>
    window.api.mod.invoke<{ ok: boolean; info?: unknown; missing?: string[]; error?: string }>('rvc', 'probe'),
  pickAudio: () =>
    window.api.mod.invoke<{ ok: boolean; path?: string; name?: string; canceled?: boolean; error?: string }>(
      'rvc',
      'pick-audio'
    ),
  pickVoice: () =>
    window.api.mod.invoke<{ ok: boolean; path?: string; name?: string; canceled?: boolean; error?: string }>(
      'rvc',
      'pick-voice'
    ),
  setParams: (patch: Record<string, unknown>) => window.api.mod.invoke<{ ok: boolean }>('rvc', 'set-params', patch),
  convert: (payload: Record<string, unknown>) =>
    window.api.mod.invoke<{
      ok: boolean
      outputs?: Output[]
      seconds?: number
      from?: string
      error?: string
    }>('rvc', 'convert', payload),
  readAudio: (path: string) =>
    window.api.mod.invoke<{ ok: boolean; audio?: string; error?: string }>('rvc', 'read-audio', path),
  reveal: (path: string) => window.api.mod.invoke<{ ok: boolean }>('rvc', 'reveal', path)
}
