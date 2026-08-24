import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDesktopCommunityPublishPlan,
  createDesktopReleaseAcceptance,
  REQUIRED_DESKTOP_COMMUNITY_TARGETS,
  type DesktopCommunityReleaseManifest,
} from './lib/desktop-community-publish.ts'
import {
  DESKTOP_APPLICATION_ID,
  DESKTOP_DISTRIBUTION,
  DESKTOP_PUBLISHER,
  DESKTOP_REPOSITORY,
  DESKTOP_UPDATE_BASE_URL,
} from '../apps/desktop/src/shared/release-policy.ts'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true })
  }
})

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function readJsonObject(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected a JSON object at ${path}`)
  }
  return value as Record<string, unknown>
}

function candidateRoot(version: string, sourceCommit = 'a'.repeat(40)): string {
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-community-publish-'))
  fixtures.push(fixture)
  for (const target of REQUIRED_DESKTOP_COMMUNITY_TARGETS) {
    const root = join(fixture, target)
    mkdirSync(root, { recursive: true })
    const [platform, arch] = target.split('-') as ['darwin' | 'win32', 'arm64' | 'x64']
    const windowsPackage = `DeepSeekHarnessCommunity-${version}-full.nupkg`
    const artifacts = platform === 'darwin'
      ? [
        { name: `DeepSeek-Harness-Community-${version}-${target}.zip`, role: 'update-zip', bytes: 'zip' },
        { name: 'DeepSeek Harness Community.dmg', role: 'installer-dmg', bytes: 'dmg' },
      ]
      : [
        { name: 'DeepSeek-Harness-Community-Setup.exe', role: 'installer-exe', bytes: 'setup' },
        { name: windowsPackage, role: 'update-nupkg', bytes: 'nupkg' },
        { name: 'RELEASES', role: 'update-index', bytes: `${sha1('nupkg')}  ${windowsPackage} 5\n` },
      ]
    const nestedArtifacts = platform === 'win32'
      ? artifacts.map(artifact => ({ ...artifact, name: `squirrel.windows/x64/${artifact.name}` }))
      : artifacts
    for (const artifact of nestedArtifacts) {
      const path = join(root, artifact.name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, artifact.bytes)
    }
    const manifestArtifacts = nestedArtifacts.map(artifact => ({
      name: artifact.name,
      role: artifact.role,
      size: Buffer.byteLength(artifact.bytes),
      sha256: sha256(artifact.bytes),
    }))
    const channel = version.includes('-') ? 'canary' : 'stable'
    writeJson(join(root, `update-manifest-${target}.json`), {
      formatVersion: 1,
      distribution: DESKTOP_DISTRIBUTION,
      repository: DESKTOP_REPOSITORY,
      publisher: DESKTOP_PUBLISHER,
      applicationId: DESKTOP_APPLICATION_ID,
      version,
      channel,
      platform,
      arch,
      sourceCommit,
      sourceDate: '2026-08-22T00:00:00.000Z',
      updateBaseUrl: DESKTOP_UPDATE_BASE_URL,
      artifacts: manifestArtifacts,
    })
    writeJson(join(root, 'build-provenance.json'), {
      formatVersion: 1,
      distribution: DESKTOP_DISTRIBUTION,
      repository: DESKTOP_REPOSITORY,
      sourceCommit,
      version,
      platform,
      arch,
      applicationId: DESKTOP_APPLICATION_ID,
      publisher: DESKTOP_PUBLISHER,
      build: {
        distribution: DESKTOP_DISTRIBUTION,
        repository: DESKTOP_REPOSITORY,
        sourceCommit,
        version,
        platform,
        arch,
        applicationId: DESKTOP_APPLICATION_ID,
        publisher: DESKTOP_PUBLISHER,
        releaseMode: 'signed',
      },
      stagingSha256: 'b'.repeat(64),
      packageCount: 42,
      artifactCount: manifestArtifacts.length,
      artifacts: manifestArtifacts.map(({ name, sha256: hash }) => ({ path: name, hash })),
    })
    writeFileSync(
      join(root, 'SHA256SUMS'),
      manifestArtifacts.map(artifact => `${artifact.sha256}  ${artifact.name}`).join('\n') + '\n',
    )
    writeJson(join(root, 'desktop-sbom.cdx.json'), { bomFormat: 'CycloneDX', specVersion: '1.6' })
    writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), '# notices\n')
    writeFileSync(join(root, 'LICENSE'), 'MIT\n')
    writeJson(join(root, 'release-acceptance.json'), {
      formatVersion: 1,
      target,
      version,
      sourceCommit,
      signed: true,
      signatureVerified: true,
      installerCyclePassed: true,
      enduranceMinutes: 60,
      installedExportBytes: 1024 ** 3,
    })
  }
  return fixture
}

function stableAcceptance(
  root: string,
  canaryVersion: string,
  canarySourceCommit: string,
  stableVersion: string,
): string {
  const path = join(root, 'stable-promotion-acceptance.json')
  writeJson(path, {
    formatVersion: 1,
    kind: 'community-desktop-stable-promotion',
    canaryVersion,
    canarySourceCommit,
    stableVersion,
    observedAt: '2026-08-23T00:00:00.000Z',
    observationHours: 24,
    reviewer: 'release-owner',
    targets: REQUIRED_DESKTOP_COMMUNITY_TARGETS.map(target => ({
      target,
      cleanInstallPassed: true,
      previousVersionToCanaryPassed: true,
      canaryToStableCandidatePassed: true,
      evidence: `https://github.com/Walk-With-Wind/deepseek-harness/actions/runs/42#${target}`,
    })),
  })
  return path
}

