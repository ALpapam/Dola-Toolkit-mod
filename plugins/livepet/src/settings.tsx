// ---------------------------------------------------------------------------
// 桌宠 mod — 设置页
//
// 上传模型、开关桌宠、调整大小与置顶。识屏 / 听音 / 聊天的配置会在这里逐步补齐，
// 它们共用一个「AI 与语音服务」区域。
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import { Badge, Button, Icon, Select, SettingRow, Slider, Switch, TextInput, toast } from './host'
import type { PetInfo, SttStatus, TtsConfig, TtsStatus, Turn } from './host'

export function PetSettingsPage(): JSX.Element {
  const [info, setInfo] = useState<PetInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [stt, setStt] = useState<SttStatus | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [tts, setTts] = useState<TtsStatus | null>(null)
  const [cfg, setCfg] = useState<TtsConfig | null>(null)
  const [endpoint, setEndpoint] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string; error: string | null } | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [turnCount, setTurnCount] = useState(0)

  const refresh = async (): Promise<void> => {
    try {
      const st = await petApi.state()
      setInfo(st)
      if (st.tts) {
        setCfg(st.tts)
        setEndpoint((prev) => prev || st.tts.endpoint)
      }
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

  const refreshTts = async (): Promise<void> => {
    try {
      setTts(await petApi.ttsStatus())
    } catch {
      /* service not loaded yet */
    }
  }

  const refreshMemory = async (): Promise<void> => {
    try {
      const m = await petApi.memory()
      setTurns(m.turns)
      // a "turn" is what the user said, so count their side only
      setTurnCount(m.turns.filter((t) => t.role === 'user').length)
    } catch {
      /* service not loaded yet */
    }
  }

  useEffect(() => {
    void refresh()
    void refreshStt()
    void refreshTts()
    void refreshMemory()
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

  /** Persists one voice setting and refreshes both the config and its readiness. */
  const saveTts = async (patch: Partial<TtsConfig>): Promise<void> => {
    try {
      const res = await petApi.ttsSetConfig(patch)
      if (res.ok && res.config) {
        setCfg(res.config)
        setEndpoint(res.config.endpoint)
        setTts(res.status ?? null)
      } else if (!res.ok) {
        toast.error(res.error ?? '保存失败')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  const pickRef = async (): Promise<void> => {
    const res = await petApi.ttsPickRef()
    if (res.canceled) return
    if (!res.ok) {
      toast.error(res.error ?? '选择失败')
      return
    }
    toast.success('已更换参考音频')
    await refresh()
    await refreshTts()
  }

  const resetRef = async (): Promise<void> => {
    const res = await petApi.ttsResetRef()
    if (!res.ok) {
      toast.error(res.error ?? '失败')
      return
    }
    toast.success('已换回自带的参考音频')
    await refresh()
    await refreshTts()
  }

  const preview = async (): Promise<void> => {
    setPreviewing(true)
    setTestResult(null)
    try {
      const res = await petApi.ttsTest()
      setTestResult(res)
      if (!res.ok) {
        toast.error(res.error ?? '试听失败')
        return
      }
      if (res.audio) {
        const audio = new Audio(res.audio)
        void audio.play().catch(() => toast.error('播放被拒绝，请先点一下页面再试'))
      }
      await refreshTts()
    } finally {
      setPreviewing(false)
    }
  }

  const clearMemory = async (): Promise<void> => {
    await petApi.memoryClear()
    await refreshMemory()
    toast.success('对话记忆已清空')
  }

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

      <h2 className="set-section-title" style={{ marginTop: 28 }}>
        <Icon name="autoAi" size={20} /> 语音合成
      </h2>
      <p className="set-section-desc">
        用你自己训练的 GPT-SoVITS 音色说话。文字只发给本机的服务，不经过网络。
        这里的配置属于桌宠自己，主程序不需要知道。
      </p>

      <div className="set-card">
        <SettingRow title="开启语音合成" desc={cfg?.enabled ? '桌宠会开口说话' : '已关闭，不合成任何音频'}>
          <Switch checked={Boolean(cfg?.enabled)} onChange={(v) => void saveTts({ enabled: v })} />
        </SettingRow>

        <SettingRow title="朗读 AI 的回复" desc={info?.speakReply ? '回答后会自动念出来' : '只显示文字，不出声'}>
          <Switch
            checked={Boolean(info?.speakReply)}
            onChange={(v) => void petApi.setSpeakReply(v).then(() => refresh())}
          />
        </SettingRow>

        <SettingRow title="服务地址" desc="GPT-SoVITS 启动后显示的那个地址，含 /tts">
          <div style={{ width: 320 }}>
            <TextInput
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              onBlur={() => void saveTts({ endpoint })}
              placeholder="http://127.0.0.1:9880/tts"
            />
          </div>
        </SettingRow>

        <SettingRow title="参考音频" desc={cfg?.refAudio ? shortPath(cfg.refAudio) : '还没选择'}>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="tonal" size="sm" icon="folderData" onClick={() => void pickRef()}>
              选择
            </Button>
            <Button variant="text" size="sm" icon="restore" onClick={() => void resetRef()}>
              用自带的
            </Button>
          </div>
        </SettingRow>

        <SettingRow title="参考音频的语言" desc="这段音频说的是什么语言">
          <div style={{ width: 150 }}>
            <Select
              value={cfg?.promptLang ?? 'ja'}
              onChange={(v) => void saveTts({ promptLang: v })}
              options={[
                { value: 'zh', label: '中文' },
                { value: 'ja', label: '日文' },
                { value: 'en', label: '英文' },
                { value: 'ko', label: '韩文' }
              ]}
            />
          </div>
        </SettingRow>

        <SettingRow title="朗读语言" desc="要念的文字是什么语言">
          <div style={{ width: 150 }}>
            <Select
              value={cfg?.textLang ?? 'zh'}
              onChange={(v) => void saveTts({ textLang: v })}
              options={[
                { value: 'zh', label: '中文' },
                { value: 'ja', label: '日文' },
                { value: 'en', label: '英文' },
                { value: 'auto', label: '自动' }
              ]}
            />
          </div>
        </SettingRow>

        <SettingRow title="语速" desc={`${(cfg?.speed ?? 1).toFixed(2)}×`}>
          <div style={{ width: 180 }}>
            <Slider
              value={Math.round((cfg?.speed ?? 1) * 100)}
              min={70}
              max={150}
              step={5}
              onChange={(v) => void saveTts({ speed: v / 100 })}
            />
          </div>
        </SettingRow>

        <SettingRow title="语音状态" desc={tts?.ready ? '已就绪，可以试听' : tts?.reason || '不可用'}>
          {tts?.ready ? (
            <Button variant="tonal" size="sm" icon="play" loading={previewing} onClick={() => void preview()}>
              试听合成
            </Button>
          ) : (
            <Badge tone="warning">未就绪</Badge>
          )}
        </SettingRow>
      </div>

      {testResult ? (
        <div className="set-card">
          <div className="tools-format">
            <div>
              <div className="tools-format-title">{testResult.ok ? '合成成功' : '合成失败'}</div>
              <p className="tools-format-body" style={{ color: testResult.ok ? undefined : 'var(--md-error)' }}>
                {testResult.ok ? `已生成：${testResult.text}` : testResult.error}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <h2 className="set-section-title" style={{ marginTop: 28 }}>
        <Icon name="history" size={20} /> 对话记忆
      </h2>
      <p className="set-section-desc">
        记住最近聊过的几句，桌宠才不会每次说话都像第一次见你。历史存在插件自己的数据目录里。
      </p>

      <div className="set-card">
        <SettingRow
          title="记住对话"
          desc={info?.rememberChat ? `正在记住最近 ${turnCount} 轮` : '每次都是单轮，不保留上下文'}
        >
          <Switch
            checked={Boolean(info?.rememberChat)}
            onChange={(v) => void petApi.setRememberChat(v).then(() => refreshMemory())}
          />
        </SettingRow>

        <SettingRow title="清空记忆" desc="删掉已经记下的对话">
          <Button variant="text" size="sm" icon="delete" onClick={() => void clearMemory()}>
            清空
          </Button>
        </SettingRow>
      </div>

      {turns.length > 0 && (
        <div className="set-card">
          <div className="tools-format">
            <div>
              <div className="tools-format-title">最近说过的话</div>
              <p className="tools-format-body" style={{ whiteSpace: 'pre-wrap' }}>
                {turns
                  .slice(-6)
                  .map((t) => `${t.role === 'pet' ? '桌宠' : '你'}：${t.text.slice(0, 60)}`)
                  .join('\n')}
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** Keeps a long Windows path readable in a settings row. */
function shortPath(p: string): string {
  if (p.length <= 46) return p
  return `${p.slice(0, 20)}…${p.slice(-22)}`
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
    window.api.mod.invoke<{ ok: boolean; modelId?: string; error?: string }>('livepet', 'stt-set-model', modelId),
  /* ---- 朗读 / 语音合成（配置在插件自己这里） ---- */
  ttsStatus: () => window.api.mod.invoke<TtsStatus>('livepet', 'tts-status'),
  ttsSetConfig: (patch: Partial<TtsConfig>) =>
    window.api.mod.invoke<{ ok: boolean; config?: TtsConfig; status?: TtsStatus; error?: string }>(
      'livepet',
      'tts-set-config',
      patch
    ),
  ttsPickRef: () =>
    window.api.mod.invoke<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>(
      'livepet',
      'tts-pick-ref'
    ),
  ttsResetRef: () => window.api.mod.invoke<{ ok: boolean; path?: string; error?: string }>('livepet', 'tts-reset-ref'),
  ttsTest: () =>
    window.api.mod.invoke<{ ok: boolean; audio?: string; text: string; error: string | null }>('livepet', 'tts-test'),
  ttsSpeak: (text: string) =>
    window.api.mod.invoke<{ ok: boolean; audio?: string; error?: string }>('livepet', 'tts-speak', text),
  setSpeakReply: (on: boolean) =>
    window.api.mod.invoke<{ ok: boolean; speakReply: boolean }>('livepet', 'set-speak-reply', on),
  /* ---- 对话记忆 ---- */
  memory: () =>
    window.api.mod.invoke<{ enabled: boolean; turns: Turn[] }>('livepet', 'memory-get'),
  memoryClear: () => window.api.mod.invoke<{ ok: boolean }>('livepet', 'memory-clear'),
  setRememberChat: (on: boolean) =>
    window.api.mod.invoke<{ ok: boolean; rememberChat: boolean }>('livepet', 'set-remember-chat', on),
  /* ---- 聊天（带上下文） ---- */
  chatAsk: (text: string) =>
    window.api.mod.invoke<{ ok: boolean; reply?: string; text?: string; error?: string }>('livepet', 'chat-ask', text)
}
