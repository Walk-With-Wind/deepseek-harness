/** 从当前平台 maker 字节生成离线可审查的更新元数据。 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import {
  DESKTOP_APPLICATION_ID,
  DESKTOP_UPDATE_ORIGIN,
} from '../../apps/desktop/src/shared/release-policy.ts'

export interface DesktopUpdateMetadataOptions {
  readonly artifactRoot: string
  readonly platform: 'darwin' | 'win32' | 'linux'
  readonly arch: 'arm64' | 'x64'
  readonly version: string
  readonly sourceCommit: string
  readonly sourceDate: string
}

interface UpdateArtifact {
  readonly name: string
  readonly role: string
  readonly size: number
  readonly sha256: string
}

/** 生成平台 manifest；macOS 额外生成 Squirrel.Mac JSON feed。 */
export async function generateDesktopUpdateMetadata(options: DesktopUpdateMetadataOptions): Promise<string> {
  const channel = releaseChannel(options.version)
  if (!/^[a-f0-9]{40}$/.test(options.sourceCommit)) throw new Error('desktop-update: source commit 无效')
  if (!Number.isFinite(Date.parse(options.sourceDate))) throw new Error('desktop-update: source date 无效')
  const candidates = await regularFiles(options.artifactRoot)
  const selected = selectArtifacts(options.platform, candidates)
  const artifacts: UpdateArtifact[] = []
  for (const { path, role } of selected) {
    const bytes = await readFile(path)
    artifacts.push({
      name: relative(options.artifactRoot, path).split(sep).join('/'),
      role,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    })
  }
  artifacts.sort((left, right) => left.name.localeCompare(right.name))
  const manifestPath = join(options.artifactRoot, `update-manifest-${options.platform}-${options.arch}.json`)
  const manifest = {
    formatVersion: 1,
    applicationId: DESKTOP_APPLICATION_ID,
    version: options.version,
    channel,
    platform: options.platform,
    arch: options.arch,
    sourceCommit: options.sourceCommit,
    sourceDate: options.sourceDate,
    updateOrigin: DESKTOP_UPDATE_ORIGIN,
    artifacts,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  if (options.platform === 'darwin') {
    const zip = artifacts.find(artifact => artifact.role === 'update-zip')!
    const fileName = basename(zip.name)
    const url = `${DESKTOP_UPDATE_ORIGIN}/harness/releases/${options.version}/darwin-${options.arch}/${encodeURIComponent(fileName)}`
    await writeFile(join(options.artifactRoot, `releases-darwin-${options.arch}.json`), `${JSON.stringify({
      url,
      name: options.version,
      notes: `DeepSeek Harness ${options.version}`,
      pub_date: new Date(options.sourceDate).toISOString(),
    }, null, 2)}\n`)
  }
  return manifestPath
}

/** 校验 manifest 中记录的身份、路径、字节和平台角色。 */
export async function verifyDesktopUpdateMetadata(options: DesktopUpdateMetadataOptions): Promise<void> {
  const path = join(options.artifactRoot, `update-manifest-${options.platform}-${options.arch}.json`)
  const before = await readFile(path)
  const feedPath = join(options.artifactRoot, `releases-darwin-${options.arch}.json`)
  const feedBefore = options.platform === 'darwin' ? await readFile(feedPath) : undefined
  try {
    await generateDesktopUpdateMetadata(options)
    const after = await readFile(path)
    const feedAfter = options.platform === 'darwin' ? await readFile(feedPath) : undefined
    if (!before.equals(after) || (feedBefore !== undefined && !feedBefore.equals(feedAfter!))) {
      throw new Error('desktop-update: 更新 manifest 与当前 maker 字节不一致')
    }
  } finally {
    await writeFile(path, before)
    if (feedBefore !== undefined) await writeFile(feedPath, feedBefore)
  }
}

function selectArtifacts(
  platform: DesktopUpdateMetadataOptions['platform'],
  files: readonly string[],
): Array<{ path: string; role: string }> {
  if (platform === 'darwin') {
    const zip = files.filter(path => path.endsWith('.zip'))
    const dmg = files.filter(path => path.endsWith('.dmg'))
    if (zip.length !== 1 || dmg.length !== 1) throw new Error('desktop-update: macOS 必须恰有一个 ZIP 和一个 DMG')
    return [{ path: zip[0]!, role: 'update-zip' }, { path: dmg[0]!, role: 'installer-dmg' }]
  }
  if (platform === 'win32') {
    const setup = files.filter(path => /Setup\.exe$/i.test(path))
    const nupkg = files.filter(path => path.endsWith('.nupkg'))
    const releases = files.filter(path => basename(path) === 'RELEASES')
    if (setup.length !== 1 || nupkg.length === 0 || releases.length !== 1) {
      throw new Error('desktop-update: Windows 必须包含 Setup.exe、nupkg 和 RELEASES')
    }
    return [
      { path: setup[0]!, role: 'installer-exe' },
      ...nupkg.map(path => ({ path, role: 'update-nupkg' })),
      { path: releases[0]!, role: 'update-index' },
    ]
  }
  const deb = files.filter(path => path.endsWith('.deb'))
  const rpm = files.filter(path => path.endsWith('.rpm'))
  if (deb.length !== 1 || rpm.length !== 1) throw new Error('desktop-update: Linux 必须恰有一个 deb 和一个 rpm')
  return [{ path: deb[0]!, role: 'installer-deb' }, { path: rpm[0]!, role: 'installer-rpm' }]
}

async function regularFiles(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return []
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await regularFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files.filter(path => !basename(path).startsWith('update-manifest-')
    && !basename(path).startsWith('releases-darwin-'))
}

function releaseChannel(version: string): 'stable' | 'canary' {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('desktop-update: 版本不是语义版本')
  return version.includes('-') ? 'canary' : 'stable'
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
