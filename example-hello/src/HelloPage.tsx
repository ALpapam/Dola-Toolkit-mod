// ---------------------------------------------------------------------------
// hello mod — 工具主界面
//
// 只依赖宿主提供的组件与全局样式类（.page / .page-header / .page-body /
// .set-card / .muted ...），所以深浅色、圆角、密度、字体全部自动跟随主题，
// 插件里没有任何 .css 文件。
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Dialog,
  Icon,
  IconButton,
  SettingRow,
  TextInput,
  hostVersion,
  toast,
  useApp,
  useHotkey,
  type BadgeProps
} from './host'
import { useModPrefs } from './prefs'

export function HelloPage(): JSX.Element {
  const [prefs] = useModPrefs()
  const [name, setName] = useState('')
  const [count, setCount] = useState(0)
  const [about, setAbout] = useState(false)
  const [modsDir, setModsDir] = useState<string | null>(null)

  // 宿主的 zustand store：只读地拿当前页和主题，用来演示跨边界读取状态
  const page = useApp((s) => s.page)
  const themeMode = useApp((s) => s.settings?.appearance.themeMode ?? 'system')

  useEffect(() => {
    // 打开 DevTools（Ctrl+Shift+I）就能看到这行，确认 mount 真的被调用了
    console.info('[hello] mount() → 示例工具已渲染，宿主版本', hostVersion)
  }, [])

  const greet = (): void => {
    const who = name.trim() || '朋友'
    toast.success(`${prefs.greeting}，${who}！`)
    setCount((c) => c + prefs.step)
  }

  // 全局快捷键：输入框聚焦时 hook 内部会自动忽略
  useHotkey('ctrl+h', greet)

  const openModsDir = async (): Promise<void> => {
    try {
      const dir = await window.api.mods.openFolder()
      setModsDir(dir)
      toast.info(`已打开插件目录：${dir}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打开目录失败')
    }
  }

  const tone: NonNullable<BadgeProps['tone']> = themeMode === 'dark' ? 'warn' : 'ok'

  return (
    <div className="page">
      <header className="page-header">
        <Icon name="sparkle" size={22} />
        <div style={{ minWidth: 0 }}>
          <h1>示例工具</h1>
          <div className="sub">Dola Toolkit 插件最小可运行示例 · v1.0.0</div>
        </div>
        <div className="page-header-actions">
          {prefs.showVersion ? (
            <Badge tone={tone} dot>
              宿主 {hostVersion}
            </Badge>
          ) : null}
          <IconButton icon="info" label="关于" onClick={() => setAbout(true)} />
        </div>
      </header>

      <div className="page-body">
        <div className="stack">
          <div className="set-card">
            <SettingRow title="你的名字" desc="留空就用「朋友」。没有保存按钮，输入即生效。">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：ALpapam"
                style={{ width: 200 }}
                aria-label="你的名字"
              />
            </SettingRow>
            <SettingRow title="打个招呼" desc="调用宿主的 toast.success，并累加计数。">
              <Button icon="sparkle" onClick={greet}>
                打个招呼
              </Button>
            </SettingRow>
            <SettingRow
              title="宿主状态"
              desc={`useApp 读到的 page = ${page || '(空)'}，themeMode = ${themeMode}`}
            >
              <Badge>{count} 次</Badge>
            </SettingRow>
          </div>

          <div className="set-card">
            <SettingRow
              title="打开插件安装目录"
              desc={modsDir ?? 'window.api.mods.openFolder() 会定位到 %APPDATA%\\…\\mods'}
            >
              <Button variant="tonal" icon="folder" onClick={() => void openModsDir()}>
                打开
              </Button>
            </SettingRow>
            <SettingRow title="快捷键" desc="Ctrl + H 同样会打招呼；在输入框里不会触发。">
              <Badge>Ctrl + H</Badge>
            </SettingRow>
          </div>

          <p className="tiny muted" style={{ margin: 0 }}>
            设置页在「设置 → 工具 → 示例工具 → 设置」里，由本插件自己的 mountSettings 渲染。
          </p>
        </div>
      </div>

      <Dialog
        open={about}
        onClose={() => setAbout(false)}
        icon="info"
        title="关于示例工具"
        subtitle="Dola Toolkit 插件开发示例"
        footer={
          <Button onClick={() => setAbout(false)}>知道了</Button>
        }
      >
        <div className="stack-sm">
          <p style={{ margin: 0 }}>
            这个示例是真实可构建的：一个 IIFE bundle、一个 dola-mod.json，没有别的。
          </p>
          <p className="muted" style={{ margin: 0 }}>
            UI 组件、React、toast、store 全部来自 <code className="mono">window.__DOLA__</code>，
            IPC 能力来自 <code className="mono">window.api</code>。
          </p>
        </div>
      </Dialog>
    </div>
  )
}