describe('Community Desktop publication plan', () => {
  it('只为已通过签名、安装循环和完整耐久门禁的目标生成验收记录', () => {
    expect(createDesktopReleaseAcceptance({
      target: 'darwin-arm64', version: '1.2.3-rc.1', sourceCommit: 'a'.repeat(40),
      enduranceMinutes: 60, installedExportBytes: 1024 ** 3,
    })).toMatchObject({ signed: true, signatureVerified: true, installerCyclePassed: true })
    expect(() => createDesktopReleaseAcceptance({
      target: 'win32-x64', version: '1.2.3-rc.1', sourceCommit: 'a'.repeat(40),
      enduranceMinutes: 59, installedExportBytes: 1024 ** 3,
    })).toThrow(/60/)
  })

  it('renders one immutable release and a complete canary Pages tree', async () => {
    const inputRoot = candidateRoot('1.2.3-rc.1')
    const plan = await buildDesktopCommunityPublishPlan({ inputRoot, channel: 'canary' })

    expect(plan.release).toMatchObject({
      formatVersion: 2,
      distribution: 'community',
      channel: 'canary',
      version: '1.2.3-rc.1',
      sourceCommit: 'a'.repeat(40),
      targets: [...REQUIRED_DESKTOP_COMMUNITY_TARGETS],
    })
    expect(plan.release.assets.length).toBeGreaterThan(20)
    expect(plan.release.assets.map(asset => asset.name)).toEqual(expect.arrayContaining([
      'darwin-arm64--DeepSeek-Harness-Community.dmg',
      'darwin-x64--DeepSeek-Harness-Community.dmg',
    ]))
    expect(plan.release.assets.every(asset => /^[A-Za-z0-9._-]+$/.test(asset.name))).toBe(true)
    expect(plan.pages.map(file => file.path)).toEqual(expect.arrayContaining([
      'desktop-updates/canary/darwin-arm64/releases.json',
      'desktop-updates/canary/darwin-x64/releases.json',
      'desktop-updates/canary/win32-x64/RELEASES',
    ]))
    expect(plan.pages.map(file => file.path).some(path => path.endsWith('.nupkg'))).toBe(false)
    const releasesPage = plan.pages.find(file => file.path.endsWith('/RELEASES'))
    expect(releasesPage).toBeDefined()
    if (releasesPage === undefined || !('text' in releasesPage)) {
      throw new Error('expected the Windows RELEASES page to contain inline text')
    }
    expect(releasesPage.text).toContain(
      'https://github.com/Walk-With-Wind/deepseek-harness/releases/download/dsh-v1.2.3-rc.1/win32-x64--squirrel.windows--x64--DeepSeekHarnessCommunity-1.2.3-rc.1-full.nupkg',
    )
  })

  it('rejects a partial target matrix and modified candidate bytes', async () => {
    const inputRoot = candidateRoot('1.2.3-rc.1')
    rmSync(join(inputRoot, 'win32-x64'), { recursive: true, force: true })
    await expect(buildDesktopCommunityPublishPlan({ inputRoot, channel: 'canary' }))
      .rejects.toThrow(/win32-x64/)

    const completeRoot = candidateRoot('1.2.3-rc.1')
    writeFileSync(
      join(completeRoot, 'darwin-arm64', 'DeepSeek-Harness-Community-1.2.3-rc.1-darwin-arm64.zip'),
      'tampered',
    )
    await expect(buildDesktopCommunityPublishPlan({ inputRoot: completeRoot, channel: 'canary' }))
      .rejects.toThrow(/SHA-256|hash/)
  })

  it('rejects version or source-commit drift across targets', async () => {
    const inputRoot = candidateRoot('1.2.3-rc.1')
    const path = join(inputRoot, 'darwin-x64', 'build-provenance.json')
    const provenance = readJsonObject(path)
    writeJson(path, { ...provenance, sourceCommit: 'c'.repeat(40) })
    await expect(buildDesktopCommunityPublishPlan({ inputRoot, channel: 'canary' }))
      .rejects.toThrow(/source commit|sourceCommit/)

    const secondRoot = candidateRoot('1.2.3-rc.1')
    const manifestPath = join(secondRoot, 'win32-x64', 'update-manifest-win32-x64.json')
    const manifest = readJsonObject(manifestPath)
    writeJson(manifestPath, { ...manifest, version: '1.2.4-rc.1' })
    await expect(buildDesktopCommunityPublishPlan({ inputRoot: secondRoot, channel: 'canary' }))
      .rejects.toThrow(/版本|version/)
  })

  it('refuses to overwrite an existing Release asset with different bytes', async () => {
    const inputRoot = candidateRoot('1.2.3-rc.1')
    const first = await buildDesktopCommunityPublishPlan({ inputRoot, channel: 'canary' })
    const existing: DesktopCommunityReleaseManifest = {
      ...first.release,
      assets: first.release.assets.map((asset, index) => (
        index === 0 ? { ...asset, sha256: 'f'.repeat(64) } : asset
      )),
    }
    await expect(buildDesktopCommunityPublishPlan({
      inputRoot,
      channel: 'canary',
      existingRelease: existing,
    })).rejects.toThrow(/不可覆盖|字节/)
  })

  it('requires a structured observed-canary record before stable rendering', async () => {
    const stableCommit = 'c'.repeat(40)
    const stableRoot = candidateRoot('1.2.3', stableCommit)
    await expect(buildDesktopCommunityPublishPlan({ inputRoot: stableRoot, channel: 'stable' }))
      .rejects.toThrow(/canary/)

    const canaryCommit = 'a'.repeat(40)
    const canaryRoot = candidateRoot('1.2.3-rc.1', canaryCommit)
    const canary = await buildDesktopCommunityPublishPlan({ inputRoot: canaryRoot, channel: 'canary' })
    const acceptancePath = stableAcceptance(stableRoot, canary.release.version,
      canary.release.sourceCommit, '1.2.3')
    const plan = await buildDesktopCommunityPublishPlan({
      inputRoot: stableRoot,
      channel: 'stable',
      publishedCanary: canary.release,
      stableAcceptancePath: acceptancePath,
      expectedVersion: '1.2.3',
      expectedSourceCommit: stableCommit,
    })
    expect(plan.release).toMatchObject({
      channel: 'stable',
      version: '1.2.3',
      sourceCommit: stableCommit,
      promotion: {
        canaryVersion: '1.2.3-rc.1',
        canarySourceCommit: canaryCommit,
        reviewer: 'release-owner',
      },
    })
    expect(plan.release.assets).toContainEqual(expect.objectContaining({
      name: 'stable-promotion-acceptance.json',
      target: 'release',
      role: 'stable-promotion-acceptance',
    }))
    expect(plan.pages.map(file => file.path)).toEqual(expect.arrayContaining([
      'desktop-updates/stable/darwin-arm64/releases.json',
      'desktop-updates/canary/darwin-arm64/releases.json',
      'desktop-updates/stable/win32-x64/RELEASES',
      'desktop-updates/canary/win32-x64/RELEASES',
    ]))
  })

  it('binds candidates to the expected checkout version and source commit', async () => {
    const inputRoot = candidateRoot('1.2.3-rc.1', 'a'.repeat(40))
    await expect(buildDesktopCommunityPublishPlan({
      inputRoot,
      channel: 'canary',
      expectedVersion: '1.2.4-rc.1',
      expectedSourceCommit: 'a'.repeat(40),
    })).rejects.toThrow(/checkout|期望版本/)
    await expect(buildDesktopCommunityPublishPlan({
      inputRoot,
      channel: 'canary',
      expectedVersion: '1.2.3-rc.1',
      expectedSourceCommit: 'b'.repeat(40),
    })).rejects.toThrow(/checkout|source commit/)
  })
})
