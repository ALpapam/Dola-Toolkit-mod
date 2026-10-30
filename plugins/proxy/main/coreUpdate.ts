// ---------------------------------------------------------------------------
// 代理 mod — 内核版本检查与下载
//
// Everything about the proxy cores lives here now: the release metadata, the version
// probe, the download and the swap. The application shell keeps only its own updater.
//
// The archive is verified against the SHA-256 the release publishes, because a truncated
// download used to be indistinguishable from a good one.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { CoreId, CoreUpdateInfo, DownloadChannel } from '@shared/types'
import { httpsGet } from './net'
import { compareVersions, currentCoreVersion, findCore, invalidateCoreVersion } from './binary'
import {
  readStagedCores,
  stageCore,
  writeStagedCores,
  type StagedCore,
  type StageOptions
} from './coreStage'

export interface CoreRepoMeta {
  owner: string
  repo: string
  label: string
  asset: RegExp
  exe: string
}

export const CORE_REPOS: Record<CoreId, CoreRepoMeta> = {
  xray: {
    owner: 'XTLS',
    repo: 'Xray-core',
    label: 'Xray',
    asset: /^Xray-windows-64\.zip$/,
    exe: 'xray.exe'
  },
  singbox: {
    owner: 'SagerNet',
    repo: 'sing-box',
    label: 'sing-box',
    asset: /^sing-box-[\d.]+-windows-amd64\.zip$/,
    exe: 'sing-box.exe'
  },
  mihomo: {
    owner: 'MetaCubeX',
    repo: 'mihomo',
    label: 'Mihomo',
    asset: /^mihomo-windows-amd64(-compatible)?(-v[\d.]+)?\.zip$/,
    exe: 'mihomo.exe'
  }
}

const ENGINE_KEYS: CoreId[] = ['xray', 'singbox', 'mihomo']

/** GitHub release, with the fields we use. */
interface GithubRelease {
  tag_name?: string
  name?: string
  body?: string
  published_at?: string
  assets?: { name: string; browser_download_url: string; size: number; digest?: string | null }[]
}

const USER_AGENT = 'DolaToolkit-CoreUpdater'

/** Only used to pick where the bytes come from; metadata always comes from the API. */
let channelOverride: DownloadChannel = 'github'
export function setUpdateChannel(channel: DownloadChannel): void {
  channelOverride = channel === 'mirror' ? 'mirror' : 'github'
}

const MIRROR_PREFIX = 'https://gh-proxy.com/'

async function fetchText(url: string, proxyPort: number | null, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(
      url,
      timeoutMs,
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          if (body.length < 4_000_000) body += c
        })
        res.on('end', () => resolve(body))
        res.on('error', reject)
      },
      {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
        // metadata goes through the tunnel too: the GitHub API is just as unreachable
        proxyPort
      }
    )
    req.on('error', reject)
    req.end()
  })
}

async function githubRelease(owner: string, repo: string, proxyPort: number | null): Promise<GithubRelease | null> {
  try {
    return JSON.parse(
      await fetchText(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, proxyPort)
    ) as GithubRelease
  } catch {
    return null
  }
}

/** Tag as reported by jsDelivr, used when the GitHub API is unreachable. */
async function jsdelivrTag(owner: string, repo: string, proxyPort: number | null): Promise<string | null> {
  try {
    const raw = await fetchText(`https://data.jsdelivr.com/v1/packages/gh/${owner}/${repo}?structure=flat`, proxyPort)
    const data = JSON.parse(raw) as { versions?: { version: string }[] }
    const first = data.versions?.[0]
    return first ? `v${first.version.replace(/^v/, '')}` : null
  } catch {
    return null
  }
}

function isPrerelease(tag: string): boolean {
  return /-(alpha|beta|rc|dev)/i.test(tag)
}

/** Rebuilds an asset URL from the known release naming when the API has none. */
function fallbackAssetUrl(engine: CoreId, version: string): string | null {
  const numeric = version.replace(/^v/, '').split('-')[0]
  switch (engine) {
    case 'xray':
      return `https://github.com/XTLS/Xray-core/releases/download/v${numeric}/Xray-windows-64.zip`
    case 'singbox':
      return `https://github.com/SagerNet/sing-box/releases/download/v${numeric}/sing-box-${numeric}-windows-amd64.zip`
    case 'mihomo':
      return `https://github.com/MetaCubeX/mihomo/releases/download/v${numeric}/mihomo-windows-amd64-v${numeric}.zip`
    default:
      return null
  }
}

function viaChannel(url: string, channel: DownloadChannel): string {
  return channel === 'mirror' ? `${MIRROR_PREFIX}${url}` : url
}

