// ---------------------------------------------------------------------------
// hello mod — 二级设置页（mountSettings）
//
// 宿主从「设置 → 工具 → 示例工具 → 设置」进入，页面框架（标题、返回按钮）由宿主画，
// 这里只负责内容区。
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Dialog,
  Select,
  SettingRow,
  Slider,
  Switch,
  hostVersion,
  toast,
  useApp
} from './host'
import { DEFAULT_PREFS, resetPrefs, useModPrefs } from './prefs'

const GREETINGS = [
  { value: '你好', label: '你好' },
  { value: 'Hello', label: 'Hello' },
  { value: 'こんにちは', label: 'こんにちは' },
  { value: '안녕하세요', label: '안녕하세요' }
]

export function HelloSettingsPage(): JSX.Element {
  const [prefs, updatePrefs] = useModPrefs()
  const [confirmReset, setConfirmReset] = useState(false)
  const [userData, setUserData] = useState<string | null>(null)
  const themeMode = useApp((s) => s.settings?.appearance.themeMode ?? 'system')

  useEffect(() => {
    void window.api.app
      .info()
      .then((info) => setUserData(info.userData))
      .catch(() => setUserData(null))
  }, [])

  const doReset = (): void => {
    resetPrefs()
    updatePrefs(DEFAULT_PREFS)
    setConfirmReset(false)
    toast.success('已恢复默认设置')
  }

  return (
    <div className="stack" style={{ padding: '4px 0' }}>
      <div>
        <h2 className="set-section-title">示例设置</h2>
        <p className="set-section-desc">
          这些偏好由插件自己保存在 localStorage（<code className="mono">dola.hello.prefs</code>），
          不占用宿主的设置 schema。
        </p>
      </div>

      <div className="set-card">
        <SettingRow title="问候语" desc="点击「打个招呼」时使用的语言。">
          <Select
            value={prefs.greeting}
            onChange={(v) => updatePrefs({ greeting: v })}
            options={GREETINGS}
          />
        </SettingRow>

        <SettingRow title="每次增加" desc={`当前每次增加 ${prefs.step}，范围 1–10。`}>
          <Slider
            value={prefs.step}
            min={1}
            max={10}
            step={1}
            onChange={(v) => updatePrefs({ step: v })}
            style={{ width: 180 }}
          />
        </SettingRow>

        <SettingRow title="在主界面显示宿主版本" desc="右上角那个小徽章。">
          <Switch
            checked={prefs.showVersion}
            onChange={(v) => updatePrefs({ showVersion: v })}
            label="显示宿主版本"
          />
        </SettingRow>
      </div>

      <div>
        <h3 className="set-section-title" style={{ fontSize: 14 }}>
          诊断信息
        </h3>
        <p className="set-section-desc">只读，用来确认插件跑在哪个宿主版本、主题是什么。</p>
      </div>

      <div className="set-card">
        <SettingRow title="宿主版本">
          <Badge tone="ok" dot>
            v{hostVersion}
          </Badge>
        </SettingRow>
        <SettingRow title="当前主题模式" desc="来自 useApp(s => s.settings.appearance.themeMode)">
          <Badge>{themeMode}</Badge>
        </SettingRow>
        <SettingRow
          title="用户数据目录"
          desc={userData ?? '读取中…'}
          stacked
        >
          <Button variant="outlined" icon="folderData" onClick={() => void window.api.mods.openFolder()}>
            打开 mods 目录
          </Button>
        </SettingRow>
      </div>

      <div className="set-card">
        <SettingRow title="恢复默认设置" desc="只清空本插件的偏好，不影响宿主设置。">
          <Button variant="danger" icon="restart" onClick={() => setConfirmReset(true)}>
            恢复默认
          </Button>
        </SettingRow>
      </div>

      <Dialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        icon="warning"
        title="恢复默认设置？"
        subtitle="插件的偏好会被清空"
        footer={
          <>
            <Button variant="text" onClick={() => setConfirmReset(false)}>
              取消
            </Button>
            <Button variant="danger" onClick={doReset}>
              恢复默认
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          将把问候语恢复为「{DEFAULT_PREFS.greeting}」、每次增加 {DEFAULT_PREFS.step}，
          并重新显示宿主版本徽章。
        </p>
      </Dialog>
    </div>
  )
}
