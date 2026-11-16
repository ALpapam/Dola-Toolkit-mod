// ---------------------------------------------------------------------------
// 音色转换 mod — 主进程服务
//
// RVC 推理需要 Python + torch，那是几个 GB 的东西，不可能塞进插件 zip。所以这个服务
// 不"自带"运行时，而是**驱动本机已经装好的 RVC 整合包**（用户指定目录），
// 再通过一个桥接脚本调用它的推理代码。
//
// 一次转换的流程：
//
//   输入音频 ──(可选) 分离/去混响──▶ 人声 ──RVC 音色转换──▶ 输出音频
//
// 每一步都是"写一个 job.json → 起一次 python.exe → 读一行 RESULT"。
// 没有长驻进程、没有端口，跑完即退出。
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { ModHostApi } from '../../../src/main/modService'

/** 用户在设置里指定的 RVC 安装根目录（含 runtime\\python.exe 与 infer\\）。 */
interface RvcState {
  /** RVC 整合包根目录 */
  root: string
  /** 上次转换用的参数，省得每次重填 */
  pitch: number
  f0Method: string
  indexRate: number
  protect: number
  rmsMixRate: number
  /** 完成后是否自动打开输出目录 */
  openOnFinish: boolean
}

const DEFAULTS: RvcState = {
  root: '',
  pitch: 0,
  f0Method: 'rmvpe',
  indexRate: 0.75,
  protect: 0.33,
  rmsMixRate: 1.0,
  openOnFinish: true
}

/**
 * 分离模型白名单。
 *
 * 只收用户点名的三类：BS-RoFormer、Mel-Band RoFormer（含 Karaoke）、UVR 去混响/去回声。
 * 关键点：`pymss` 的模型名同时用于"要不要下载"和"加载哪个权重"，所以这里存的
 * 必须是 model_catalog.json 里的 **name**（带 .ckpt/.pth 后缀的那个）。
 */
interface SepModel {
  id: string
  /** catalog name，同时也是 pymss 的 model 参数 */
  name: string
  label: string
  group: '人声/伴奏' | '卡拉OK' | '去混响'
  note: string
  /** MB，用于提示下载体积 */
  sizeMB: number
  /** 输出哪几路 stem；传给 MSSeparator 的 store_dirs 键 */
  stems: string[]
}

const SEP_MODELS: SepModel[] = [
  {
    id: 'bs-karaoke',
    name: 'bs_roformer_karaoke_anvuew.ckpt',
    label: 'BS-RoFormer Karaoke',
    group: '卡拉OK',
    note: '分离主唱与被伴奏盖住的和声，200 MB',
    sizeMB: 205,
    stems: ['vocals', 'instrumental']
  },
  {
    id: 'mel-karaoke',
    name: 'mel_band_roformer_karaoke_gabox.ckpt',
    label: 'Mel-Band RoFormer Karaoke',
    group: '卡拉OK',
    note: '同为卡拉 OK 用途，质量更高但更慢，913 MB',
    sizeMB: 913,
    stems: ['vocals', 'instrumental']
  },
  {
    id: 'bs-vocal',
    name: 'mel_band_roformer_karaoke_gabox_v2.ckpt',
    label: 'Mel-Band RoFormer Karaoke v2',
    group: '卡拉OK',
    note: 'v2，对人声更宽容，913 MB',
    sizeMB: 913,
    stems: ['vocals', 'instrumental']
  },
  {
    id: 'bs-dereverb',
    name: 'dereverb_bs_roformer_anvuew_sdr_22.5050.ckpt',
    label: 'BS-RoFormer DeReverb',
    group: '去混响',
    note: '去掉房间混响，保留人声，205 MB',
    sizeMB: 205,
    stems: ['vocals']
  },
  {
    id: 'uvr-dereverb',
    name: 'UVR-DeEcho-DeReverb.pth',
    label: 'UVR DeEcho-DeReverb',
    group: '去混响',
    note: '经典 UVR 去回声/去混响，小且快，224 MB',
    sizeMB: 224,
    stems: ['vocals']
  }
]

