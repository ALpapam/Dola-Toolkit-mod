# Dola Toolkit 插件（mod）开发指南

> 一个插件 = 一个 `.zip`（里面是 `dola-mod.json` + 一个 IIFE 的 `index.js`）。
> 装上之后它会成为侧边栏里的一个工具，用宿主自己的 React、UI 组件、主题和 IPC 能力运行。

本仓库是 Dola Toolkit 的插件开发者中心：

- [`README.md`](#目录) —— 你现在读的这份完整教程（针对人类开发者，也针对 AI agent，所有结论都从宿主源码核对过）
- [`example-hello/`](example-hello) —— 最小可运行示例（`id: hello`，中文名「示例工具」），**真的能构建**
- [`mods/hello-1.0.0.zip`](mods) —— 上面那个示例构建好的安装包，可以直接拖进 Dola Toolkit
- [`scripts/pack.mjs`](scripts/pack.mjs) —— 把构建产物打成可安装 zip 的脚本

宿主项目：[ALpapam/dola-toolkit](https://github.com/ALpapam/dola-toolkit)。
本指南核对依据：宿主 `0.2.1`（beta 0.2.1），源码 `src/main/mods/`、`src/renderer/src/modHost/`、`src/renderer/src/ui/`、`src/preload/index.d.ts`。

> 阅读顺序建议：先看 [1. 五分钟跑起来](#1-五分钟跑起来)，再扫一遍 [3. dola-mod.json](#3-dola-modjson)，然后按需查 [4. 宿主桥](#4-宿主-api-window__dola__) / [5. window.api](#5-宿主-ipc能力-windowapi)。

---

## 0. 给 AI agent 的契约速查（TL;DR）

如果你（或你的 agent）只读一段，读这段：

- 插件 = 一个 `.zip`，**根目录**平铺 `dola-mod.json` + `index.js`；不要带 `src/`、`node_modules/`。
- 清单必填 `id` / `name` / `version`；`id`（`[a-zA-Z0-9._-]`）同时是安装目录名，**必须**等于注册表的 key。
- `index.js` 必须是 **IIFE**，运行时执行：
  `(window.__DOLA_MODS__ ??= {})['<id>'] = { mount(container) {...}, mountSettings(container) {...} }`
- `mount` / `mountSettings` **同步**返回卸载函数；`container` 是宿主给的 `HTMLElement`。
- **不要打包 react / react-dom**：用 `vite.config.ts` 的 4 个精确别名指向 `src/shims/*`，从 `window.__DOLA__` 取宿主实例。
- 界面用 `window.__DOLA__.ui.*`（20 个组件，见 4.2）；toast 用 `__DOLA__.toast`；宿主状态用 `__DOLA__.useApp`；系统能力用 `window.api.*`。
- 不写死颜色和尺寸：用宿主 CSS 变量（`--md-*`、`--sp-*`、`--shape-*`）和全局类（`.page`、`.page-body`、`.set-card`、`SettingRow`）。
- 升级规则：同 `id` 重新导入即覆盖；**低版本会被拒**；版本按数字段比较（`1.0.0-beta == 1.0.0`）。
- 构建：`vite build`（`lib.formats: ['iife']`）→ `dist/index.js`；打包：`node scripts/pack.mjs <id>` → `mods/<id>-<version>.zip`。
- 运行期拿不到 Node（`contextIsolation: true`，无 `fs`/`require`）；`fetch('dola-mod://…')` 被 CSP `connect-src` 拦住，数据要打进 bundle。

---

## 目录

1. [五分钟跑起来](#1-五分钟跑起来)
2. [什么是 mod：安装目录与运行方式](#2-什么是-mod安装目录与运行方式)
3. [`dola-mod.json` 清单](#3-dola-modjson)
4. [宿主 API：`window.__DOLA__`](#4-宿主-api-window__dola__)
5. [宿主 IPC 能力：`window.api`](#5-宿主-ipc能力-windowapi)
6. [构建：Vite IIFE + React shim](#6-构建vite-iife--react-shim)
7. [打包成 zip](#7-打包成-zip)
8. [样式约定](#8-样式约定)
9. [调试技巧](#9-调试技巧)
10. [最小示例完整清单](#10-最小示例完整清单)
11. [发布清单与 FAQ](#11-发布清单与-faq)
12. [源码核对：与 docs/mod-api.md 的差异](#12-源码核对与-docsmod-apimd-的差异)

---

## 1. 五分钟跑起来

### 1.1 装上示例

1. 打开 Dola Toolkit；
2. 点侧边栏最后的 **「+」**（添加工具）；
3. 把 [`mods/hello-1.0.0.zip`](mods) 拖进页面（或者点按钮选文件）；
4. 侧边栏出现「示例工具」，点进去能看到一个小界面；右上角 `i` 是宿主 Dialog；
5. 「设置 → 工具 → 示例工具 → 设置」里是它自己的二级设置页。

### 1.2 改代码、重建、升级

```bash
cd example-hello
npm install                # 只需要一次；离线时可以复用宿主的 node_modules，见 6.5
npm run build              # 产出 dist/index.js
node ../scripts/pack.mjs hello
# → ../mods/hello-1.0.0.zip
```

再把这个 zip 拖进 Dola Toolkit：**同一个 id 重新导入就是升级**（版本相同也会覆盖文件）。
改完界面看不到变化时，切到别的页面再切回来（宿主会重新 mount）。

### 1.3 从零新建一个插件

复制 `example-hello/`，然后改这四处：

| 位置 | 改成 |
| --- | --- |
| `dola-mod.json` 的 `id` / `name` / `version` | 你自己的 |
| `src/index.tsx` 里注册表的 key | **必须等于** `dola-mod.json` 的 `id` |
| `vite.config.ts` 的 `name` | 随便，只影响 `window.DolaMod_xxx` |
| `src/index.tsx` 的界面 | 你的功能 |

---

## 2. 什么是 mod：安装目录与运行方式

### 2.1 一句话模型

mod 是**在宿主渲染进程里执行的一段 JS**，但它拿不到 Node、也不能自己打包 React：

```
dola-mod.json  ──►  宿主解析、校验、装进 <userData>/mods/<id>/
index.js (IIFE) ─►  <script src="dola-mod://<id>/index.js"> 执行
                ─►  bundle 里执行 window.__DOLA_MODS__[id] = { mount, mountSettings }
                ─►  宿主调用 mount(container) / mountSettings(container)
                ─►  你返回一个卸载函数，宿主在切页/卸载时调用
```

### 2.2 安装目录

| 东西 | 路径 |
| --- | --- |
| 插件本体 | `<userData>\mods\<id>\` |
| 安装状态 | `<userData>\mods\mods.json`（数组，每项是清单快照 + `installedAt` / `firstRun` / `enabled`） |
| 导入临时目录 | `<userData>\mods\.import-<uuid>\`（成功或失败都会被删掉） |

`<userData>` 在 Windows 上是 Electron 的用户数据目录，实际看到的是：

- **开发运行**（`npm run dev`）：`%APPDATA%\dola-toolkit\mods\`
- **安装版 / portable**：`%APPDATA%\Dola Toolkit\mods\`

两处都可能存在（`app.setName('Dola Toolkit')` 与 `package.json` 的 name 分别生效）。
**不要靠记忆找目录**：在你的插件里调用 `await window.api.mods.openFolder()`，宿主会 `shell.openPath` 打开真正的那个目录并把它返回给你。

卸载 = 删掉 `<id>` 目录并从 `mods.json` 去掉那一项（`window.api.mods.uninstall(id)`，设置 → 工具里也有按钮）。

### 2.3 运行方式：`dola-mod://`

宿主注册了一个自定义协议（`src/main/mods/protocol.ts`）：

```
dola-mod://<id>/<path>   →   <userData>/mods/<id>/<path>
```

- 协议是 `standard + secure + corsEnabled + supportFetchAPI`，浏览器会把它当成一个"正常"来源；
- 路径会被 `normalize` 后做前缀检查，`../` 越界返回 `403 forbidden`（插件读不到自己目录以外的任何文件）；
- 不存在的文件返回 `404`；
- **MIME 白名单**：`.js .mjs .css .json .png .jpg .jpeg .webp .svg .gif .woff .woff2 .ttf .otf .html`；其它扩展名一律 `application/octet-stream`，所以**入口文件请用 `.js` 或 `.mjs`**（`.cjs` 会被当成二进制，脚本加载失败）。

入口 URL 由宿主拼装：`dola-mod://${id}/${entry}`（`entry` 去掉开头的 `/`）。

### 2.4 加载与注册契约

宿主代码：`src/renderer/src/modHost/ModHost.tsx`。

1. 加载：`document.createElement('script')`，`src = dola-mod://<id>/<entry>`。**不是** `import()`，所以 bundle 必须是经典脚本（IIFE），不能有顶层 `import`/`export` 语句（打包器会处理）。
2. 注册：脚本执行后，宿主读 `window.__DOLA_MODS__[<id>]`，要求它是一个对象且 `mount` / `mountSettings` **至少有一个是函数**；
   - 否则报错：`插件没有正确注册，可能不是有效的 Dola Toolkit 插件`
   - 脚本 404 / 语法错误：`插件文件加载失败`
3. 渲染：

```js
window.__DOLA_MODS__ = window.__DOLA_MODS__ || {}
window.__DOLA_MODS__['hello'] = {
  mount(container) {
    // 把界面渲染进 container；返回卸载函数（可选，但强烈建议）
    return () => {}
  },
  mountSettings(container) {
    return () => {}
  }
}
```

规则细节（都来自源码）：

- **`mount` / `mountSettings` 必须同步返回**（`void` 或卸载函数）。不要返回 Promise。
- 卸载函数在容器销毁时被调用，宿主用 `try/catch` 包着，所以插件清理抛错不会拖垮宿主。
- 只有 `mount` 的插件也能跑；点进设置页时宿主会提示 `该插件没有提供设置界面`（反之是 `该插件没有提供界面`）。
- 两个函数都**抛异常**时，页面显示 `无法加载「<名称>」` + 异常 message（所以 `throw new Error('...')` 是很好的调试手段）。
- `container` 是一个 `<div style="height:100%">`，宿主外面还套了 `.mod-page`（`display:flex; flex-direction:column; overflow:hidden`）以及 `.page-host`（`display:flex; flex-direction:column`）。**想让内容自己滚动，就在你的根节点用宿主的 `.page` / `.page-body` 类**（见第 8 节）。
- bundle **按 `id@version` 缓存**（`loaded` Map）。切换页面不会重复执行脚本；同名同版本重新导入时，宿主在导入流程里调用 `invalidateMod(id)` 清缓存，所以"重新导入即升级"是有代码保证的。
- 升级（版本号变化）后，若当前正停在该插件的页面上，宿主不会自动重新 mount；切走再切回即可。
- 插件的 React root 是**独立 root**，不在宿主的 `<React.StrictMode>` 里 —— 你的 `useEffect` 只跑一次，不会有 StrictMode 的双调用。

### 2.5 运行环境边界

宿主窗口的 `webPreferences`：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`。

也就是说插件里：

- ❌ 没有 `require` / `process` / `fs` / `path` / `__dirname`
- ✅ 有 `window`、`document`、`localStorage`、`fetch`（受 CSP 限制，见下）
- ✅ 有 `window.api`（preload 暴露的全部 IPC 能力）
- ✅ 有 `window.__DOLA__`（宿主 React / UI / store）

CSP（`src/renderer/index.html`）关键部分：

```
script-src 'self' file: dola-mod:;          ← 可以 <script src="dola-mod://…">，但禁止 inline script / eval
style-src  'self' 'unsafe-inline' blob: file: dola-mod:;
img-src    'self' data: blob: file: https: dola-font: dola-mod:;
font-src   'self' data: blob: file: res: dola-font: dola-mod:;
connect-src 'self' file: blob: data: dola-font: http://127.0.0.1:* https: ws://localhost:*;
```

两个实际影响：

1. **`connect-src` 里没有 `dola-mod:`** —— 用 `fetch('dola-mod://hello/data.json')` / XHR 读自己目录的文件会被 CSP 拦掉。要带数据就**打包进 bundle**（`import data from './data.json'`），或者走 `window.api`。
2. 没有 `unsafe-eval`，依赖 `eval` / `new Function` 的库（部分老模板引擎、某些加密库）会直接报 CSP 错误。

---

## 3. `dola-mod.json`

### 3.1 字段表（逐条对齐 `src/main/mods/manifest.ts`）

| 字段 | 必填 | 默认值 | 校验 / 说明 |
| --- | --- | --- | --- |
| `id` | ✅ | — | 非空字符串（会 `trim`）。正则 `^[a-zA-Z0-9._-]+$`；**同时是安装目录名**，所以不允许空格、中文、`/`。必须与注册表的 key 一致。 |
| `name` | ✅ | — | 非空字符串，侧边栏与设置页显示的名字。 |
| `version` | ✅ | — | 正则 `^\d+(\.\d+)*`（注意**没有结尾锚点**）→ `1`、`1.0`、`1.0.0`、`1.0.0-beta` 都能通过。比较规则见 3.3。 |
| `settingsName` | | `"<name>设置"` | 二级设置页标题。 |
| `createdAt` | | 当前时间 ISO 字符串 | 只用于展示，不参与任何逻辑。 |
| `description` | | `""` | 首次打开该工具时作为「欢迎使用 X · 首次使用指南」弹窗展示一次（`firstRun`），升级不再展示。支持 `\n`。 |
| `icon` | | `"extension"` | 侧边栏图标名。⚠️ 见 3.4：`extension` 并不在宿主的图标集里。 |
| `settingsIcon` | | `"settings"` | 设置页图标（`ModSettingsPage` 里 `settingsIcon \|\| icon`）。 |
| `entry` | | `"index.js"` | 入口 bundle，相对**清单所在目录**。必须真实存在，否则报「插件缺少入口文件 …」。 |
| `backupFile` | | `""` | 可选。相对 `<userData>` 的 JSON 文件，声明后该插件会出现在 WebDAV 同步的备份项里（`mod:<id>`），远端文件名为 `dola-mod-<id>.json`。**当前 `docs/mod-api.md` 尚未记录此字段**，见第 12 节。 |

补充：

- **未知字段被忽略**（不会报错），但也不会被保存进 `mods.json`。
- 清单可以出现在 zip 内的**根目录，或往里最多两层的某个目录**（`findManifest` 递归深度 0/1/2）。多套一层文件夹的 zip 能装，但把 `dola-mod.json` 放在 zip 根目录最省事。
- 文件必须是 **UTF-8、无 BOM** 的 JSON；BOM 会让 `JSON.parse` 失败 → `插件清单不是合法的 JSON`。

### 3.2 一个完整示例

`example-hello/dola-mod.json`：

```json
{
  "id": "hello",
  "name": "示例工具",
  "version": "1.0.0",
  "settingsName": "示例工具设置",
  "createdAt": "2026-10-28T00:00:00.000Z",
  "description": "Dola Toolkit 插件开发指南配套的最小可运行示例。\n\n主界面演示宿主 UI 组件、toast、useApp 与快捷键；「设置 → 工具 → 示例工具 → 设置」里有一个由 mountSettings 渲染的二级设置页。",
  "icon": "sparkle",
  "settingsIcon": "tune",
  "entry": "index.js"
}
```

### 3.3 版本比较规则（决定"能不能覆盖安装"）

`src/main/mods/manager.ts`：

```ts
function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
```

- 按 `.` 和 `-` 切段，逐段按整数比较，缺失段当 `0`；非数字段 `parseInt` 失败 → `0`。
- 因此：`1.0` == `1.0.0`；**`1.0.0-beta` == `1.0.0`**；`1.2.10 > 1.2.9`（不是字符串比较）。
- 导入时若 `新版本 < 已安装版本` → 拒绝：`已安装的 <name> 版本更新（1.1.0 > 1.0.0），未覆盖`，并且解压出来的临时目录会被删掉（不会留下半个插件）。
- `新版本 >= 已安装版本` → 覆盖安装（同版本也覆盖）。返回值 `upgraded: true` 表示之前就装过。
- 升级时 `firstRun` 的规则：只有"同一个版本号重装"才保留 `firstRun` 原值；版本号变了就置 `false`，所以**升级不会再次弹使用引导**。

### 3.4 常见报错与含义

| 报错（原文） | 触发条件 | 怎么修 |
| --- | --- | --- |
| `这似乎不是Dola Toolkit的插件呢~` | 解压后（递归两层）找不到 `dola-mod.json` | zip 里忘了清单；或者只压缩了 `dist/` 而没带上清单 |
| `插件清单不是合法的 JSON` | `JSON.parse` 抛错 | 尾部多余逗号、单引号、BOM、注释 |
| `插件清单不是一个对象` | 顶层是数组 / `null` / 字符串 | 清单必须是 `{}` |
| `插件清单缺少字段：id` | `id` 缺失 / 空串 / 非字符串 | 补 `id` |
| `插件清单缺少字段：name` / `：version` | 同上 | 补字段 |
| `插件 id 只能包含字母、数字、点、下划线和短横线` | `id` 含空格、中文、`/` | 换成 `my-mod` 这类 |
| `插件 version 必须是形如 1.0.0 的版本号` | 版本以非数字开头，如 `v1.0.0` | 去掉 `v` |
| `插件缺少入口文件 index.js` | `entry` 指向的文件不存在（相对清单目录） | 检查 `entry`，以及 zip 里入口是否和清单平级 |
| `已安装的 X 版本更新（A > B），未覆盖` | 降级安装 | 提高 `version`，或先卸载 |
| `只支持 .zip 格式的插件包` | 拖进来的不是 zip | 重新打包 |
| `解压失败 (2)` / `解压失败：…` | 宿主用 `C:\Windows\System32\tar.exe` 解压失败 | zip 损坏；或用了 tar 不支持的压缩方法（用标准 deflate zip） |
| `找不到该文件` | 传入的路径不存在（一般来自拖拽） | — |
| `写入插件目录失败：…` | 拷贝到 `<userData>/mods/<id>` 失败 | 文件被占用 / 权限；关掉宿主再试 |
| （运行期）`插件文件加载失败` | `<script>` 加载失败：404 或 MIME 不对 | 检查 `entry` 扩展名、文件是否存在、语法是否报错 |
| （运行期）`插件没有正确注册，可能不是有效的 Dola Toolkit 插件` | 脚本跑了但没注册 / 注册的对象没有 `mount`\|`mountSettings` | key 必须等于 `id`；确认没在 `if (false)` 里注册；确认 IIFE 真的执行了 |
| （运行期）`该插件没有提供界面` / `该插件没有提供设置界面` | 只实现了其中一个函数 | 补 `mount` 或 `mountSettings` |
| （运行期）`无法加载「X」` + 具体错误 | `mount()` 抛异常 | 这就是你自己 `throw new Error()` 的内容 |

图标说明：宿主 `Icon` 组件对**未知图标名回退成 `info`**，不会报错。默认值 `extension` 恰好不在内置图标集里（`src/renderer/src/ui/icons.generated.ts` 的 166 个名字中没有它），所以**不写 `icon` 的插件在侧边栏显示的是 info 图标**；想好看就显式写一个真实存在的名字，比如 `sparkle`、`apps`、`widgets` → 实际可用名字见 4.3。

---

## 4. 宿主 API：`window.__DOLA__`

宿主在渲染任何页面之前安装这个全局（`src/renderer/src/main.tsx` 第 12 行 `installHostBridge(APP_VERSION)`，早于 `createRoot(...).render(...)`），实现在 `modHost/bridge.ts`：

```ts
window.__DOLA__ = {
  React,             // 宿主的 React 实例（19.x）
  ReactDOM,          // react-dom 与 react-dom/client 的合并对象
  ReactDOMClient,    // 只含 react-dom/client
  ui: { ...controls, Icon, hashHue, useHotkey },
  toast,
  useApp,
  version            // 宿主版本字符串，如 "0.2.1"
}
```

**最重要的一条**：插件**绝对不要**自己 `import React from 'react'` 后打包进 bundle。一个页面两份 React 会导致 hooks 报
`Invalid hook call` / `Rendered more hooks than during the previous render`。用第 6 节的 shim 把 `react`、`react-dom`、`react/jsx-runtime` 全部重定向到这份全局。

### 4.1 `React` / `ReactDOM` / `ReactDOMClient`

- `__DOLA__.React` 就是宿主的 React 模块对象（`useState`、`createElement`、`memo`、`Suspense`… 全都有）。
- `__DOLA__.ReactDOM` = `{ ...react-dom, ...react-dom/client }`：
  - `createRoot` / `hydrateRoot` 来自 **client**（React 19 的经典 `react-dom` 入口不再导出 `createRoot`）；
  - `createPortal` / `flushSync` 来自经典入口。
  所以"渲染进 container"用 `window.__DOLA__.ReactDOM.createRoot(container)` 是对的，但**更推荐**用 shim：`import { createRoot } from 'react-dom/client'`。
- `__DOLA__.ReactDOMClient` 只含 client 入口，给需要"确认拿到 client 版"的代码用。

### 4.2 `ui`：宿主 UI 组件（逐条来自 `src/renderer/src/ui/controls.tsx`）

`ui` 是 `import * as controls` 的展开，因此**导出比文档里列的多**。完整清单（20 个组件 + 2 个工具）：

| 组件 | Props | 说明 |
| --- | --- | --- |
| `Button` | `variant?: 'filled'\|'tonal'\|'outlined'\|'text'\|'elevated'\|'danger'`（默认 `filled`）、`icon?`、`size?: 'sm'\|'md'\|'xs'`（默认 `md`）、`loading?`、`disabled?`、`children`、以及原生 `<button>` 属性 | `loading` 时显示 spinner 且自动 disabled |
| `IconButton` | `icon`（必填）、`size?: number`（默认 20）、`small?`、`active?`、`label?`（同时当 `title`/`aria-label`）、原生属性 | 只有图标的按钮 |
| `Field` | `label?`、`hint?`、`error?: string\|null`、`prefixIcon?`、`suffix?: ReactNode`、`outlined?`、`className?`、`children` | 输入框外壳；`TextInput` 内部就用它 |
| `TextInput` | 继承 `InputHTMLAttributes<HTMLInputElement>`，外加 `label?`、`hint?`、`error?`、`prefixIcon?`、`suffix?`、`outlined?` | `value`/`onChange`/`placeholder`/`style` 都是原生的 |
| `TextArea` | 继承 `TextareaHTMLAttributes<HTMLTextAreaElement>`，外加 `label?`、`hint?`、`outlined?` | 多行输入 |
| `Select` | `label?`、`hint?`、`value: string`、`onChange(v: string)`、`options: {value,label}[]`、`outlined?` | 自绘下拉，支持键盘（↑↓/Home/End/Enter/Esc）、空间不足自动上翻 |
| `Switch` | `checked: boolean`、`onChange(v: boolean)`、`label?` | — |
| `Checkbox` | `checked`、`onChange(v: boolean)`、`label?` | — |
| `Slider` | `value: number`、`min?`（默认 0）、`max?`（默认 100）、`step?`（默认 1）、`onChange(v: number)`、`style?` | 原生 range，`--pct` 控制已填充轨道 |
| `Chip` | `selected?`、`onClick?`、`icon?`、`danger?`、`children` | — |
| `Segmented` | 泛型 `<T extends string>`：`value: T`、`onChange(v: T)`、`options: {value:T; icon?; label?}[]` | 图标分段器；全部带 `icon` 时更紧凑 |
| `Tabs` | 泛型：`value: T`、`onChange(v: T)`、`items: {value:T; label:string; icon?}[]` | — |
| `Dialog` | `open`、`onClose`、`title`、`subtitle?`、`icon?`、`children`、`footer?`、`width?: 'normal'\|'wide'\|'slim'` | `createPortal` 到 `document.body`；Esc / 点遮罩关闭 |
| `Sheet` | `open`、`onClose`、`title`、`children`、`footer?`、`icon?` | 底部抽屉 |
| `Menu` | `x`、`y`、`items: MenuItem[]`、`onClose` | `MenuItem = { label, icon?, onClick?, danger?, separator?, disabled? }`；自己管坐标 |
| `Badge` | `children`、`tone?: 'default'\|'ok'\|'err'\|'warn'`、`dot?` | — |
| `Empty` | `icon?`（默认 `autoAi`）、`title`、`desc?`、`action?: ReactNode` | 空状态 |
| `Progress` | `value?: number`（0..1）、`indeterminate?` | — |
| `Spinner` | `size?: number`（默认 18） | — |
| `SettingRow` | `title`、`desc?`、`children?`、`stacked?` | 「设置行」；放进 `.set-card` 里会自动加分隔线 |
| `Icon` | `name`、`size?: number\|string`（默认 20）、`className?`、`style?`、`title?` | Material Symbols SVG 内联；未知名字回退 `info` |
| `hashHue(input: string)` | → `number`（0..359） | 稳定色相，用于头像/封面等 |
| `useHotkey(combo, handler, enabled?)` | 例：`'ctrl+h'`、`'ctrl+shift+k'`、`'f5'` | 输入框/文本域聚焦时自动忽略；自动 `preventDefault` |

用法示例：

```tsx
const { Button, SettingRow, Switch, Select, toast } = window.__DOLA__.ui as any
```

（示例工程里用 `src/host.ts` 把这些解构出来并附上了类型，见第 10 节。）

### 4.3 `Icon` 可用名字

内置 166 个名字，来自 `icons.generated.ts`（Material Symbols Rounded，由 `scripts/fetch-icons.mjs` 生成）。常用的：

```
add close check delete edit more search refresh play stop upload download link open copy
arrowBack arrowForward chevronRight chevronLeft chevronUp chevronDown expandMore
settings tune palette apps language translate star favorite bookmark tag
folder folderNew folderData folderZip fileDownload fileUpload description
book bookOpen menuBook autoStories library libraryBig localLibrary
grid list sort filter timer history calendar update security shieldCheck
info warning error checkCircle help
darkMode lightMode contrast brightness autoAi sparkle gem verified
proxy globe dns terminal key lock cloud cloudSync sync
readerMode fullscreen splitscreen viewColumn2 density columnWidth
```

⚠️ 不存在的名字：`extension`（manifest 的默认值）、`celebration`、`widgets`、`download2` 等 —— 都会被静默替换成 `info`。

### 4.4 `toast`

```ts
toast.info(message: string): void
toast.success(message: string): void
toast.warn(message: string): void     // 内部 kind 是 'warning'
toast.error(message: string): void
```

普通字符串，默认 3.2 秒后消失，点击可提前关闭。**没有** Promise / 按钮 / 标题。

### 4.5 `useApp`：宿主的 zustand store

`useApp` 就是宿主 `src/renderer/src/state/app.ts` 的 `create<AppState>()` hook（zustand v5），所以在插件里可以像在宿主里一样用：

```tsx
const page = useApp((s) => s.page)
const themeMode = useApp((s) => s.settings?.appearance.themeMode ?? 'system')
const mods = useApp((s) => s.mods)
```

State 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `page` | `string` | 当前页 id（`'home'`、`'proxy'`、`'settings'`、`'add-tool'`，或 mod 的 id） |
| `settings` | `Settings \| null` | 宿主设置（`appearance/ai/sync/proxy/library/reader/general`）；启动时为 `null` |
| `railExpanded` | `boolean` | 侧边栏是否展开 |
| `railOrder` | `string[]` | 侧栏顺序（持久化在 localStorage `dola.railOrder`） |
| `mods` | `ModEntry[]` | 已安装插件快照 |
| `ready` | `boolean` | 宿主初始化完成 |
| `fonts` | `LoadedFontInfo[]` | 可用字体 |
| `readingFamily` | `string` | 阅读字体 |
| `setPage(p)` / `setSettings(s)` / `setRailExpanded(v)` / `setRailOrder(o)` / `setMods(m)` / `setReady(v)` / `setFonts(f)` / `setReadingFamily(f)` |  | 修改器 |
| `refreshMods()` | `() => Promise<void>` | 重新从主进程拉 `mods.list()` |

只读地用它最安全；**写 `settings` 请走 `window.api.settings.patch()`**（主进程是 source of truth，会广播 `settingsChanged`），别直接 `setSettings` 造出与磁盘不一致的状态。

### 4.6 `version`

宿主版本字符串（`APP_VERSION`，当前 `"0.2.1"`）。适合在设置页展示、或做兼容性开关，例：

```tsx
const [major, minor] = hostVersion.split('.').map(Number)
const supportsThing = major > 0 || minor >= 2
```

---

## 5. 宿主 IPC 能力：`window.api`

`window.api` 由 preload 注入（`src/preload/index.ts`），类型定义在 `src/preload/index.d.ts`（`DolaToolkitApi`）。**下面每一条都是从该文件核对出来的完整清单**（文档 `docs/mod-api.md` 只列了常用的一部分）。

通用约定：

- 所有 `invoke` 型方法返回 `Promise`；`send` 型（如 `close()`、`minimize()`）返回 `void`。
- `onXxx(cb)` **返回一个取消订阅函数**，务必在 `mount` 的清理函数里调用，否则切页后仍会收到事件。
- 事件回调收到的对象是**纯 JSON**（跨 IPC 序列化过）。

### 5.1 `window.api.app`

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `info()` | `Promise<AppInfo>` | `{ version, electron, chrome, node, platform, arch, userData, logsDir }` |
| `quit()` / `minimize()` / `toggleMaximize()` / `close()` | `void` | 窗口/应用控制 |
| `onCloseAsk(cb)` | `() => void` | 关闭时询问"最小化到托盘还是退出" |
| `resolveClose({ closeToTray, remember })` | `Promise<boolean>` | 回答上面的询问 |
| `trayAvailable()` | `Promise<{ available: boolean; icon: { width; height } \| null }>` | 无通知区域时隐藏到托盘不安全 |
| `openExternal(url)` | `Promise<void>` | 用系统浏览器打开 |
| `showItem(path)` | `Promise<void>` | 资源管理器中定位文件 |
| `openLogs()` | `Promise<void>` | 打开日志目录 |
| `capture(rect)` | `Promise<string \| null>` | 截取窗口内一块矩形（data URL） |
| `setTitleBarTheme(dark)` | `void` | 标题栏深浅色 |
| `checkAppUpdate()` | `Promise<AppUpdateInfo>` | |
| `checkCoreUpdates()` | `Promise<CoreUpdateInfo[]>` | |
| `downloadAppUpdate()` | `Promise<{ ok; path?; error? }>` | |
| `installAppUpdate(installerPath, targetVersion?)` | `Promise<{ ok; error? }>` | |
| `stageCore(engine)` | `Promise<{ ok; staged?; needsRestart?; error? }>` | |
| `stageAllCores()` | `Promise<{ ok; staged; failed; needsRestart }>` | |
| `stagedCores()` | `Promise<StagedCoreInfo[]>` | |
| `clearStagedCores()` | `Promise<{ ok }>` | |
| `applyStagedNow()` | `Promise<{ ok; count?; error? }>` | |
| `hasStaged()` | `Promise<boolean>` | |
| `openUpdateLog()` / `updateLogPath()` | `Promise<string>` | |
| `takePendingUpdate()` | `Promise<{ from; to; updated } \| null>` | |
| `openReleases()` | `Promise<boolean>` | |
| `onUpdateProgress(cb)` | `() => void` | |

### 5.2 `window.api.settings`

| 方法 | 签名 |
| --- | --- |
| `get()` | `Promise<Settings>` |
| `patch(patch)` | `Promise<Settings>`（返回合并后的完整设置） |
| `reset()` | `Promise<Settings>` |
| `onChanged(cb)` | `() => void` |

⚠️ `patch` 在主进程里会经过 `sanitizePatch()`：**只接受 7 个已知 section**（`appearance/ai/sync/proxy/library/reader/general`），每个 section 里**只保留 `string | number | boolean | null` 的叶子**，其余全部丢弃。所以：

- 想存插件自己的数据 → 用 `localStorage`（键名以 `dola.<你的id>.` 开头，避免和宿主的 `dola.railOrder` 撞车），或者让用户数据落在 `<userData>` 下并由 `backupFile` 声明备份；
- 不要往 `settings` 里塞 `hello: {...}` 这种自定义 section，它会被静默丢掉。

### 5.3 `window.api.theme`

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `monet(force?)` | `Promise<MonetResult>` | `{ seed, source, light, dark, palette, wallpaper }`；`light/dark` 是 MD3 `ColorScheme` |
| `onChanged(cb)` | `() => void` | 主题（壁纸取色）变化时推送 |

### 5.4 `window.api.proxy`

| 方法 | 签名 |
| --- | --- |
| `state()` | `Promise<ProxyState>` = `{ nodes, selectedNodeId, engines, activeEngine, systemProxy, geo, settings }` |
| `engines()` | `Promise<EngineCapability[]>` |
| `saveNode(node)` | `Promise<ProxyNode>`（`Partial<ProxyNode> & { id? }`，无 id 即新建） |
| `deleteNode(id)` | `Promise<void>` |
| `importLinks(text)` | `Promise<{ added: ProxyNode[]; failed: { link; reason }[] }>` |
| `selectNode(id \| null)` | `Promise<ProxyState>` |
| `start()` / `stop()` | `Promise<CoreStatus>` |
| `testNode(id)` | `Promise<{ nodeId; ok; delayMs; exitIp; country; error }>` |
| `setSystemProxy(on)` | `Promise<boolean>` |
| `importGeo()` / `updateGeo()` | `Promise<ProxyState>` |
| `clearLogs(engine)` | `Promise<void>`（`engine: 'xray' \| 'mihomo' \| 'singbox'`） |
| `onState(cb)` | `() => void` |
| `onLog(cb)` | `() => void`（`CoreLogEvent = { engine, line, level, at }`） |

### 5.5 `window.api.library`

| 方法 | 签名 |
| --- | --- |
| `state()` | `Promise<LibraryState>` = `{ books, folders, rootDir, importing }` |
| `import()` | `Promise<ImportOutcome>`（打开文件选择框） |
| `importPaths(paths)` | `Promise<ImportOutcome>` = `{ added: BookRecord[]; skipped: {path,reason}[] }` |
| `removeBooks(ids)` | `Promise<LibraryState>` |
| `updateBook(id, patch)` | `Promise<BookRecord>` |
| `content(id)` | `Promise<BookContent>` = `{ id, format, data, encoding: 'utf8'\|'base64', filePath, title }` |
| `createFolder(name, parentId?)` | `Promise<FolderRecord>` |
| `updateFolder(id, patch)` | `Promise<FolderRecord>` |
| `deleteFolder(id)` | `Promise<LibraryState>` |
| `classify()` | `Promise<ClassifyResult>`（调用 AI 分类） |
| `cover(id)` | `Promise<string \| null>`（data URL 或路径） |
| `catalog(q)` | `Promise<CatalogResult>`（`{ source, query, page? }`） |
| `catalogDownload(book)` | `Promise<BookRecord>` |
| `onChanged(cb)` / `onProgress(cb)` | `() => void`（progress 回调收到 `{ done, total, current }`） |

### 5.6 `window.api.ai`

| 方法 | 签名 |
| --- | --- |
| `status()` | `Promise<AIStatus>` = `{ configured, enabled, baseUrl, model, lastError }` |
| `chat(msgs)` | `Promise<AIChatResult>` = `{ ok, content, error, usage?, ms }`；`msgs: { role: 'system'\|'user'\|'assistant'; content: string }[]` |
| `test()` | `Promise<AIChatResult>` |

需要用户在「设置 → AI」里配好 baseURL / key / model；没配时 `status().configured === false`。

### 5.7 `window.api.sync`

| 方法 | 签名 |
| --- | --- |
| `status()` | `Promise<SyncStatus>` = `{ enabled, configured, lastSyncAt, running, lastResult }` |
| `run()` | `Promise<SyncStatus>` |
| `test()` | `Promise<{ ok: boolean; message: string }>` |
| `onChanged(cb)` | `() => void` |

WebDAV 备份项由 `SyncScopeDialog` 决定：`settings`、`library`，以及声明了 `backupFile` 的插件的 `mod:<id>`。插件侧只需要在清单里写 `backupFile`，**不需要任何代码**。

### 5.8 `window.api.fonts`

| 方法 | 签名 |
| --- | --- |
| `list()` | `Promise<{ fonts: FontFace[]; defaultId: string; dir: string }>` |
| `import()` | `Promise<{ imported: FontFace[]; skipped: {path,reason}[] }>` |
| `importPaths(paths)` | 同上 |
| `remove(id)` | `Promise<{ ok: boolean; reason? }>` |
| `reveal()` | `Promise<string>`（打开字体目录） |

`FontFace = { id, name, path, format: 'ttf'\|'otf'\|'woff'\|'woff2'\|'ttc', managed, size, builtin }`。

### 5.9 `window.api.mods`

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `list()` | `Promise<ModRecordInfo[]>` | 已安装插件（含 `backupFile?`、`firstRun`、`enabled`） |
| `importZip(zipPath)` | `Promise<ModImportResult>` | 从明确路径安装（拖拽用）。`{ ok, canceled?, error?, mod?, upgraded? }` |
| `pickAndImport()` | `Promise<ModImportResult>` | 打开文件对话框再安装 |
| `uninstall(id)` | `Promise<{ ok: boolean; error?: string }>` | 删除目录 + 状态项 |
| `setOrder(ids)` | `Promise<{ ok: boolean }>` | 侧栏顺序（设置页的工具排序用） |
| `markIntroduced(id)` | `Promise<{ ok: boolean }>` | 把 `firstRun` 置 false（宿主展示完引导后调用） |
| `openFolder()` | `Promise<string>` | 打开 `<userData>/mods` 并返回路径 |
| `onChanged(cb)` | `() => void` | 插件集合变化（安装/卸载/升级）时触发 |

### 5.10 `window.api.env` 与 `onToast`

```ts
window.api.env.platform            // 'win32'
window.api.env.versions            // { electron, chrome, node }
window.api.onToast(cb)             // (t: ToastEvent) => void；ToastEvent = { id, kind, message }，返回取消订阅
```

`onToast` 是"主进程想弹一条宿主 toast"的通道（例如后台任务完成），插件一般不订阅它；自己弹 toast 用 `__DOLA__.toast`。

---

## 6. 构建：Vite IIFE + React shim

### 6.1 为什么是这个组合

| 需求 | 做法 |
| --- | --- |
| 宿主用 `<script src>` 加载，不是 ESM | `build.lib.formats = ['iife']`，产物是单个经典脚本 |
| 不能有第二份 React | `react` / `react-dom` / `react/jsx-runtime` 别名到 `src/shims/*`，运行期从 `window.__DOLA__` 取 |
| 不能有 chunk 懒加载 | IIFE 天然禁掉代码分割；动态 `import()` 会被内联进同一个文件 |
| 资源只有 `index.js` 一个文件 | `assetsInlineLimit` 拉高，图片/worker 内联成 data URL |

### 6.2 完整 `vite.config.ts`

`example-hello/vite.config.ts`（可直接复制）：

```ts
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Node 20.11+ 的 ESM 才有 import.meta.dirname；modRoot === example-hello/
const modRoot = import.meta.dirname

export default defineConfig({
  root: modRoot,
  publicDir: false,
  resolve: {
    alias: [
      // 必须是精确正则：裸 'react' 会把 react-dom / react/jsx-runtime 一起吞掉
      { find: /^react$/, replacement: resolve(modRoot, 'src/shims/react.ts') },
      { find: /^react\/jsx-runtime$/, replacement: resolve(modRoot, 'src/shims/react-jsx-runtime.ts') },
      { find: /^react\/jsx-dev-runtime$/, replacement: resolve(modRoot, 'src/shims/react-jsx-runtime.ts') },
      { find: /^react-dom$/, replacement: resolve(modRoot, 'src/shims/react-dom.ts') },
      { find: /^react-dom\/client$/, replacement: resolve(modRoot, 'src/shims/react-dom-client.ts') }
    ]
  },
  define: {
    'process.env.NODE_ENV': '"production"'
  },
  build: {
    outDir: resolve(modRoot, 'dist'),
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'esnext',
    assetsInlineLimit: 16 * 1024 * 1024,
    chunkSizeWarningLimit: 8192,
    lib: {
      entry: resolve(modRoot, 'src/index.tsx'),
      formats: ['iife'],
      name: 'DolaMod_hello',
      fileName: () => 'index.js'
    },
    rollupOptions: {
      // IIFE 没有代码分割；exports: 'named' 保持模块对象形状并消掉 mixed-exports 警告
      output: { exports: 'named' }
    }
  }
})
```

> 如果目标是 CJS 环境（例如把配置放进 `"type": "commonjs"` 的包），把 `import.meta.dirname` 换成 `__dirname`，其它不变。

### 6.3 `src/shims/*` 四个文件

它们都很薄，作用只有一个：**把模块说明符接到宿主的实例上**。

| 文件 | 被谁用 | 干什么 |
| --- | --- | --- |
| `shims/react.ts` | 所有 `import ... from 'react'` | 从 `window.__DOLA__.React` 取实例，`export default` + 解构出常用具名导出 |
| `shims/react-jsx-runtime.ts` | JSX 编译产物 `react/jsx-runtime`、`react/jsx-dev-runtime` | 用宿主 `createElement` 实现 `jsx/jsxs/jsxDEV`，并把 `key` 折回 props（`createElement` 从 props 里读 key） |
| `shims/react-dom.ts` | `import { createPortal } from 'react-dom'` | 取 `__DOLA__.ReactDOM`，导出 `createPortal` / `flushSync` / `version` 等 |
| `shims/react-dom-client.ts` | `import { createRoot } from 'react-dom/client'` | 两种形状都兼容：`ReactDOM.createRoot ?? ReactDOMClient.createRoot`，缺失时给出可执行的报错 |

要点（踩过就知道疼）：

- shim 里只能用 `import type { DolaHostBridge } from '../host'`（**type-only**）。写成普通 import 会引入宿主适配层的运行时代码，可能形成循环依赖。
- shim 在模块顶层就取 `window.__DOLA__` —— 因为宿主保证在任何 mod 脚本执行前安装好它。若你会把 bundle 在宿主外加载（比如单测），记得自己先 `window.__DOLA__ = { ... }`。
- 别把 shim 换成 `external: ['react']` + `globals`：IIFE 的 globals 映射会把 `React` 直接当全局变量，而宿主并没有挂 `window.React`。**shim 是唯一正确姿势。**

### 6.4 `tsconfig.json` 与 `env.d.ts`

`example-hello/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]
}
```

`src/env.d.ts` 必须存在：React 19 从 `@types/react` 移除了全局 `JSX` 命名空间，宿主自己补了一份（`src/renderer/src/global.d.ts`）。插件独立构建没有那份声明，于是 `JSX.Element` 会报 `Cannot find namespace 'JSX'`。把它复制过去即可（内容见 `example-hello/src/env.d.ts`）。

**类型从哪来？** 两种方式，二选一：

1. **结构副本（示例采用）**：`src/host.ts` 里照着宿主源码手写 props 接口。优点：插件仓库不需要宿主源码，`tsc` 能过，公开可复制。缺点：宿主加字段时要手动同步。
2. **type-only 引用（宿主仓库内的 mod 采用）**：在 tsconfig 里配路径

   ```json
   "paths": {
     "@host/*": ["../../src/renderer/src/*"],
     "@shared/*": ["../../src/shared/*"]
   }
   ```

   然后 `import type { ButtonProps } from '@host/ui/controls'`。这些 import 在构建时被完全擦除，**不会把宿主源码打进 bundle**。适合插件和宿主同一个仓库（像 `mods/library`）。

### 6.5 构建命令

**A. 装了依赖（推荐给外部开发者）**

```bash
cd example-hello
npm install
npm run build          # → dist/index.js
npm run typecheck      # 可选：tsc --noEmit
```

**B. 离线：复用宿主仓库里已装好的 vite**

```bash
cd example-hello
node "D:/桌面/DSH/dola-toolkit/node_modules/vite/bin/vite.js" build
```

前提是 `example-hello/node_modules` 能解析到 `vite`（配置里 `import { defineConfig } from 'vite'` 需要它）。最省事的做法是在 `example-hello/` 下建一个指向宿主 `node_modules` 的目录联接（junction）：

```powershell
New-Item -ItemType Junction -Path .\node_modules -Target "D:\桌面\DSH\dola-toolkit\node_modules"
```

构建完可以删掉这个 junction；它在 `.gitignore` 里。

成功输出长这样（Vite 8）：

```
vite v8.3.4 building client environment for production...
✓ 9 modules transformed.
dist/index.js  7.89 kB │ gzip: 3.55 kB
✓ built in 27ms
```

### 6.6 构建期的常见坑

| 现象 | 原因 / 解 |
| --- | --- |
| `Invalid hook call` / hooks 顺序报错 | 打进了第二份 React。检查别名是否精确、有没有绕过 shim 直接 `import React` |
| `createRoot is not a function` | 用的是 `import { createRoot } from 'react-dom'`（React 19 不在这个入口）。改成 `react-dom/client` 或 `__DOLA__.ReactDOM.createRoot` |
| `Cannot find namespace 'JSX'` | 缺 `src/env.d.ts` |
| 顶层出现 `import` 语句的报错 / `Unexpected token 'export'` | 走了 ESM 格式。`lib.formats` 必须是 `['iife']` |
| 别名把 `react-dom` 也替换掉了 | 别名写成了字符串 `'react'`。必须用 `/^react$/` 这种精确正则 |
| 产物里出现了多个文件（chunk） | 有动态 `import()` 且没内联；IIFE 下 Vite 会内联，但如果手写了 `manualChunks` 就会炸 |
| 图片 404 | 资源没内联或用了相对路径。把 `assetsInlineLimit` 调大，或把资源放到插件根目录并用 `dola-mod://<id>/file.png` 引用（`img-src` 允许） |

---

## 7. 打包成 zip

### 7.1 目录要求（最容易错的地方）

zip 的**根目录**（不套文件夹）必须直接是：

```
dola-mod.json
index.js          ← 清单里 entry 指向的文件，和清单平级
（其它运行期需要的资源，可选，同层）
```

不要包含：`src/`、`node_modules/`、`dist/`、`tsconfig.json`、`vite.config.ts`、`.git/`。
（宿主可以容忍多套一层文件夹，但平铺最稳。）

错误示范与对应的报错：

| zip 内容 | 装的时候报 |
| --- | --- |
| 只有 `dist/index.js`，没有清单 | `这似乎不是Dola Toolkit的插件呢~` |
| 有清单，入口在 `dist/index.js` 但 `entry` 写的 `index.js` | `插件缺少入口文件 index.js` |
| 整个 `example-hello/` 目录（含 node_modules） | 能装（清单在第二层），但包巨大且 `entry` 路径要对 |
| `dola-mod.json` 写成了 `Dola-Mod.json` / `mod.json` | `这似乎不是DolaToolkit…`（清单名大小写敏感） |

### 7.2 用脚本打（推荐）

```bash
node scripts/pack.mjs hello
# ✔ hello v1.0.0
#   D:\桌面\DSH\dola-toolkit-mod\mods\hello-1.0.0.zip  (4.1 KB)
#   根目录：dola-mod.json, index.js
```

脚本做的事：读 `example-hello/dola-mod.json` → 找入口（先找插件根，再找 `dist/`）→ 把**清单和入口复制到一个平级的临时目录** → 用 Windows 自带 `tar -a -c -f` 压缩 → 清理临时目录。输出名是 `<id>-<version>.zip`。

### 7.3 用 PowerShell 打（不依赖 Node）

在 `example-hello/` 里：

```powershell
$stage = "..\mods\.stage-hello"
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item dola-mod.json $stage
Copy-Item dist\index.js  $stage
Compress-Archive -Path "$stage\*" -DestinationPath "..\mods\hello-1.0.0.zip" -Force
Remove-Item $stage -Recurse -Force
```

> 注意 `Compress-Archive -Path dist\index.js` 会把文件放进 `dist/` 子目录，所以**必须先复制到平级目录**再压。

### 7.4 用 bsdtar（和宿主解压用的是同一个工具）

```bash
cd example-hello
mkdir -p ../mods/.stage-hello
cp dola-mod.json dist/index.js ../mods/.stage-hello/
"/c/Windows/System32/tar.exe" -a -c -f ../mods/hello-1.0.0.zip -C ../mods/.stage-hello dola-mod.json index.js
rm -rf ../mods/.stage-hello
```

### 7.5 自检

```bash
"/c/Windows/System32/tar.exe" -tvf mods/hello-1.0.0.zip
# -rw-…  dola-mod.json
# -rw-…  index.js
```

再确认一次：解压到空目录后，`dola-mod.json` 和 `entry` 是**兄弟**关系。

---

## 8. 样式约定

插件**没有独立样式表**：宿主把 `tokens.css` / `base.css` / `components.css` / `pages.css` 全局加载过，插件直接复用类名和 CSS 变量，于是**自动跟随主题、深浅色、圆角、密度、字体缩放**。

### 8.1 布局类（最常用）

| 类 | 作用 |
| --- | --- |
| `.page` | 页面容器：`flex column`、`min-height:0`、带进场动画。**你的根节点应该用它** |
| `.page-header` | 顶部栏（`flex`、左右 padding）；内部 `h1` 有 22px 的 display 字体样式，`.sub` 是副标题 |
| `.page-header-actions` | 顶部栏右侧按钮区（`margin-left:auto`） |
| `.page-body` | 内容区：`flex:1`、`overflow-y:auto`、左右 padding。`pad-top` / `flush` 微调 |
| `.stack` / `.stack-sm` | 纵向 flex，gap 16px / 8px |
| `.hstack` | 横向 flex + 居中，gap 8px |
| `.grid-2` / `.grid-3` | 等宽网格 |
| `.set-card` | 设置卡片：圆角、边框、`overflow:hidden`；里面放 `SettingRow` 会自动生成分隔线 |
| `.set-section-title` / `.set-section-desc` | 设置分组标题 / 说明 |
| `.card` / `.row` | 通用卡片 / 列表行（`.row-title`、`.row-sub`、`.row-actions`） |
| `.divider` / `.spacer` | 1px 分隔线 / `flex:1` 占位 |
| `.muted` / `.tiny` / `.mono` / `.strong` | 次要文字 / 11.5px / 等宽 / 加粗 |
| `.badge`（或 `Badge` 组件） | 小徽章 |
| `.mod-page` | 宿主给插件页面外壳用的（你一般不用自己写） |

### 8.2 CSS 变量

**颜色**（MD3，深浅色各一套，插件只写 `var(...)` 即可）：

```
--md-primary            --md-on-primary          --md-primary-container   --md-on-primary-container
--md-secondary          --md-secondary-container  --md-on-secondary-container
--md-surface-container-lowest / -low / (默认) / -high / -highest
--md-on-surface         --md-on-surface-variant   --md-outline             --md-outline-variant
--md-error              --md-error-container      --md-on-error-container  --md-scrim
--md-background         --md-on-background        --md-inverse-surface     --md-inverse-on-surface
```

**形状 / 间距 / 字体 / 动效**：

```
--shape-xs 4px  --shape-sm 8px  --shape-md 12px  --shape-lg 16px  --shape-xl 28px  --shape-full 999px
--sp-1 4px  --sp-2 8px  --sp-3 12px  --sp-4 16px  --sp-5 20px  --sp-6 24px  --sp-8 32px  --sp-10 40px
--font-ui  --font-display  --font-mono
--dur-1..--dur-4  --ease-standard  --ease-emphasized  --ease-emphasized-decel
--elev-1..--elev-4
```

### 8.3 规则

- 颜色**永远**用变量（或 `color-mix(in srgb, var(--md-primary) 16%, transparent)`），写死 `#fff` 在深色主题下会瞎。
- 尺寸优先用 `--sp-*` / `--shape-*`，跟着宿主的密度设置走。
- 需要自己写样式时：`style={{...}}` 内联即可；确实要选择器就在插件里注入 `<style>`（`style-src` 允许 `'unsafe-inline'`），或者放一个 `.css` 在插件目录用 `<link rel="stylesheet" href="dola-mod://<id>/mod.css">`（`style-src` 允许 `dola-mod:`）。**但优先用现有类，视觉才和宿主一致。**
- 滚动：内容多时把滚动交给 `.page-body`，别在插件根上写 `overflow:auto` 再套一层。

---

## 9. 调试技巧

### 9.1 找到真正的安装目录

- 宿主里：`await window.api.mods.openFolder()`；
- 资源管理器：`%APPDATA%\dola-toolkit\mods\`（开发运行）/ `%APPDATA%\Dola Toolkit\mods\`（安装版）；
- 里面 `<id>/` 是插件本体，`mods.json` 是状态（`version`、`firstRun`、`enabled`、`installedAt`）。

### 9.2 重新导入即升级

把新 zip 拖进「添加工具」页：

- 同 id + 同版本 → 覆盖文件（适合反复调试界面）；
- 同 id + 更高版本 → 覆盖 + `upgraded: true`，toast 显示「已更新到 x.y.z」；
- 同 id + 更低版本 → 被拒（见 3.3）。

宿主导入成功后会 `invalidateMod(id)` 清掉脚本缓存，所以**不用重启应用**。若当前页面正停在该插件上，切到别的页面再切回来即可看到新界面。

### 9.3 看日志和报错

- 页面级错误直接画在插件区域里（`无法加载「X」` / `插件文件加载失败` / `插件没有正确注册…`）。
- 打开 DevTools（`Ctrl + Shift + I`），Console 里有你的 `console.info` 和未捕获异常；Network 里能看到 `dola-mod://hello/index.js` 的 MIME 和状态码。
- 主进程日志：`<userData>\logs\`（`window.api.app.openLogs()` 直接打开）。导入失败会写 `mod.import.bad-manifest` / `mod.import.not-a-mod` / `mod.import.no-entry` / `mod.import.ok` 等标记。
- 导入失败时**不会留下残留**：临时目录、目标目录都被清理；`mods.json` 也不会多一项。

### 9.4 几个快速自检

| 症状 | 先查 |
| --- | --- |
| 侧边栏没有出现 | 装成功了吗（toast）；`mods.json` 里有没有；`enabled` 是否 `false` |
| 点进去白屏 | Console 有没有异常；`mount` 有没有 `root.render(...)`；根节点高度是不是 0 |
| 界面在但没滚动 | 根节点没用 `.page` / `.page-body` |
| 设置页按钮点不动 / 没有入口 | `mountSettings` 是否存在；`settingsIcon`/`settingsName` 只是展示用 |
| hooks 报错 | 双份 React（第 6 节） |
| toast 不弹 | 有没有 `__DOLA__`；是不是在宿主外（比如单测环境）调用的 |
| 图表/图片不显示 | 资源有没有被打进 bundle；`dola-mod://` 引用路径对不对；CSP `img-src` 允许但 `connect-src` 不允许 fetch |

### 9.5 版本号比较速查

```
1.0.0   == 1.0        （缺失段按 0）
1.0.0   == 1.0.0-beta （beta 段 parseInt 失败 → 0）
1.2.10  >  1.2.9      （数字比较）
2.0.0   >  1.99.99
```

发布新版本时**只改大/中/小版本号**（如 `1.0.0 → 1.0.1`）就够了，不要用 `v1.0.1`（清单校验会拒绝）。

---

## 10. 最小示例完整清单

`example-hello/` 共 14 个文件（不含 `node_modules/`、`dist/`）：

| 文件 | 作用 |
| --- | --- |
| `dola-mod.json` | 清单（id `hello`，名称「示例工具」） |
| `package.json` | `build` / `watch` / `typecheck` / `pack` 脚本 + devDependencies |
| `vite.config.ts` | IIFE 构建 + 4 个 react 别名 |
| `tsconfig.json` | 严格模式、`jsx: react-jsx`、`types: ["vite/client"]` |
| `src/env.d.ts` | 补回 React 19 移除的全局 `JSX` 命名空间 |
| `src/index.tsx` | 入口：`mount` / `mountSettings` / 注册到 `__DOLA_MODS__` |
| `src/host.ts` | 宿主桥适配层：读 `window.__DOLA__`，导出组件、`toast`、`useApp`、`hostVersion`，并给出全部 props 类型 |
| `src/HelloPage.tsx` | 主界面（`Button` / `TextInput` / `SettingRow` / `Badge` / `Dialog` / `useHotkey` / `toast` / `useApp`） |
| `src/SettingsPage.tsx` | 二级设置页（`Select` / `Slider` / `Switch` / `Badge` / `Dialog` / `window.api.app.info`） |
| `src/prefs.ts` | 插件本地偏好（localStorage，`dola.hello.prefs`） |
| `src/shims/react.ts` | `react` → 宿主实例 |
| `src/shims/react-jsx-runtime.ts` | JSX runtime → 宿主 `createElement` |
| `src/shims/react-dom.ts` | `createPortal` 等 → 宿主 |
| `src/shims/react-dom-client.ts` | `createRoot` → 宿主 |

### 10.1 入口全文 `src/index.tsx`（去掉注释的等价版本）

```tsx
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { HelloPage } from './HelloPage'
import { HelloSettingsPage } from './SettingsPage'

export function mount(container: HTMLElement): () => void {
  const root = createRoot(container)
  root.render(createElement(HelloPage))
  return () => root.unmount()
}

export function mountSettings(container: HTMLElement): () => void {
  const root = createRoot(container)
  root.render(createElement(HelloSettingsPage))
  return () => root.unmount()
}

const mod = { mount, mountSettings }
;(window.__DOLA_MODS__ ??= {})['hello'] = mod
export default mod
```

`createRoot` 来自 shim，实际执行的是宿主那份 ReactDOM —— 所以插件的 hooks、宿主组件的 hooks 在同一个 reconciler 上，`useApp` 这种全局 store 也能正常触发更新。

### 10.2 一个最小的 `src/host.ts` 骨架

如果只想要最少的东西：

```ts
type Bridge = {
  React: any
  ReactDOM: any
  ui: Record<string, any>
  toast: Record<'info' | 'success' | 'warn' | 'error', (m: string) => void>
  useApp: any
  version: string
}

function bridge(): Bridge {
  if (!window.__DOLA__) throw new Error('[my-mod] window.__DOLA__ 缺失')
  return window.__DOLA__ as Bridge
}

const b = bridge()
export const Button = b.ui.Button
export const SettingRow = b.ui.SettingRow
export const toast = b.toast
export const useApp = b.useApp
export const hostVersion = b.version
```

示例工程里那版是"带完整类型"的版本，二选一即可。

---

## 11. 发布清单与 FAQ

### 发布前

- [ ] `id` 全局唯一、只含 `[a-zA-Z0-9._-]`，且与 `__DOLA_MODS__[id]` 一致
- [ ] `version` 比上一版高（用数字段，不要 `v` 前缀）
- [ ] `name` / `settingsName` / `icon`（真实存在的图标名）/ `description` 都填了
- [ ] `entry` 与 zip 里的文件名一致，且是 `.js` / `.mjs`
- [ ] `npm run build` + `npm run typecheck` 都过
- [ ] zip 根目录只有清单 + 入口（+ 必要资源）
- [ ] 在干净的宿主里装一遍：首次引导、侧栏图标、主界面、设置页、切页/卸载无报错
- [ ] `onXxx` 订阅都在卸载函数里 `off()`
- [ ] 没有把 `console.log` 里塞大对象（IPC/日志会变慢）

### FAQ

**Q：能在插件里用 npm 包吗？**
能，会被打进 bundle。但凡是依赖 React 的库（zustand、react-router、图标库…）都会通过上面的别名拿到宿主的 React，这是好事。依赖 `eval`、`fs`、`process` 的包不行。

**Q：能用 Web Worker / WASM 吗？**
Worker 需要独立文件 + 正确的 MIME，`dola-mod://` 下 worker 加载没有被验证过；WASM 需要 `script-src` 允许 `wasm-unsafe-eval`（当前没有）。**尽量别用**，必须用时考虑把逻辑搬进 `window.api` 那一侧（即向宿主提 PR）。

**Q：插件能读写文件吗？**
不能直接读写。只能用 `window.api.*` 里已有的能力（`app.showItem`、`library.*`、`fonts.*`、`mods.*`、`sync.*`）。要让用户数据被 WebDAV 备份，就在清单里声明 `backupFile`，并把数据写到 `<userData>/<你的文件>` —— 但写入仍然需要走宿主提供的 API。当前没有任何通用 `fs` API，所以**别设计需要落盘的功能**。

**Q：为什么我的 `settings.patch()` 没生效？**
见 5.2：未知 section / 非原始值会被 `sanitizePatch` 丢掉；另外 patch 是深合并，`null` 是允许的，`undefined` 会被跳过。

**Q：`firstRun` 引导怎么再次看到？**
把 `mods.json` 里该项的 `firstRun` 改回 `true`（先退出宿主），或者卸载重装（重装后 `firstRun: true`）。升级不会重弹。

**Q：能在插件里 `import` 宿主的源码吗？**
只能 `import type`（构建时擦除）。值导入会把宿主代码打进 bundle，等于第二份实现，一定出问题。

**Q：`window.__DOLA_MODS__` 里能放别的东西吗？**
能放，但宿主只读 `<id>.mount` / `<id>.mountSettings`，多放的字段没有意义。不要在别人的 id 下注册。

---

## 12. 源码核对：与 `docs/mod-api.md` 的差异

写这份指南时把宿主源码逐行对了一遍。以宿主 `0.2.1`、`f144231` + 工作区未提交修改为准，**以下内容 `docs/mod-api.md` 没有写或写得不准**（已同步反馈给宿主维护者）：

**清单（`src/main/mods/manifest.ts`）**

1. **`backupFile` 字段完全没有文档**：可选，相对 `<userData>` 的 JSON 路径，声明后插件会出现在 WebDAV 同步的备份列表里（`mod:<id>`，远端名 `dola-mod-<id>.json`）。这是最近才加的工作区改动（`manager.ts` / `sync.ts` / `types.ts` 同步改了）。
2. **默认 `icon: "extension"` 是坏默认值**：`icons.generated.ts` 的 166 个图标里没有 `extension`，`Icon` 会回退成 `info`。宿主自己的「设置 → 工具」分组标题也用了 `extension`，同样显示成 info。建议改成实际存在的名字（如 `apps`）或把 `extension` 加进图标集。
3. **清单可以在 zip 里嵌套最多两层**：`findManifest` 递归深度 0/1/2，文档只字未提"是否允许套文件夹"，实际允许。
4. **`version` 校验正则没有结尾锚点**：`^\d+(\.\d+)*` 使得 `1.0.0-beta`、`1.0.0junk` 都能通过；再结合 `compareVersions`（非数字段当 0），`1.0.0-beta` 与 `1.0.0` **相等**，所以"预发布版"语义并不存在，版本号不能靠后缀区分先后。
5. **`firstRun` 的细节**：只有"同版本重装"才保留 `firstRun`；版本号变化会把它置 `false`，所以升级永远不再弹使用引导。
6. **未知字段被静默忽略**，不会报错也不会保存 —— 文档没写，容易让人以为写错字段会有提示。

**入口与协议（`protocol.ts` / `ModHost.tsx`）**

7. **入口文件扩展名受 MIME 白名单限制**：只有 `.js` / `.mjs` 会被当作 `text/javascript`；`.cjs` 等会变成 `application/octet-stream`，`<script>` 加载失败。文档只说"入口 bundle，默认 index.js"。
8. **`dola-mod://` 的 CSP 缺口**：协议本身 `supportFetchAPI: true`，但页面 CSP 的 `connect-src` 里没有 `dola-mod:` —— 所以 `fetch()` 自己的资源会被 CSP 拦掉（图片/样式/脚本可以）。文档没有提醒"数据要打进 bundle"。
9. **没有 `unsafe-eval`**：依赖 `eval` / `new Function` 的库会失败，文档未提。
10. **插件的 React root 不在 StrictMode 下**（宿主 App 包了 StrictMode，mod 是独立 root）—— 调试时"为什么宿主组件 effect 跑两次、我的只跑一次"的答案。
11. **未注册/加载失败的运行期报错原文**没有文档化：`插件没有正确注册，可能不是有效的 Dola Toolkit 插件`、`插件文件加载失败`、`该插件没有提供界面` / `该插件没有提供设置界面`、`无法加载「X」`。

**宿主桥（`bridge.ts`）**

12. **`ui` 的组件清单不全**：文档只列了 `Button, IconButton, TextInput, TextArea, Select, Slider, Segmented, Tabs, Dialog, Menu, Empty, Spinner, Switch, SettingRow, Icon, hashHue, useHotkey`；
    实际还有 **`Field`、`Checkbox`、`Chip`、`Sheet`、`Badge`、`Progress`**（`import * as controls` 全量展开）。
13. **文档没写 `ReactDOMClient` 字段**（bridge 实际暴露了），也没写 `ReactDOM` 是 `{...react-dom, ...react-dom/client}` 的合并（文档只提了"合并了 react-dom/client"，但没说明 key 的位置）。
14. **文档没写 `ui.Sheet` / `Chip` 等 props**；本次已在第 4.2 节补齐（逐条从源码抄的）。

**`window.api`（`src/preload/index.d.ts`）**

15. **`mods` 组只写了 4 个方法**，实际有 8 个：`list`、`importZip`、**`pickAndImport`**、`uninstall`、`setOrder`、**`markIntroduced`**、**`openFolder`**、**`onChanged`**。
16. **`app` 组只写了 4 件事**（版本/窗口/外链/目录/截图），实际还有整组更新能力（`checkAppUpdate`、`stageCore`、`stageAllCores`、`applyStagedNow`、`takePendingUpdate`、`onUpdateProgress`…），以及 `onCloseAsk` / `resolveClose` / `trayAvailable` / `setTitleBarTheme` / `openLogs`。
17. **`env` 分组和 `onToast` 完全没写**。
18. **`settings.patch` 的 `sanitizePatch` 限制（只保留 7 个 section + 原始值叶子）没写**。这是最容易踩的坑：插件想存自定义字段会"静默丢失"。
19. **`library` / `proxy` / `fonts` 的方法数量都比文档列的多**（详见 5.4–5.8）。

**样式与目录**

20. **文档没写 `<userData>` 在开发运行 vs 安装版下的实际路径不同**（`%APPDATA%\dola-toolkit` vs `%APPDATA%\Dola Toolkit`），建议一律用 `mods.openFolder()`。
21. **Windows 解压用的是 `C:\Windows\System32\tar.exe`**（bsdtar），所以 zip 必须是标准 deflate；用奇怪压缩方法的包会报 `解压失败 (2)`。

如果你在宿主里改了其中任何一条，欢迎顺手更新 `docs/mod-api.md`——这份 README 会跟着改。

---

## 许可

MIT，见 [`LICENSE`](LICENSE)。示例插件与文档都可以随意复制进你自己的插件。


## 附：WebDAV 备份字段（0.3.2 起）

清单里声明这两个字段后，插件会出现在「设置 → 同步内容」的列表中：

```json
{
  "backupFile": "my-mod/state.json",
  "backupLabel": "示例工具的偏好与历史记录"
}
```

- `backupFile` 相对 `<userData>` 目录，必须是 JSON 文件；远端保存为 `dola-mod-<id>.json`
- `backupLabel` 是给用户看的说明，会显示在同步列表的「名称」列 —— **请写清楚里面是什么数据**，
  用户需要知道哪些内容会被上传
- 备份只上传，不会自动下载恢复

---

## 本仓库结构

```
plugins/           各插件的源码（每个目录都可独立构建）
  library/         书库（EPUB / PDF / FB2 / MOBI / TXT / RTF 阅读器）
  proxy/           代理（Xray / sing-box / Mihomo 多内核）
  testshell/       测试空壳（一个 bundle 通过脚本 URL 识别自身 id，可打出 Test1…Test10）
mods/              已构建好的插件包（.zip），可直接安装
docs/mod-api.md    宿主接口参考
example-hello/     最小可运行示例
scripts/pack.mjs   打包脚本
```

### 从源码构建某个插件

```powershell
# 复用主程序的 node_modules，避免单独安装依赖
New-Item -ItemType Junction -Path example-hello\node_modules -Target <dola-toolkit>\node_modules
node <dola-toolkit>/node_modules/vite/bin/vite.js build --config plugins/proxy/vite.config.ts
```

产物在 `plugins/<name>/dist/index.js`，再和 `dola-mod.json` 一起打成 zip（根目录两个文件）。

> `example-hello` 与各 `plugins/*` 的 `vite.config.ts` 都是同一套：IIFE 输出、React 走宿主桥
> 的 shim、`@shared` 指向主程序的共享类型。

---

## 主进程插件服务（0.5.0 起）

插件除了界面，还可以带一份**主进程代码**：`main/index.js`。主程序在启动时（以及插件安装后立即）加载它，界面通过通用桥 `window.api.mod` 调用。

```
window.api.mod.invoke('proxy', 'state')            // 调主进程服务
window.api.mod.on('proxy', 'state-changed', cb)    // 订阅广播
```

插件主进程 bundle 需要导出 `register(dola)`：

```js
exports.register = (dola) => {
  dola.ipc.handle('state', () => ({ … }))       // → mod:proxy:state
  dola.ipc.broadcast('state-changed', payload)   // → 界面收到事件
  dola.on('boot', () => { /* 自动启动等 */ })
  dola.on('quit', () => { /* 清理进程、恢复系统设置 */ })
}
```

`dola` 提供的能力：

| 字段 | 说明 |
| --- | --- |
| `ipc.handle / broadcast` | 注册处理器、向界面广播 |
| `on('boot' \| 'quit')` | 生命周期 |
| `settings.get/patch` | 应用设置 |
| `store.get/patch` | 代理节点存储（由主程序持有，升级不丢节点） |
| `cores.*` | 内核二进制查找、地理库路径、版本探测 |
| `windows.*` | 窗口访问 |
| `dataDir` | 插件自己的数据目录 |

构建方式见 `plugins/proxy/vite.main.config.ts`（CJS 输出，Electron 与 Node 内建模块 external），
打包时把 `main/index.js` 一并放进 zip 根目录下的 `main/`。
