/** 从最终 Desktop staging 与 maker 字节生成可重复验证的发行材料。 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly license?: unknown
  readonly repository?: unknown
  readonly homepage?: unknown
}

export interface StagedPackage {
  readonly name: string
  readonly version: string
  readonly license: string
  readonly repository?: string
  readonly contentSha256: string
  readonly legalFiles: readonly PackageLegalFile[]
}

/** 随第三方包发布的许可证或 NOTICE 文件。 */
interface PackageLegalFile {
  readonly name: string
  readonly sha256: string
  readonly text: string
}

interface AuditedLegalSource {
  readonly kind: 'asset' | 'package'
  readonly path: string
  readonly sha256: string
}

interface AuditedLegalOverride {
  readonly license: string
  readonly sources: readonly AuditedLegalSource[]
}

const LEGAL_ASSETS = {
  apache: { kind: 'asset', path: 'Apache-2.0.txt', sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
  gpl: { kind: 'asset', path: 'GPL-3.0.txt', sha256: '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986' },
  lgpl: { kind: 'asset', path: 'LGPL-3.0.txt', sha256: 'e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118' },
  amit: { kind: 'asset', path: 'MIT-Amit-Gupta.txt', sha256: '0b48edd88329c9e353b1fc17ad6696071a77eadca445f4813b7b645cd2fb437c' },
  mario: { kind: 'asset', path: 'MIT-Mario-Zechner.txt', sha256: '4f6a1985796db5225e3b1e59972bd47e07a27a0748427cb3d3c8fbf39f9311f0' },
  nathan: { kind: 'asset', path: 'MIT-Nathan-Rajlich.txt', sha256: '1915735866a7729128309d7038564aa432c4ec0f7105f3d3e2bf1597d0d1330f' },
  niels: { kind: 'asset', path: 'MIT-Niels-Martignene.txt', sha256: '8e13a05a5399f37e92379f200766dba8eb075b77600277e2fc1839cc9e85a1ac' },
} as const satisfies Record<string, AuditedLegalSource>

const SHARP_LIBVIPS_READMES = {
  '@img/sharp-libvips-darwin-arm64@1.3.2': '47083f1ae7e990f74a56f576bcb8434051cb84ed1982fa57932720869e5147fe',
  '@img/sharp-libvips-darwin-x64@1.3.2': 'bbb84e1fa86b44508e893afe1a84a640cd452c0e671f001256959352bfacb7e5',
} as const

const AUDITED_LEGAL_OVERRIDES = new Map<string, AuditedLegalOverride>([
  ['@aws-sdk/credential-provider-http@3.972.48', { license: 'Apache-2.0', sources: [LEGAL_ASSETS.apache] }],
  ['@aws-sdk/credential-provider-login@3.972.52', { license: 'Apache-2.0', sources: [LEGAL_ASSETS.apache] }],
  ['@aws-sdk/nested-clients@3.997.20', { license: 'Apache-2.0', sources: [LEGAL_ASSETS.apache] }],
  ['@earendil-works/pi-ai@0.82.1', { license: 'MIT', sources: [LEGAL_ASSETS.mario] }],
  ['@koromix/koffi-darwin-arm64@3.1.1', { license: 'MIT', sources: [LEGAL_ASSETS.niels] }],
  ['@koromix/koffi-darwin-x64@3.1.1', { license: 'MIT', sources: [LEGAL_ASSETS.niels] }],
  ['@koromix/koffi-win32-x64@3.1.1', { license: 'MIT', sources: [LEGAL_ASSETS.niels] }],
  ['@nodable/entities@2.2.0', { license: 'MIT', sources: [LEGAL_ASSETS.amit] }],
  ['data-uri-to-buffer@4.0.1', { license: 'MIT', sources: [LEGAL_ASSETS.nathan] }],
  ['xml-naming@0.1.0', { license: 'MIT', sources: [LEGAL_ASSETS.amit] }],
  ...Object.entries(SHARP_LIBVIPS_READMES).map(([identity, sha256]) => [
    identity,
    {
      license: 'LGPL-3.0-or-later',
      sources: [
        { kind: 'package', path: 'README.md', sha256 },
        LEGAL_ASSETS.gpl,
        LEGAL_ASSETS.lgpl,
      ],
    },
  ] as const),
])

export interface DesktopReleaseMaterialOptions {
  readonly root: string
  readonly staging: string
  readonly artifactRoot: string
  readonly outputRoot: string
}

const MATERIAL_NAMES = new Set([
  'SHA256SUMS',
  'desktop-sbom.cdx.json',
  'THIRD_PARTY_NOTICES.md',
  'LICENSE',
  'build-provenance.json',
])

/** 读取 production closure 各级 node_modules 中的每个 npm 包身份。 */
export async function collectStagedPackages(staging: string): Promise<StagedPackage[]> {
  const nodeModules = join(staging, 'node_modules')
  const roots = await collectDependencyRoots(nodeModules)
  const packages = new Map<string, StagedPackage>()
  for (const directory of roots) {
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const bytes = await readFile(manifestPath)
    const manifest = JSON.parse(bytes.toString('utf8')) as PackageManifest
    if (typeof manifest.name !== 'string' || manifest.name === ''
      || typeof manifest.version !== 'string' || manifest.version === '') {
      throw new Error(`desktop-materials: 无效包 manifest ${relative(staging, manifestPath)}`)
    }
    const license = normalizeLicense(manifest.license)
    const identity = `${manifest.name}@${manifest.version}`
    const contentSha256 = await directoryDigest(
      directory,
      path => !path.startsWith(`${join(directory, 'node_modules')}${sep}`),
    )
    const packageLegalFiles = await collectPackageLegalFiles(directory)
    const legalFiles = packageLegalFiles.length > 0 || manifest.name.startsWith('@deepseek-ai/')
      ? packageLegalFiles
      : await loadAuditedLegalOverride(staging, directory, identity, license)
    const pkg: StagedPackage = {
      name: manifest.name,
      version: manifest.version,
      license,
      ...repositoryField(manifest),
      contentSha256,
      legalFiles,
    }
    const existing = packages.get(identity)
    if (existing !== undefined && existing.contentSha256 !== pkg.contentSha256) {
      throw new Error(`desktop-materials: staging 重复包身份内容不一致 ${identity}`)
    }
    if (existing === undefined) packages.set(identity, pkg)
  }
  if (packages.size < 10) throw new Error(`desktop-materials: staging 只发现 ${String(packages.size)} 个包`)
  return [...packages.values()]
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))
}