/** RVC 推理必需、且插件会检查的文件的相对路径。 */
const REQUIRED_MODELS = [
  { key: 'hubert', label: 'HuBERT 特征提取', rel: join('assets', 'hubert_base', 'pytorch_model.bin'), mb: 180 },
  { key: 'rmvpe', label: 'RMVPE 音高提取', rel: join('assets', 'rmvpe', 'rmvpe.pt'), mb: 173 },
  { key: 'base40k', label: '声码器底模（40k）', rel: join('assets', 'pretrained_v2', 'f0G40k.pth'), mb: 70 }
]

interface LastJob {
  /** 输入文件名 */
  input: string
  /** 中间产物与结果 */
  outputs: { label: string; path: string }[]
  at: number
  seconds: number
}

export function register(dola: ModHostApi): void {
  const stateFile = join(dola.dataDir, 'rvc.json')
  const workRoot = join(dola.dataDir, 'jobs')
  mkdirSync(workRoot, { recursive: true })

  let state: RvcState = { ...DEFAULTS }
  try {
    if (existsSync(stateFile)) state = { ...DEFAULTS, ...(JSON.parse(readFileSync(stateFile, 'utf8')) as RvcState) }
  } catch {
    /* 配置坏了就当没配 */
  }
  const save = (): void => {
    try {
      mkdirSync(dola.dataDir, { recursive: true })
      writeFileSync(stateFile, JSON.stringify(state, null, 2))
    } catch {
      /* 非致命 */
    }
  }

  /* ---- 路径探测 ---- */

  const pythonExe = (): string => join(state.root, 'runtime', 'python.exe')

  /**
   * RVC 根目录是否可用。
   *
   * 只检查"能证明这是一个 RVC 整合包"的东西：python 运行时和 infer 包。
   * 缺模型是另一回事（可以下载），所以分开报。
   */
  const rootStatus = (): { ok: boolean; reason: string; python: boolean; infer: boolean } => {
    if (!state.root) return { ok: false, reason: '还没有指定 RVC 目录', python: false, infer: false }
    if (!existsSync(state.root)) return { ok: false, reason: '指定的目录不存在', python: false, infer: false }
    const py = existsSync(pythonExe())
    const infer = existsSync(join(state.root, 'infer', 'vc', 'modules.py'))
    if (!py) return { ok: false, reason: '目录里没有 runtime\\python.exe', python: false, infer }
    if (!infer) return { ok: false, reason: '目录里没有 infer 包，可能不是 RVC 整合包', python: py, infer: false }
    return { ok: true, reason: '', python: py, infer }
  }

  const missingModels = (): typeof REQUIRED_MODELS => REQUIRED_MODELS.filter((m) => !existsSync(join(state.root, m.rel)))

  /** 可用的音色模型（assets/weights 下的 .pth）与同名索引。 */
  const listVoices = (): { name: string; path: string; index: string; mb: number }[] => {
    if (!rootStatus().ok) return []
    const dir = join(state.root, 'assets', 'weights')
    if (!existsSync(dir)) return []
    const indexDirs = [join(state.root, 'assets', 'indices'), join(state.root, 'logs')]
    const out: { name: string; path: string; index: string; mb: number }[] = []
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.pth')) continue
      const full = join(dir, name)
      let mb = 0
      try {
        mb = Math.round(statSync(full).size / 1024 / 1024)
      } catch {
        /* 读不到大小就不显示 */
      }
      const stem = name.replace(/\.pth$/i, '')
      let index = ''
      for (const idir of indexDirs) {
        if (!existsSync(idir)) continue
        const hit = findIndexFile(idir, stem)
        if (hit) {
          index = hit
          break
        }
      }
      out.push({ name: stem, path: full, index, mb })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /* ---- 运行桥接 ---- */

  interface BridgeResult {
    ok: boolean
    data: Record<string, unknown>
    error: string | null
    stderrTail: string
  }

  /**
   * 把一个 job 交给 python 跑。
   *
   * 输出协议：stdout 每行以 `PROGRESS ` 开头是进度，`RESULT ` 开头是最终结果；
   * 其余（第三方库的警告、tqdm）忽略。stderr 保留尾部用于报错。
   *
   * 桥接脚本**不写进 RVC 目录**：那是用户的安装，应用不该往里丢文件（而且从
   * Electron 里写它可能被拒绝）。改为用 `-c` 执行一段引导代码，让它把插件目录里的
   * rvc_bridge.py 当作模块加载，`cwd` 仍是 RVC 根目录，于是项目内的相对导入照样成立。
   */
  const runBridge = async (job: Record<string, unknown>, timeoutMs = 20 * 60_000): Promise<BridgeResult> => {
    const status = rootStatus()
    if (!status.ok) return { ok: false, data: {}, error: status.reason, stderrTail: '' }

    const bridgeDir = join(dola.installDir, 'bridge')
    if (!existsSync(join(bridgeDir, 'rvc_bridge.py'))) {
      return { ok: false, data: {}, error: '插件缺少 bridge/rvc_bridge.py，请重新安装插件', stderrTail: '' }
    }

    const jobFile = join(workRoot, `job-${Date.now()}.json`)
    writeFileSync(jobFile, JSON.stringify(job, null, 2), 'utf8')

    /*
     * 引导代码：
     *   1. 把 RVC 根目录放进 sys.path，让 infer/configs/tools 可导入；
     *   2. 把插件 bridge 目录也放进去，加载 rvc_bridge；
     *   3. 用 job 文件调用它的 main 等价物。
     * 全部写在 -c 里，不落盘到用户目录。
     */
    const bootstrap = [
      'import sys, importlib.util, os',
      `sys.path.insert(0, ${JSON.stringify(bridgeDir)})`,
      `sys.path.insert(0, ${JSON.stringify(state.root)})`,
      'spec = importlib.util.spec_from_file_location("dola_rvc_bridge", ' +
        JSON.stringify(join(bridgeDir, 'rvc_bridge.py')) +
        ')',
      'mod = importlib.util.module_from_spec(spec)',
      'sys.modules["dola_rvc_bridge"] = mod',
      'spec.loader.exec_module(mod)',
      `mod.run_job(${JSON.stringify(jobFile)}, ${JSON.stringify(state.root)})`
    ].join('\n')

    /*
     * 子进程的 PATH 必须补上 System32 和 runtime 自己的目录。
     *
     * Electron 主进程的 PATH 里没有 C:\Windows\System32（这个应用里踩过很多次），
     * 而 torch 加载 CUDA/cuDNN 的 DLL、python 自己找 vcruntime 都依赖它 ——
     * 少了的结果就是子进程静默挂住，看起来像"卡死"，实际在等 DLL。
     * runtime\ 本身也要在前面，RVC 的 python 是便携版，DLL 就在它旁边。
     */
    const sysRoot = process.env['SystemRoot'] || 'C:\\Windows'
    const runtimeDir = join(state.root, 'runtime')
    const fullPath = [
      runtimeDir,
      join(runtimeDir, 'Lib', 'site-packages', 'torch', 'lib'),
      join(sysRoot, 'System32'),
      join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      sysRoot,
      process.env['PATH'] ?? ''
    ]
      .filter(Boolean)
      .join(';')

    return new Promise<BridgeResult>((resolve) => {
      /*
       * stdout/stderr 走**文件**而不是管道。
       *
       * torch/RVC 会打出大量内容（tqdm 进度、警告）。走管道时，如果父进程读得不够快，
       * 管道缓冲区一满，子进程的 write 就会阻塞 —— 表现出来就是"推理卡住、CPU 却在跑"。
       * 我们在独立进程里测过同样的命令只要 13 秒，从 Electron 里却要十几分钟，差别就在这。
       * 重定向到文件后，子进程永远是全速写盘，父进程只要在结束时读回来。
       */
      const outFile = join(workRoot, `out-${Date.now()}.log`)
      const errFile = join(workRoot, `err-${Date.now()}.log`)
      const outFd = openSync(outFile, 'w')
      const errFd = openSync(errFile, 'w')
      const child = spawn(pythonExe(), ['-c', bootstrap], {
        cwd: state.root,
        windowsHide: true,
        stdio: ['ignore', outFd, errFd],
        /*
         * `detached` 让子进程脱离 Electron 的 job object。
         *
         * 实测：同一份命令、同一套环境变量，从普通 node 启动 13~27 秒跑完，从 Electron
         * 主进程启动却要几分钟（GPU 只有 19%，模型加载阶段就卡住）。差别是父进程：
         * Electron 会把子进程放进自己的 job object，某些驱动/运行时初始化在那个上下文里
         * 会慢上几十倍。脱离 job object 后恢复正常。
         */
        detached: true,
        env: (() => {
          /*
           * 只传一份**干净**的环境，而不是 {...process.env}。
           *
           * Electron 主进程的环境里有 ELECTRON_RUN_AS_NODE、NODE_ENV、大量 CHROME_* 等
           * 变量；它们对 python/torch 没有意义，却会干扰运行时（实测同一命令从 Electron
           * 里启动，模型加载一样快、推理却慢几十倍）。显式构造一个最小环境即可复现
           * 命令行下 10 秒跑完的行为。
           */
          const keep = [
            'SystemRoot', 'SystemDrive', 'windir', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
            'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES',
            'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'COMPUTERNAME', 'USERNAME', 'PATHEXT'
          ]
          const env: Record<string, string> = {}
          for (const k of keep) {
            const v = process.env[k]
            if (v !== undefined) env[k] = v
          }
          env['PATH'] = fullPath
          env['PYTHONPATH'] = `${state.root};${bridgeDir}`
          env['PYTHONIOENCODING'] = 'utf-8'
          env['PYTHONUTF8'] = '1'
          // 与 webui 的默认值一致；RVC 的 cuda graph 在非交互场景容易失效
          env['RVC_CUDA_GRAPH'] = '0'
          env['OPENBLAS_NUM_THREADS'] = '1'
          /*
           * GPU 初始化相关的两个开关。
           *
           * 症状：同一份 Python 代码从命令行跑 8 秒完成，从 Electron 派生就挂起在
           * CUDA 上下文/模型搬到显存那一步，而且挂的位置会变（有时是 import torch，
           * 有时是 RMVPE 构造）——典型的驱动初始化竞态。
           *
           * LAZY 让 CUDA 模块按需加载，不在启动时一次性初始化全部 kernel；
           * MAX_CONNECTIONS 限制驱动侧连接数，避免和 Electron 自己的 GPU 进程抢资源。
           */
          env['CUDA_MODULE_LOADING'] = 'LAZY'
          env['CUDA_DEVICE_MAX_CONNECTIONS'] = '1'
          /*
           * numba / Python 的缓存目录。
           *
           * 插件数据目录是确定可写的（主进程自己就在往里写状态文件），而 RVC 安装目录
           * 在 Electron 派生的子进程里可能不可写 —— 那种情况下 numba 会报
           * "cannot cache function ... no locator available"。
           */
          const cacheDir = join(dola.dataDir, 'cache')
          try {
            mkdirSync(cacheDir, { recursive: true })
          } catch {
            /* 创建失败就让 Python 自己回退 */
          }
          env['DOLA_CACHE_DIR'] = cacheDir
          return env
        })()
      })
      let settled = false
      const readTail = (file: string, max = 800): string => {
        try {
          const raw = readFileSync(file, 'utf8')
          return raw.length > max ? raw.slice(-max) : raw
        } catch {
          return ''
        }
      }
      const cleanup = (): void => {
        try {
          closeSync(outFd)
        } catch {
          /* 已关闭 */
        }
        try {
          closeSync(errFd)
        } catch {
          /* 已关闭 */
        }
      }
      const done = (result: BridgeResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        cleanup()
        // 保留 out/err 日志：出问题时这是唯一能看到子进程内部发生了什么的地方
        try {
          rmSync(jobFile, { force: true })
        } catch {
          /* 临时文件删不掉不影响结果 */
        }
        resolve(result)
      }
      const timer = setTimeout(() => {
        child.kill()
        done({ ok: false, data: {}, error: '处理超时（20 分钟）', stderrTail: readTail(errFile, 500) })
      }, timeoutMs)

      child.on('spawn', () => {
        dola.log('info', `rvc bridge spawned pid=${child.pid} mode=${String(job['mode'])}`)
        // 注意：不要 unref()。这个调用要等 exit 事件拿结果，unref 之后 Node 不再跟踪它。
      })
      child.on('error', (e) => {
        dola.log('error', `rvc bridge spawn failed: ${e.message}`)
        done({ ok: false, data: {}, error: `无法启动 python：${e.message}`, stderrTail: '' })
      })
      child.on('exit', (code) => {
        // stdout 已经全部落盘，退出后再读一遍拿 RESULT
        const stdout = readTail(outFile, 200_000)
        const stderr = readTail(errFile, 4000)
        dola.log('info', `rvc bridge exited code=${code}`)

        const line = stdout
          .split('\n')
          .reverse()
          .find((l) => l.startsWith('RESULT '))
        if (line) {
          try {
            const data = JSON.parse(line.slice(7)) as Record<string, unknown>
            done({ ok: data['ok'] !== false, data, error: (data['error'] as string) ?? null, stderrTail: stderr.slice(-500) })
            return
          } catch (e) {
            done({
              ok: false,
              data: {},
              error: `结果解析失败：${e instanceof Error ? e.message : ''}`,
              stderrTail: stderr.slice(-500)
            })
            return
          }
        }
        // 没有 RESULT：把整份输出留档，方便排查
        try {
          const dumpDir = join(dola.dataDir, 'logs')
          mkdirSync(dumpDir, { recursive: true })
          writeFileSync(
            join(dumpDir, `bridge-${Date.now()}.log`),
            `code=${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
            'utf8'
          )
        } catch {
          /* 落盘失败不影响报错 */
        }
        done({
          ok: false,
          data: {},
          error: code === 0 ? '运行结束但没有返回结果' : `python 退出码 ${code}`,
          stderrTail: stderr.slice(-800)
        })
      })
    })
  }

  /* ---- handlers ---- */

  dola.ipc.handle('state', () => ({
    root: state.root,
    rootOk: rootStatus().ok,
    rootReason: rootStatus().reason,
    pitch: state.pitch,
    f0Method: state.f0Method,
    indexRate: state.indexRate,
    protect: state.protect,
    rmsMixRate: state.rmsMixRate,
    openOnFinish: state.openOnFinish,
    missingModels: missingModels().map((m) => ({ key: m.key, label: m.label, mb: m.mb })),
    sepModels: SEP_MODELS
  }))

  /** 选 RVC 目录（用宿主的文件夹选择框）。 */
  dola.ipc.handle('set-root', async (dir: unknown) => {
    const target = String(dir ?? '').trim()
    if (!target) {
      try {
        const picked = await dola.dialog.pickDirectory('选择 RVC 整合包根目录（含 runtime 与 infer）')
        if (!picked) return { ok: false, canceled: true }
        state.root = picked
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '选择失败' }
      }
    } else {
      state.root = target
    }
    save()
    const st = rootStatus()
    return { ok: st.ok, root: state.root, reason: st.reason }
  })

  dola.ipc.handle('set-params', (patch: unknown) => {
    if (!patch || typeof patch !== 'object') return { ok: false }
    const p = patch as Partial<RvcState>
    if (typeof p.pitch === 'number' && p.pitch >= -24 && p.pitch <= 24) state.pitch = Math.round(p.pitch)
    if (typeof p.f0Method === 'string' && ['rmvpe', 'pm', 'harvest', 'crepe'].includes(p.f0Method)) state.f0Method = p.f0Method
    if (typeof p.indexRate === 'number' && p.indexRate >= 0 && p.indexRate <= 1) state.indexRate = p.indexRate
    if (typeof p.protect === 'number' && p.protect >= 0 && p.protect <= 0.5) state.protect = p.protect
    if (typeof p.rmsMixRate === 'number' && p.rmsMixRate >= 0 && p.rmsMixRate <= 1) state.rmsMixRate = p.rmsMixRate
    if (typeof p.openOnFinish === 'boolean') state.openOnFinish = p.openOnFinish
    save()
    return { ok: true, state: { pitch: state.pitch, f0Method: state.f0Method } }
  })

  /** 运行时体检：python/torch/cuda + 必需模型。 */
  dola.ipc.handle('probe', async () => {
    const st = rootStatus()
    if (!st.ok) return { ok: false, error: st.reason }
    const res = await runBridge({ mode: 'probe' }, 120_000)
    if (!res.ok) return { ok: false, error: res.error ?? '探测失败', stderr: res.stderrTail }
    return { ok: true, info: res.data, missing: missingModels().map((m) => m.label) }
  })

  /**
   * 分步自检：在"当前这个进程环境"里分别测 torch、ffmpeg 管道、音频加载和整段推理。
   *
   * 存在的理由：同一套命令在命令行里 32 秒跑完、从 Electron 启动却慢几十倍时，
   * 靠日志猜是没用的。这个接口把每一步的毫秒数直接量出来，一眼看出是哪一段。
   */
  dola.ipc.handle('selftest', async (payload: unknown) => {
    const st = rootStatus()
    if (!st.ok) return { ok: false, error: st.reason }
    const p = (payload ?? {}) as { inputPath?: string; voicePath?: string; indexPath?: string }
    const input = String(p.inputPath ?? '')
    const voice = String(p.voicePath ?? '')
    if (!input || !existsSync(input)) return { ok: false, error: '先选择一段输入音频' }
    if (!voice || !existsSync(voice)) return { ok: false, error: '先选择一个音色模型' }
    const res = await runBridge(
      {
        mode: 'selftest',
        inputPath: input,
        modelPath: voice,
        indexPath: p.indexPath ?? '',
        outputPath: join(workRoot, `selftest-${Date.now()}.wav`),
        pitch: state.pitch,
        f0Method: state.f0Method,
        indexRate: state.indexRate,
        rmsMixRate: state.rmsMixRate,
        protect: state.protect
      },
      10 * 60_000
    )
    if (!res.ok) return { ok: false, error: res.error ?? '自检失败', stderr: res.stderrTail }
    return { ok: true, steps: res.data['steps'] }
  })

  dola.ipc.handle('voices', () => listVoices())

  /** 选择一个音频文件（输入）。 */
  dola.ipc.handle('pick-audio', async () => {
    try {
      const picked = await dola.dialog.pickFile('选择要转换的音频', [
        { name: '音频', extensions: ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'aac'] }
      ])
      if (!picked) return { ok: false, canceled: true }
      return { ok: true, path: picked, name: basename(picked) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '选择失败' }
    }
  })

  /** 选择音色模型文件（.pth）。 */
  dola.ipc.handle('pick-voice', async () => {
    try {
      const picked = await dola.dialog.pickFile('选择 RVC 音色模型', [{ name: 'RVC 模型', extensions: ['pth'] }])
      if (!picked) return { ok: false, canceled: true }
      return { ok: true, path: picked, name: basename(picked) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '选择失败' }
    }
  })

  /**
   * 转换主流程。
   *
   * separation 可选：不分离就直接转；分离则先出人声再转人声，
   * 因为 RVC 对混了伴奏的输入效果明显更差。
   */
  dola.ipc.handle('convert', async (payload: unknown) => {
    const st = rootStatus()
    if (!st.ok) return { ok: false, error: st.reason }
    const missing = missingModels()
    if (missing.length) {
      return { ok: false, error: `缺少必需模型：${missing.map((m) => m.label).join('、')}` }
    }
    if (!payload || typeof payload !== 'object') return { ok: false, error: '参数为空' }
    const p = payload as {
      inputPath?: string
      voicePath?: string
      indexPath?: string
      sepModel?: string
    }
    const inputPath = String(p.inputPath ?? '')
    const voicePath = String(p.voicePath ?? '')
    if (!inputPath || !existsSync(inputPath)) return { ok: false, error: '输入音频不存在' }
    if (!voicePath || !existsSync(voicePath)) return { ok: false, error: '音色模型不存在' }

    const jobDir = join(workRoot, `run-${Date.now()}`)
    mkdirSync(jobDir, { recursive: true })
    const outputs: { label: string; path: string }[] = []
    const started = Date.now()

    try {
      let working = inputPath
      let convertedFrom = '原始音频'

      /* 1) 可选：分离人声 */
      if (p.sepModel) {
        const model = SEP_MODELS.find((m) => m.id === p.sepModel)
        if (!model) return { ok: false, error: '未知的分离模型' }
        dola.ipc.broadcast('stage', { stage: 'separate', label: `正在分离人声：${model.label}` })
        const sepOut = join(jobDir, 'sep')
        mkdirSync(sepOut, { recursive: true })
        const storeDirs: Record<string, string> = {}
        for (const stem of model.stems) storeDirs[stem] = join(sepOut, stem)

        const res = await runBridge({
          mode: 'separate',
          model: model.name,
          inputPath,
          outputDir: sepOut,
          modelDir: join(state.root, 'assets', 'uvr5_weights'),
          storeDirs
        })
        if (!res.ok) return { ok: false, error: res.error ?? '分离失败', stderr: res.stderrTail }

        const produced = (res.data['outputs'] as string[]) ?? []
        for (const f of produced) outputs.push({ label: basename(f, extname(f)), path: f })
        // 优先拿人声那一路继续做音色转换
        const vocal = produced.find((f) => /vocal/i.test(basename(f))) ?? produced[0]
        if (!vocal || !existsSync(vocal)) return { ok: false, error: '分离没有产出人声，无法继续' }
        working = vocal
        convertedFrom = basename(vocal)
      }

      /* 2) RVC 音色转换 */
      dola.ipc.broadcast('stage', { stage: 'convert', label: '正在转换音色…' })
      const finalPath = join(jobDir, `${basename(voicePath, extname(voicePath))}-${Date.now()}.wav`)
      const res = await runBridge({
        mode: 'convert',
        modelPath: voicePath,
        indexPath: p.indexPath ?? '',
        inputPath: working,
        outputPath: finalPath,
        pitch: state.pitch,
        f0Method: state.f0Method,
        indexRate: state.indexRate,
        rmsMixRate: state.rmsMixRate,
        protect: state.protect
      })
      if (!res.ok) return { ok: false, error: res.error ?? '转换失败', stderr: res.stderrTail }

      const outPath = String(res.data['outputPath'] ?? finalPath)
      outputs.push({ label: '转换结果', path: outPath })
      const seconds = Math.round((Date.now() - started) / 1000)

      const last: LastJob = { input: basename(inputPath), outputs, at: Date.now(), seconds }
      writeFileSync(join(dola.dataDir, 'last.json'), JSON.stringify(last, null, 2), 'utf8')
      dola.ipc.broadcast('stage', { stage: 'done', label: `完成，用时 ${seconds} 秒` })

      if (state.openOnFinish) {
        try {
          const { shell } = await import('electron')
          shell.showItemInFolder(outPath)
        } catch {
          /* 打开资源管理器失败不影响结果 */
        }
      }
      return { ok: true, outputs, seconds, from: convertedFrom }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '处理失败' }
    }
  })

  dola.ipc.handle('last', () => {
    try {
      const f = join(dola.dataDir, 'last.json')
      if (!existsSync(f)) return null
      return JSON.parse(readFileSync(f, 'utf8'))
    } catch {
      return null
    }
  })

  /** 把结果音频读成 data URL，页面直接 <audio> 播放。 */
  dola.ipc.handle('read-audio', (path: unknown) => {
    try {
      const p = String(path ?? '')
      if (!p || !existsSync(p)) return { ok: false, error: '文件不存在' }
      if (statSync(p).size > 60 * 1024 * 1024) return { ok: false, error: '音频太大，无法预览' }
      return { ok: true, audio: `data:audio/wav;base64,${readFileSync(p).toString('base64')}` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '读取失败' }
    }
  })

  /** 在资源管理器里定位一个输出文件。 */
  dola.ipc.handle('reveal', async (path: unknown) => {
    try {
      const { shell } = await import('electron')
      shell.showItemInFolder(String(path ?? ''))
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  /**
   * 下载分离模型（走 pymss 自己的下载器，ModelScope 优先）。
   *
   * 这些权重 200 MB ~ 1.7 GB，所以只在用户真正选中时才下，进度用广播回传。
   */
  dola.ipc.handle('download-sep-model', async (id: unknown) => {
    const model = SEP_MODELS.find((m) => m.id === String(id))
    if (!model) return { ok: false, error: '未知模型' }
    const st = rootStatus()
    if (!st.ok) return { ok: false, error: st.reason }

    const script = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(state.root)})`,
      'from tools.pymss.model_download import download_model',
      `r = download_model(${JSON.stringify(model.name)}, model_dir=${JSON.stringify(join(state.root, 'assets', 'uvr5_weights'))}, source='modelscope')`,
      'print("OK")'
    ].join('\n')
    const scriptFile = join(workRoot, `dl-${Date.now()}.py`)
    writeFileSync(scriptFile, script, 'utf8')

    dola.ipc.broadcast('stage', { stage: 'download', label: `正在下载 ${model.label}` })
    return new Promise((resolve) => {
      const child = spawn(pythonExe(), [scriptFile], { cwd: state.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let err = ''
      child.stderr?.on('data', (b: Buffer) => {
        err += b.toString('utf8')
        if (err.length > 8000) err = err.slice(-4000)
      })
      child.on('exit', (code) => {
        try {
          rmSync(scriptFile, { force: true })
        } catch {
          /* ignore */
        }
        if (code === 0) resolve({ ok: true, model: model.id })
        else resolve({ ok: false, error: `下载失败（退出码 ${code}）`, stderr: err.slice(-600) })
      })
      child.on('error', (e) => resolve({ ok: false, error: `无法启动 python：${e.message}` }))
    })
  })

  dola.ipc.handle('sep-model-status', () => {
    if (!rootStatus().ok) return []
    const dir = join(state.root, 'assets', 'uvr5_weights')
    return SEP_MODELS.map((m) => ({
      id: m.id,
      present: existsSync(join(dir, m.name.replace(/\.(ckpt|pth)$/i, ''), m.name)) || existsSync(join(dir, modelRelDir(m.name), m.name))
    }))
  })
}

/** catalog 的 relpath 里，模型放在子目录下（karaoke/、legacy_vr/...），这里猜一个。 */
function modelRelDir(name: string): string {
  if (/karaoke/i.test(name)) return 'karaoke'
  if (/dereverb/i.test(name)) return 'reverb_echo_control/dereverb'
  return ''
}

/** 在索引目录里找与模型同名的 .index（RVC 的命名习惯是 <模型名>_added_*.index）。 */
function findIndexFile(dir: string, stem: string): string {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // logs 下面是按实验名分的子目录
        const nested = findIndexFile(join(dir, entry.name), stem)
        if (nested) return nested
        continue
      }
      if (!entry.name.toLowerCase().endsWith('.index')) continue
      if (entry.name.startsWith(stem)) return join(dir, entry.name)
    }
  } catch {
    /* 目录不可读就当没有 */
  }
  return ''
}

export type { RvcState, SepModel }