function updateWorkDir(kind: string): string {
  const dir = join(app.getPath('userData'), 'updates', kind)
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface DownloadOptions {
  /** mixed port to tunnel through, or null for a direct route */
  proxyPort: number | null
}

/** Downloads to a file and refuses to report success on a short read. */
export function downloadTo(
  url: string,
  target: string,
  onProgress: (got: number, total: number) => void,
  options: DownloadOptions,
  timeoutMs = 600_000
): Promise<void> {
  return (async () => {
    const proxyPort = options.proxyPort
    return new Promise<void>((resolve, reject) => {
      const go = (current: string, redirects: number): void => {
        if (redirects > 6) return reject(new Error('重定向过多'))
        const req = httpsGet(
          current,
          timeoutMs,
          (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              res.resume()
              go(new URL(res.headers.location, current).toString(), redirects + 1)
              return
            }
            if (res.statusCode !== 200) {
              res.resume()
              reject(new Error(`HTTP ${res.statusCode}`))
              return
            }
            const total = Number(res.headers['content-length'] ?? 0)
            let got = 0
            let settled = false
            const out = createWriteStream(target)
            const fail = (err: Error): void => {
              if (settled) return
              settled = true
              clearTimeout(idle)
              out.destroy()
              rmSync(target, { force: true })
              reject(err)
            }
            let idle = setTimeout(() => req.destroy(new Error('下载停滞，请尝试切换为国内镜像站')), 60_000)
            res.on('data', (c: Buffer) => {
              clearTimeout(idle)
              idle = setTimeout(() => req.destroy(new Error('下载停滞，请尝试切换为国内镜像站')), 60_000)
              got += c.length
              onProgress(got, total)
            })
            res.on('error', (e) => fail(e))
            res.pipe(out)
            out.on('error', (e) => fail(e))
            out.on('finish', () => {
              clearTimeout(idle)
              out.close(() => {
                if (settled) return
                if (total > 0 && got < total) {
                  settled = true
                  rmSync(target, { force: true })
                  reject(new Error(`下载不完整（${Math.round((got / total) * 100)}%），请重试或切换下载渠道`))
                  return
                }
                settled = true
                resolve()
              })
            })
          },
          { proxyPort }
        )
        req.on('error', (e) => reject(e))
        req.end()
      }
      go(url, 0)
    })
  })()
}

/** SHA-256 of a file, lowercase hex. */
export function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const rs = createReadStream(path)
    rs.on('data', (c) => hash.update(c))
    rs.on('end', () => resolve(hash.digest('hex')))
    rs.on('error', reject)
  })
}

/** Version check for all three cores. */
export async function checkCoreUpdates(proxyPort: number | null = null): Promise<CoreUpdateInfo[]> {
  const channel = channelOverride
  const out: CoreUpdateInfo[] = []
  for (const engine of ENGINE_KEYS) {
    const meta = CORE_REPOS[engine]
    const local = await currentCoreVersion(engine)
    let latest: string | null = null
    let asset: { name: string; url: string; digest?: string | null } | null = null

    const rel = await githubRelease(meta.owner, meta.repo, proxyPort)
    if (rel?.tag_name && !isPrerelease(rel.tag_name)) {
      latest = rel.tag_name.replace(/^v/, '')
      const hit = rel.assets?.find((a) => meta.asset.test(a.name))
      if (hit) asset = { name: hit.name, url: hit.browser_download_url, digest: hit.digest ?? null }
    }
    if (!latest) {
      const tag = await jsdelivrTag(meta.owner, meta.repo, proxyPort)
      if (tag && !isPrerelease(tag)) latest = tag.replace(/^v/, '')
    }
    if (!asset?.url && latest) {
      const url = fallbackAssetUrl(engine, latest)
      if (url) asset = { name: `${meta.label}-${latest}.zip`, url }
    }

    const missing = local === null
    out.push({
      engine,
      label: meta.label,
      local,
      latest,
      missing,
      updateAvailable: Boolean(latest) && (missing || compareVersions(latest!, local!) > 0),
      channel,
      assetUrl: asset?.url ?? null,
      assetSha256: asset?.digest ? asset.digest.replace(/^sha256:/i, '') : null,
      error: latest ? null : '无法获取版本信息'
    })
  }
  return out
}

export interface StageOneResult {
  staged: StagedCore
}

/**
 * Downloads, verifies and stages one core.
 *
 * The proxy is never stopped: nothing here touches a live binary, and the swap happens on
 * the next launch from applyStagedCores().
 */
export async function stageCoreUpdate(
  engine: CoreId,
  onProgress: (percent: number) => void,
  proxyPort: number | null
): Promise<StageOneResult> {
  const list = await checkCoreUpdates(proxyPort)
  const info = list.find((c) => c.engine === engine)
  if (!info) throw new Error('未找到内核信息')
  if (!info.updateAvailable && !info.missing) throw new Error('该内核已是最新版本')
  if (!info.assetUrl || !info.latest) throw new Error(info.error ?? '没有可用的下载地址')

  const options: StageOptions = {
    engine,
    version: info.latest,
    url: viaChannel(info.assetUrl, info.channel),
    expectedSha256: info.assetSha256,
    onProgress,
    download: (url, target, progress) => downloadTo(url, target, progress, { proxyPort })
  }
  return { staged: await stageCore(options) }
}

/** Reads/clears the staging area. */
export { readStagedCores, writeStagedCores }
export { hasStagedCores, applyStagedCores } from './coreStage'
export type { StagedCore }

/** True when this engine's exe is present. */
export function coreAvailable(engine: CoreId): boolean {
  return findCore(engine) !== null
}

export { invalidateCoreVersion, statSync, existsSync, readFileSync, unlink }