async function loadAuditedLegalOverride(
  staging: string,
  packageDirectory: string,
  identity: string,
  license: string,
): Promise<PackageLegalFile[]> {
  const override = AUDITED_LEGAL_OVERRIDES.get(identity)
  if (override === undefined) {
    throw new Error(`desktop-materials: ${identity} 缺少已审计许可证正文`)
  }
  if (override.license !== license) {
    throw new Error(`desktop-materials: ${identity} 许可证表达式与审计记录不一致`)
  }
  return Promise.all(override.sources.map(async (source) => {
    const path = source.kind === 'asset'
      ? join(staging, 'licenses', 'npm-overrides', source.path)
      : join(packageDirectory, source.path)
    const bytes = await readFile(path)
    const actual = sha256(bytes)
    if (actual !== source.sha256) {
      throw new Error(`desktop-materials: ${identity} 审计许可证正文哈希不一致 ${source.path}`)
    }
    if (bytes.includes(0)) throw new Error(`desktop-materials: 许可证文件不是 UTF-8 文本 ${source.path}`)
    return {
      name: `AUDITED-${source.path.replaceAll('/', '-')}`,
      sha256: actual,
      text: bytes.toString('utf8'),
    }
  }))
}

async function collectPackageLegalFiles(directory: string): Promise<PackageLegalFile[]> {
  const files: PackageLegalFile[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(?:licen[cs]es?|copying|notice)(?:[._-].*)?$/i.test(entry.name)) continue
    const bytes = await readFile(join(directory, entry.name))
    if (bytes.includes(0)) throw new Error(`desktop-materials: 许可证文件不是 UTF-8 文本 ${entry.name}`)
    files.push({ name: entry.name, sha256: sha256(bytes), text: bytes.toString('utf8') })
  }
  return files.sort((left, right) => left.name.localeCompare(right.name))
}

async function collectElectronLegalFiles(staging: string): Promise<PackageLegalFile[]> {
  const files = await collectPackageLegalFiles(join(staging, 'licenses', 'electron'))
  const names = files.map(file => file.name)
  if (!names.includes('LICENSE') || !names.includes('LICENSES.chromium.html')) {
    throw new Error('desktop-materials: staging 缺少 Electron/Chromium 许可证材料')
  }
  return files
}

async function collectDependencyRoots(nodeModules: string): Promise<string[]> {
  const roots: string[] = []
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      for (const child of await readdir(join(nodeModules, entry.name), { withFileTypes: true })) {
        if (child.isDirectory()) roots.push(join(nodeModules, entry.name, child.name))
      }
    } else {
      roots.push(join(nodeModules, entry.name))
    }
  }
  const nested = await Promise.all(roots.map(async (root) => {
    const dependencies = join(root, 'node_modules')
    return existsSync(dependencies) ? collectDependencyRoots(dependencies) : []
  }))
  return [...roots, ...nested.flat()].sort()
}

