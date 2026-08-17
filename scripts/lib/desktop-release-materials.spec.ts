import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectStagedPackages,
  generateDesktopReleaseMaterials,
  verifyDesktopReleaseMaterials,
} from './desktop-release-materials.ts'

let fixture: string | undefined

afterEach(() => {
  if (fixture !== undefined) rmSync(fixture, { recursive: true, force: true })
  fixture = undefined
})

function setup(): { root: string; staging: string; artifacts: string; output: string } {
  fixture = mkdtempSync(join(tmpdir(), 'dsh-desktop-materials-'))
  const root = fixture
  const staging = join(root, 'staging')
  const artifacts = join(root, 'make')
  const output = join(root, 'materials')
  mkdirSync(join(staging, 'node_modules'), { recursive: true })
  mkdirSync(join(staging, 'licenses', 'electron'), { recursive: true })
  cpSync(
    resolve(import.meta.dirname, '../../apps/desktop/assets/legal'),
    join(staging, 'licenses', 'npm-overrides'),
    { recursive: true },
  )
  mkdirSync(artifacts)
  writeFileSync(join(root, 'LICENSE'), 'MIT\n')
  writeFileSync(join(staging, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '1.2.3' }))
  writeFileSync(join(staging, 'build-info.json'), JSON.stringify({
    version: '1.2.3', sourceCommit: 'a'.repeat(40), sourceDate: '2026-08-16T00:00:00.000Z', electronVersion: '43.2.0',
    nodeVersion: '24.0.0', platform: 'darwin', arch: 'x64',
  }))
  writeFileSync(join(staging, 'licenses', 'electron', 'LICENSE'), 'Electron MIT license\n')
  writeFileSync(join(staging, 'licenses', 'electron', 'LICENSES.chromium.html'), '<html>Chromium notices</html>\n')
  for (let index = 0; index < 10; index += 1) {
    const directory = join(staging, 'node_modules', `dependency-${String(index)}`)
    mkdirSync(directory)
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      name: index === 9 ? '@scope/dependency-9' : `dependency-${String(index)}`,
      version: '1.0.0', license: 'MIT',
      repository: index === 9
        ? 'git@github.com:scope/dependency-9.git'
        : `https://example.com/dependency-${String(index)}`,
    }))
    writeFileSync(join(directory, 'LICENSE'), `MIT license for dependency-${String(index)}\n`)
  }
  writeFileSync(join(artifacts, 'DeepSeek-Harness.dmg'), 'installer-bytes')
  return { root, staging, artifacts, output }
}

describe('Desktop release materials', () => {
  it('从最终 hoisted staging 派生精确包清单', async () => {
    const paths = setup()
    const nested = join(paths.staging, 'node_modules', 'dependency-0', 'node_modules', 'nested-only')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'package.json'), JSON.stringify({
      name: '@scope/nested-only', version: '2.0.0', license: 'Apache-2.0',
      repository: 'git@github.com:scope/nested-only.git',
    }))
    writeFileSync(join(nested, 'NOTICE'), 'nested notice text\n')
    const duplicate = join(paths.staging, 'node_modules', 'dependency-1', 'node_modules', 'dependency-2')
    mkdirSync(duplicate, { recursive: true })
    writeFileSync(
      join(duplicate, 'package.json'),
      readFileSync(join(paths.staging, 'node_modules', 'dependency-2', 'package.json')),
    )
    writeFileSync(join(duplicate, 'LICENSE'), 'MIT license for dependency-2\n')
    const packages = await collectStagedPackages(paths.staging)
    expect(packages).toHaveLength(11)
    expect(packages).toContainEqual(expect.objectContaining({
      name: 'dependency-0', version: '1.0.0', license: 'MIT',
    }))
    expect(packages).toContainEqual(expect.objectContaining({
      name: '@scope/nested-only', version: '2.0.0', license: 'Apache-2.0',
      repository: 'https://github.com/scope/nested-only',
    }))
  })

  it('拒绝内容不一致的重复包身份', async () => {
    const paths = setup()
    const duplicate = join(paths.staging, 'node_modules', 'dependency-1', 'node_modules', 'dependency-2')
    mkdirSync(duplicate, { recursive: true })
    writeFileSync(join(duplicate, 'package.json'), JSON.stringify({
      name: 'dependency-2', version: '1.0.0', license: 'Apache-2.0',
    }))
    writeFileSync(join(duplicate, 'LICENSE'), 'Apache license\n')

    await expect(collectStagedPackages(paths.staging)).rejects.toThrow(/重复包身份内容不一致/)
  })

  it('仅允许精确匹配且正文哈希通过的许可证例外', async () => {
    const paths = setup()
    const directory = join(paths.staging, 'node_modules', 'dependency-8')
    rmSync(join(directory, 'LICENSE'))
    await expect(collectStagedPackages(paths.staging)).rejects.toThrow(/缺少已审计许可证正文/)

    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      name: '@earendil-works/pi-ai', version: '0.82.1', license: 'MIT',
      repository: 'https://github.com/earendil-works/pi',
    }))
    const packages = await collectStagedPackages(paths.staging)
    expect(packages).toContainEqual(expect.objectContaining({
      name: '@earendil-works/pi-ai',
      legalFiles: [expect.objectContaining({ name: 'AUDITED-MIT-Mario-Zechner.txt' })],
    }))

    writeFileSync(
      join(paths.staging, 'licenses', 'npm-overrides', 'MIT-Mario-Zechner.txt'),
      'tampered\n',
    )
    await expect(collectStagedPackages(paths.staging)).rejects.toThrow(/审计许可证正文哈希不一致/)
  })

  it('生成可重验的 SBOM、notices、hash 与 provenance', async () => {
    const paths = setup()
    await generateDesktopReleaseMaterials({
      root: paths.root, staging: paths.staging,
      artifactRoot: paths.artifacts, outputRoot: paths.output,
    })
    const sbom = JSON.parse(readFileSync(join(paths.output, 'desktop-sbom.cdx.json'), 'utf8')) as {
      bomFormat: string; specVersion: string; components: Array<{ purl: string; externalReferences?: Array<{ url: string }> }>
    }
    expect(sbom).toMatchObject({
      bomFormat: 'CycloneDX', specVersion: '1.6',
    })
    expect(sbom.components).toContainEqual(expect.objectContaining({
      purl: 'pkg:npm/%40scope/dependency-9@1.0.0',
      externalReferences: [{ type: 'vcs', url: 'https://github.com/scope/dependency-9' }],
    }))
    const notices = readFileSync(join(paths.output, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    expect(notices).toContain('MIT license for dependency-0')
    expect(notices).toContain('Chromium notices')
    expect(notices).not.toContain('未携带独立 LICENSE/NOTICE')
    expect(readFileSync(join(paths.output, 'SHA256SUMS'), 'utf8')).toMatch(/DeepSeek-Harness\.dmg/)
    await expect(verifyDesktopReleaseMaterials({
      root: paths.root, staging: paths.staging,
      artifactRoot: paths.artifacts, outputRoot: paths.output,
    })).resolves.toBeUndefined()
    writeFileSync(join(paths.artifacts, 'DeepSeek-Harness.dmg'), 'tampered')
    await expect(verifyDesktopReleaseMaterials({
      root: paths.root, staging: paths.staging,
      artifactRoot: paths.artifacts, outputRoot: paths.output,
    })).rejects.toThrow(/不一致/)
  })
})
