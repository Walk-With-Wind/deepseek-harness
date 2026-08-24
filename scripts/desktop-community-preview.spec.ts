import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_APPLICATION_ID,
  DESKTOP_DISTRIBUTION,
  DESKTOP_PUBLISHER,
  DESKTOP_REPOSITORY,
  DESKTOP_UPDATE_BASE_URL,
} from '../apps/desktop/src/shared/release-policy.ts'
import * as publicationModule from './lib/desktop-community-publish.ts'

const sourceCommit = 'a'.repeat(40)
const version = '0.1.0-rc.8'
const roots: string[] = []

interface PreviewAcceptanceOptions {
  readonly target: 'darwin-arm64' | 'darwin-x64' | 'win32-x64'
  readonly version: string
  readonly sourceCommit: string
  readonly signature: 'ad-hoc' | 'unsigned'
}

interface PreviewPlan {
  readonly release: {
    readonly formatVersion: 1
    readonly kind: 'unsigned-preview'
    readonly version: string
    readonly sourceCommit: string
    readonly autoUpdates: false
    readonly targets: readonly string[]
    readonly assets: ReadonlyArray<{
      readonly name: string
      readonly target: string
      readonly role: string
      readonly size: number
      readonly sha256: string
    }>
  }
  readonly releaseFiles: readonly { readonly name: string; readonly sourcePath: string }[]
}

type PreviewPublicationModule = typeof publicationModule & {
  createDesktopPreviewAcceptance?: (options: PreviewAcceptanceOptions) => Record<string, unknown>
  buildDesktopCommunityPreviewPlan?: (options: {
    readonly inputRoot: string
    readonly expectedVersion: string
    readonly expectedSourceCommit: string
  }) => Promise<PreviewPlan>
  writeDesktopCommunityPreviewPlan?: (plan: PreviewPlan, outputRoot: string) => Promise<void>
}

const previewPublication = publicationModule as PreviewPublicationModule

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function identity(): Record<string, string> {
  return {
    distribution: DESKTOP_DISTRIBUTION,
    repository: DESKTOP_REPOSITORY,
    applicationId: DESKTOP_APPLICATION_ID,
    publisher: DESKTOP_PUBLISHER,
  }
}

function writeTarget(
  inputRoot: string,
  target: PreviewAcceptanceOptions['target'],
  releaseMode: 'unsigned-preview' | 'signed' = 'unsigned-preview',
  darwinInstallerName = 'DeepSeek Harness Community.dmg',
): void {
  const targetRoot = join(inputRoot, target)
  mkdirSync(targetRoot, { recursive: true })
  const [platform, arch] = target.split('-') as ['darwin' | 'win32', 'arm64' | 'x64']
  const artifacts = platform === 'darwin'
    ? [
      { name: `${target}.zip`, role: 'update-zip', bytes: `zip-${target}` },
      { name: darwinInstallerName, role: 'installer-dmg', bytes: `dmg-${target}` },
    ]
    : [
      { name: 'squirrel.windows/x64/DeepSeek-Harness-Community-Setup.exe', role: 'installer-exe', bytes: 'setup-win32-x64' },
      { name: 'squirrel.windows/x64/DeepSeekHarnessCommunity-0.1.0-rc.8-full.nupkg', role: 'update-nupkg', bytes: 'nupkg-win32-x64' },
      { name: 'squirrel.windows/x64/RELEASES', role: 'update-index', bytes: 'releases-win32-x64' },
    ]
  for (const artifact of artifacts) {
    const path = join(targetRoot, artifact.name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, artifact.bytes)
  }
  const described = artifacts.map(artifact => ({
    name: artifact.name,
    role: artifact.role,
    size: Buffer.byteLength(artifact.bytes),
    sha256: sha256(artifact.bytes),
  }))
  writeFileSync(join(targetRoot, `update-manifest-${target}.json`), JSON.stringify({
    formatVersion: 1,
    ...identity(),
    version,
    sourceCommit,
    sourceDate: '2026-08-22T00:00:00.000Z',
    platform,
    arch,
    channel: 'canary',
    updateBaseUrl: DESKTOP_UPDATE_BASE_URL,
    artifacts: described,
  }))
  writeFileSync(join(targetRoot, 'build-provenance.json'), JSON.stringify({
    formatVersion: 1,
    ...identity(),
    version,
    sourceCommit,
    platform,
    arch,
    build: { releaseMode },
    artifacts: described.map(artifact => ({ path: artifact.name, hash: artifact.sha256 })),
  }))
  writeFileSync(
    join(targetRoot, 'SHA256SUMS'),
    described.map(artifact => `${artifact.sha256}  ${artifact.name}`).join('\n') + '\n',
  )
  writeFileSync(join(targetRoot, 'desktop-sbom.cdx.json'), JSON.stringify({ bomFormat: 'CycloneDX', target }))
  writeFileSync(join(targetRoot, 'THIRD_PARTY_NOTICES.md'), `notices-${target}\n`)
  writeFileSync(join(targetRoot, 'LICENSE'), 'MIT\n')
  writeFileSync(join(targetRoot, 'preview-acceptance.json'), JSON.stringify({
    formatVersion: 1,
    kind: 'community-desktop-unsigned-preview',
    target,
    version,
    sourceCommit,
    releaseMode: 'unsigned-preview',
    autoUpdates: false,
    signed: false,
    signature: platform === 'darwin' ? 'ad-hoc' : 'unsigned',
    signatureVerified: true,
    installerCyclePassed: true,
  }))
}