/** 生成 SBOM、notices、许可证、哈希和构建证明。 */
export async function generateDesktopReleaseMaterials(options: DesktopReleaseMaterialOptions): Promise<void> {
  const staging = resolve(options.staging)
  const artifactRoot = resolve(options.artifactRoot)
  const outputRoot = resolve(options.outputRoot)
  if (!existsSync(join(staging, 'build-info.json'))) throw new Error('desktop-materials: staging 缺少 build-info.json')
  if (!existsSync(artifactRoot)) throw new Error(`desktop-materials: maker 产物目录不存在 ${artifactRoot}`)
  await mkdir(outputRoot, { recursive: true })
  const buildInfo = JSON.parse(await readFile(join(staging, 'build-info.json'), 'utf8')) as Record<string, unknown>
  const appManifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8')) as PackageManifest
  const packages = await collectStagedPackages(staging)
  const electronLegalFiles = await collectElectronLegalFiles(staging)
  const closureDigest = await directoryDigest(staging, path => !path.endsWith(`${sep}forge.config.ts`))
  const nestedOutput = outputRoot !== artifactRoot && outputRoot.startsWith(`${artifactRoot}${sep}`)
  const artifacts = await collectRegularFiles(artifactRoot, path => {
    return !MATERIAL_NAMES.has(basename(path)) && (!nestedOutput || !path.startsWith(`${outputRoot}${sep}`))
  })
  if (artifacts.length === 0) throw new Error('desktop-materials: maker 目录没有安装器或更新产物')
  const hashes = await Promise.all(artifacts.map(async (path) => {
    return { path: relative(artifactRoot, path).split(sep).join('/'), hash: sha256(await readFile(path)) }
  }))
  hashes.sort((left, right) => left.path.localeCompare(right.path))

  const sbom = renderCycloneDx(appManifest, buildInfo, packages, closureDigest)
  const notices = renderDesktopNotices(
    packages,
    electronLegalFiles,
    String(buildInfo.electronVersion ?? 'unknown'),
  )
  const provenance = {
    formatVersion: 1,
    build: buildInfo,
    stagingSha256: closureDigest,
    packageCount: packages.length,
    artifactCount: hashes.length,
    artifacts: hashes,
  }
  await Promise.all([
    writeFile(join(outputRoot, 'desktop-sbom.cdx.json'), jsonText(sbom)),
    writeFile(join(outputRoot, 'THIRD_PARTY_NOTICES.md'), notices),
    writeFile(join(outputRoot, 'LICENSE'), await readFile(join(options.root, 'LICENSE'))),
    writeFile(join(outputRoot, 'build-provenance.json'), jsonText(provenance)),
    writeFile(join(outputRoot, 'SHA256SUMS'), hashes.map(value => `${value.hash}  ${value.path}`).join('\n') + '\n'),
  ])
}

/** 重新派生材料并逐字验证，防止手工改写或 staging 漂移。 */
export async function verifyDesktopReleaseMaterials(options: DesktopReleaseMaterialOptions): Promise<void> {
  const temporary = join(options.outputRoot, '.verify')
  await generateDesktopReleaseMaterials({ ...options, outputRoot: temporary })
  try {
    for (const name of MATERIAL_NAMES) {
      const expected = await readFile(join(temporary, name))
      const actual = await readFile(join(options.outputRoot, name))
      if (!expected.equals(actual)) throw new Error(`desktop-materials: ${name} 与最终 staging/产物不一致`)
    }
  } finally {
    const { rm } = await import('node:fs/promises')
    await rm(temporary, { recursive: true, force: true })
  }
}

function renderCycloneDx(
  appManifest: PackageManifest,
  buildInfo: Record<string, unknown>,
  packages: readonly StagedPackage[],
  closureDigest: string,
): Record<string, unknown> {
  if (typeof appManifest.name !== 'string' || typeof appManifest.version !== 'string') {
    throw new Error('desktop-materials: 应用 manifest 缺少名称或版本')
  }
  const components = packages.map(pkg => ({
    type: 'library',
    'bom-ref': purl(pkg.name, pkg.version),
    name: pkg.name,
    version: pkg.version,
    hashes: [{ alg: 'SHA-256', content: pkg.contentSha256 }],
    licenses: [{ expression: pkg.license }],
    ...(pkg.repository === undefined ? {} : { externalReferences: [{ type: 'vcs', url: pkg.repository }] }),
    purl: purl(pkg.name, pkg.version),
  }))
  if (typeof buildInfo.electronVersion === 'string') {
    components.push({
      type: 'framework', 'bom-ref': purl('electron', buildInfo.electronVersion),
      name: 'electron', version: buildInfo.electronVersion,
      hashes: [], licenses: [{ expression: 'MIT' }], purl: purl('electron', buildInfo.electronVersion),
    })
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: uuidFromDigest(closureDigest),
    version: 1,
    metadata: {
      component: {
        type: 'application', name: appManifest.name, version: appManifest.version,
        'bom-ref': purl(appManifest.name, appManifest.version),
      },
      properties: [
        { name: 'ai.deepseek.harness:sourceCommit', value: String(buildInfo.sourceCommit ?? 'unknown') },
        { name: 'ai.deepseek.harness:stagingSha256', value: closureDigest },
        { name: 'ai.deepseek.harness:platform', value: String(buildInfo.platform ?? 'unknown') },
        { name: 'ai.deepseek.harness:arch', value: String(buildInfo.arch ?? 'unknown') },
      ],
    },
    components,
  }
}

function renderDesktopNotices(
  packages: readonly StagedPackage[],
  electronLegalFiles: readonly PackageLegalFile[],
  electronVersion: string,
): string {
  const external = packages.filter(pkg => !pkg.name.startsWith('@deepseek-ai/'))
  const lines = [
    '# DeepSeek Harness Desktop 第三方软件声明',
    '',
    '本文件由最终 Desktop production staging 自动生成。各项目继续受其自身许可证约束。',
    '',
    '| 包 | 版本 | 许可证 |',
    '| --- | --- | --- |',
    ...external.map(pkg => `| \`${pkg.name}\` | \`${pkg.version}\` | ${pkg.license.replaceAll('|', '\\|')} |`),
    '',
  ]
  for (const pkg of external) {
    lines.push(`## ${pkg.name}@${pkg.version}`, '', `许可证表达式：\`${pkg.license}\``)
    if (pkg.repository !== undefined) lines.push('', `上游来源：${pkg.repository}`)
    appendLegalNotices(lines, pkg.legalFiles)
    lines.push('')
  }
  lines.push(`## Electron runtime ${electronVersion}`, '', '该运行时包含 Electron、Chromium 及其上游第三方组件。')
  appendLegalNotices(lines, electronLegalFiles)
  lines.push('')
  return lines.join('\n')
}

function appendLegalNotices(lines: string[], legalFiles: readonly PackageLegalFile[]): void {
  for (const legal of legalFiles) {
    lines.push('', `### ${legal.name}`, '', `SHA-256：\`${legal.sha256}\``, '')
    for (const line of legal.text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')) {
      lines.push(`    ${line}`)
    }
  }
}

async function directoryDigest(directory: string, include: (path: string) => boolean): Promise<string> {
  const hash = createHash('sha256')
  const files = await collectRegularFiles(directory, include)
  for (const path of files.sort()) {
    const rel = relative(directory, path).split(sep).join('/')
    hash.update(rel).update('\0').update(await readFile(path)).update('\0')
  }
  return hash.digest('hex')
}

async function collectRegularFiles(directory: string, include: (path: string) => boolean): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectRegularFiles(path, include))
    else if (entry.isFile() && include(path)) files.push(path)
    else if (!entry.isFile() && !entry.isDirectory()) throw new Error(`desktop-materials: 非常规文件 ${path}`)
  }
  return files
}

function normalizeLicense(value: unknown): string {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'object' && value !== null && 'type' in value
    && typeof (value as { type?: unknown }).type === 'string') return (value as { type: string }).type
  throw new Error('desktop-materials: production closure 中存在未声明许可证的包')
}

function repositoryField(manifest: PackageManifest): { repository?: string } {
  const repository = typeof manifest.repository === 'string'
    ? manifest.repository
    : typeof manifest.repository === 'object' && manifest.repository !== null
      && 'url' in manifest.repository && typeof (manifest.repository as { url?: unknown }).url === 'string'
      ? (manifest.repository as { url: string }).url
      : typeof manifest.homepage === 'string' ? manifest.homepage : undefined
  return repository === undefined ? {} : { repository: normalizeRepository(repository) }
}

function normalizeRepository(value: string): string {
  let normalized = value
    .replace(/^(?:git\+)?ssh:\/\/git@/, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) normalized = `https://github.com/${normalized}`
  return normalized
}

function purl(name: string, version: string): string {
  if (name.startsWith('@')) {
    const separator = name.indexOf('/')
    if (separator > 1) {
      return `pkg:npm/${encodeURIComponent(name.slice(0, separator))}/${encodeURIComponent(name.slice(separator + 1))}@${encodeURIComponent(version)}`
    }
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function uuidFromDigest(digest: string): string {
  return `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