function setupMatrix(): string {
  const inputRoot = mkdtempSync(join(tmpdir(), 'dsh-desktop-community-preview-'))
  roots.push(inputRoot)
  writeTarget(inputRoot, 'darwin-arm64')
  writeTarget(inputRoot, 'darwin-x64')
  writeTarget(inputRoot, 'win32-x64')
  return inputRoot
}

describe('Community Desktop unsigned preview publication', () => {
  it('生成明确声明更新关闭和平台签名状态的验收记录', () => {
    expect(previewPublication.createDesktopPreviewAcceptance).toBeTypeOf('function')
    const acceptance = previewPublication.createDesktopPreviewAcceptance({
      target: 'darwin-arm64', version, sourceCommit, signature: 'ad-hoc',
    })
    expect(acceptance).toEqual({
      formatVersion: 1,
      kind: 'community-desktop-unsigned-preview',
      target: 'darwin-arm64',
      version,
      sourceCommit,
      releaseMode: 'unsigned-preview',
      autoUpdates: false,
      signed: false,
      signature: 'ad-hoc',
      signatureVerified: true,
      installerCyclePassed: true,
    })
  })

  it('只把三平台安装器和审计材料放入独立 Preview Release', async () => {
    expect(previewPublication.buildDesktopCommunityPreviewPlan).toBeTypeOf('function')
    const inputRoot = setupMatrix()
    const plan = await previewPublication.buildDesktopCommunityPreviewPlan({
      inputRoot, expectedVersion: version, expectedSourceCommit: sourceCommit,
    })

    expect(plan.release).toMatchObject({
      formatVersion: 1,
      kind: 'unsigned-preview',
      version,
      sourceCommit,
      autoUpdates: false,
      targets: ['darwin-arm64', 'darwin-x64', 'win32-x64'],
    })
    expect(plan.release.assets.filter(asset => asset.role.startsWith('installer-'))).toHaveLength(3)
    expect(plan.release.assets.map(asset => asset.role)).not.toContain('update-zip')
    expect(plan.release.assets.map(asset => asset.role)).not.toContain('update-nupkg')
    expect(plan.release.assets.map(asset => asset.role)).not.toContain('update-index')
    expect(plan.releaseFiles.map(file => file.name).join('\n')).not.toMatch(/\.zip$|\.nupkg$|RELEASES$/m)
    expect(plan.releaseFiles.map(file => file.name)).toEqual(expect.arrayContaining([
      'darwin-arm64--DeepSeek-Harness-Community.dmg',
      'darwin-x64--DeepSeek-Harness-Community.dmg',
    ]))
    expect(plan.releaseFiles.every(file => /^[A-Za-z0-9._-]+$/.test(file.name))).toBe(true)

    expect(previewPublication.writeDesktopCommunityPreviewPlan).toBeTypeOf('function')
    const outputRoot = mkdtempSync(join(tmpdir(), 'dsh-desktop-community-preview-output-'))
    roots.push(outputRoot)
    await previewPublication.writeDesktopCommunityPreviewPlan(plan, outputRoot)
    const releaseRoot = join(outputRoot, 'release')
    expect(existsSync(join(outputRoot, 'pages'))).toBe(false)
    expect(readdirSync(releaseRoot)).toContain('desktop-community-preview-manifest.json')
    expect(readdirSync(releaseRoot)).toContain('SHA256SUMS')
    expect(JSON.parse(readFileSync(join(releaseRoot, 'desktop-community-preview-manifest.json'), 'utf8')))
      .toEqual(plan.release)
  })

  it('拒绝签名构建冒充 unsigned preview 候选', async () => {
    expect(previewPublication.buildDesktopCommunityPreviewPlan).toBeTypeOf('function')
    const inputRoot = setupMatrix()
    rmSync(join(inputRoot, 'darwin-arm64'), { recursive: true, force: true })
    writeTarget(inputRoot, 'darwin-arm64', 'signed')

    await expect(previewPublication.buildDesktopCommunityPreviewPlan({
      inputRoot, expectedVersion: version, expectedSourceCommit: sourceCommit,
    })).rejects.toThrow(/unsigned-preview/)
  })

  it('拒绝候选路径规范化后形成重复 Release 资产名', async () => {
    expect(previewPublication.buildDesktopCommunityPreviewPlan).toBeTypeOf('function')
    const inputRoot = setupMatrix()
    rmSync(join(inputRoot, 'darwin-arm64'), { recursive: true, force: true })
    writeTarget(inputRoot, 'darwin-arm64', 'unsigned-preview', 'desktop sbom.cdx.json')

    await expect(previewPublication.buildDesktopCommunityPreviewPlan({
      inputRoot, expectedVersion: version, expectedSourceCommit: sourceCommit,
    })).rejects.toThrow(/Release 资产名冲突/)
  })
})
