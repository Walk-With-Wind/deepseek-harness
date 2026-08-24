/** Validate a complete signed Desktop matrix and render immutable publication inputs. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import {
  DESKTOP_APPLICATION_ID,
  DESKTOP_DISTRIBUTION,
  DESKTOP_PRODUCT_NAME,
  DESKTOP_PUBLISHER,
  DESKTOP_RELEASE_DOWNLOAD_BASE_URL,
  DESKTOP_REPOSITORY,
  DESKTOP_UPDATE_BASE_URL,
  desktopReleaseTag,
} from '../../apps/desktop/src/shared/release-policy.ts'

/** All targets required before any Community Desktop channel can be published. */
export const REQUIRED_DESKTOP_COMMUNITY_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
] as const

/** One required release target. */
export type DesktopCommunityTarget = (typeof REQUIRED_DESKTOP_COMMUNITY_TARGETS)[number]
/** Publication channel; stable always requires prior canary evidence. */
export type DesktopCommunityChannel = 'canary' | 'stable'

/** One immutable GitHub Release asset in the publication manifest. */
export interface DesktopCommunityReleaseAsset {
  readonly name: string
  readonly target: DesktopCommunityTarget | 'release'
  readonly role: string
  readonly size: number
  readonly sha256: string
}

/** Complete, deterministic manifest for one Community Desktop GitHub Release. */
export interface DesktopCommunityReleaseManifest {
  readonly formatVersion: 2
  readonly distribution: typeof DESKTOP_DISTRIBUTION
  readonly repository: typeof DESKTOP_REPOSITORY
  readonly applicationId: typeof DESKTOP_APPLICATION_ID
  readonly publisher: typeof DESKTOP_PUBLISHER
  readonly channel: DesktopCommunityChannel
  readonly version: string
  readonly sourceCommit: string
  readonly targets: readonly DesktopCommunityTarget[]
  readonly assets: readonly DesktopCommunityReleaseAsset[]
  readonly promotion?: {
    readonly canaryVersion: string
    readonly canarySourceCommit: string
    readonly acceptanceRecord: 'stable-promotion-acceptance.json'
    readonly acceptanceSha256: string
    readonly reviewer: string
    readonly observedAt: string
  }
}

/** One generated Pages file, either rendered text or a byte-for-byte candidate copy. */
export type DesktopCommunityPageFile =
  | { readonly path: string; readonly text: string }
  | { readonly path: string; readonly sourcePath: string }

/** Publication plan consumed by the filesystem CLI and protected workflow. */
export interface DesktopCommunityPublishPlan {
  readonly release: DesktopCommunityReleaseManifest
  readonly releaseFiles: readonly { readonly name: string; readonly sourcePath: string }[]
  readonly pages: readonly DesktopCommunityPageFile[]
}

/** Inputs to complete-matrix validation and rendering. */
export interface DesktopCommunityPublishOptions {
  readonly inputRoot: string
  readonly channel: DesktopCommunityChannel
  readonly publishedCanary?: DesktopCommunityReleaseManifest
  readonly existingRelease?: DesktopCommunityReleaseManifest
  readonly stableAcceptancePath?: string
  readonly expectedVersion?: string
  readonly expectedSourceCommit?: string
}

/** Inputs proven by the unsigned native build and installer-cycle jobs. */
export interface DesktopPreviewAcceptanceOptions {
  readonly target: DesktopCommunityTarget
  readonly version: string
  readonly sourceCommit: string
  readonly signature: 'ad-hoc' | 'unsigned'
}

/** Evidence that an unsigned preview cannot enter a signed update channel. */
export interface DesktopPreviewAcceptance extends DesktopPreviewAcceptanceOptions {
  readonly formatVersion: 1
  readonly kind: 'community-desktop-unsigned-preview'
  readonly releaseMode: 'unsigned-preview'
  readonly autoUpdates: false
  readonly signed: false
  readonly signature: 'ad-hoc' | 'unsigned'
  readonly signatureVerified: true
  readonly installerCyclePassed: true
}

/** Immutable manifest for one manually downloaded unsigned preview. */
export interface DesktopCommunityPreviewManifest {
  readonly formatVersion: 1
  readonly kind: 'unsigned-preview'
  readonly distribution: typeof DESKTOP_DISTRIBUTION
  readonly repository: typeof DESKTOP_REPOSITORY
  readonly applicationId: typeof DESKTOP_APPLICATION_ID
  readonly publisher: typeof DESKTOP_PUBLISHER
  readonly version: string
  readonly sourceCommit: string
  readonly autoUpdates: false
  readonly signatures: { readonly darwin: 'ad-hoc'; readonly win32: 'unsigned' }
  readonly targets: readonly DesktopCommunityTarget[]
  readonly assets: readonly DesktopCommunityReleaseAsset[]
}

/** Files for a Preview Release; this plan intentionally has no Pages output. */
export interface DesktopCommunityPreviewPlan {
  readonly release: DesktopCommunityPreviewManifest
  readonly releaseFiles: readonly { readonly name: string; readonly sourcePath: string }[]
}

/** Inputs that bind an unsigned preview matrix to the checked-out source. */
export interface DesktopCommunityPreviewOptions {
  readonly inputRoot: string
  readonly expectedVersion: string
  readonly expectedSourceCommit: string
}

/** Inputs proven by the protected signed-build and endurance jobs. */
export interface DesktopReleaseAcceptanceOptions {
  readonly target: DesktopCommunityTarget
  readonly version: string
  readonly sourceCommit: string
  readonly enduranceMinutes: number
  readonly installedExportBytes: number
}

/** Signed candidate evidence consumed by complete-matrix publication. */
export interface DesktopReleaseAcceptance extends DesktopReleaseAcceptanceOptions {
  readonly formatVersion: 1
  readonly signed: true
  readonly signatureVerified: true
  readonly installerCyclePassed: true
}

interface CandidateArtifact {
  readonly name: string
  readonly role: string
  readonly size: number
  readonly sha256: string
  readonly sha1: string
}

interface Candidate {
  readonly target: DesktopCommunityTarget
  readonly root: string
  readonly version: string
  readonly sourceCommit: string
  readonly sourceDate: string
  readonly platform: 'darwin' | 'win32'
  readonly arch: 'arm64' | 'x64'
  readonly artifacts: readonly CandidateArtifact[]
  readonly files: readonly { readonly path: string; readonly role: string }[]
  readonly windowsReleaseIndex?: string
}

interface StablePromotionInput {
  readonly releaseFile: { readonly name: string; readonly sourcePath: string }
  readonly asset: DesktopCommunityReleaseAsset
  readonly manifest: NonNullable<DesktopCommunityReleaseManifest['promotion']>
}

const COMMON_MATERIAL_FILES = [
  'SHA256SUMS',
  'desktop-sbom.cdx.json',
  'THIRD_PARTY_NOTICES.md',
  'LICENSE',
  'build-provenance.json',
] as const

const SIGNED_MATERIAL_FILES = [
  ...COMMON_MATERIAL_FILES,
  'release-acceptance.json',
] as const

const PREVIEW_MATERIAL_FILES = [
  ...COMMON_MATERIAL_FILES,
  'preview-acceptance.json',
] as const

const PREVIEW_RELEASE_MATERIAL_FILES = [
  'desktop-sbom.cdx.json',
  'THIRD_PARTY_NOTICES.md',
  'LICENSE',
  'build-provenance.json',
  'preview-acceptance.json',
] as const

/**
 * Create the portable attestation only after all protected job gates have passed.
 * @param options - Target identity plus measured endurance and export coverage.
 * @returns Deterministic release-acceptance record.
 */
export function createDesktopReleaseAcceptance(
  options: DesktopReleaseAcceptanceOptions,
): DesktopReleaseAcceptance {
  if (!REQUIRED_DESKTOP_COMMUNITY_TARGETS.includes(options.target)
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.version)
    || !/^[a-f0-9]{40}$/.test(options.sourceCommit)) {
    throw new Error('desktop-community-publish: 验收记录的目标、版本或 source commit 无效')
  }
  if (!Number.isFinite(options.enduranceMinutes) || options.enduranceMinutes < 60) {
    throw new Error('desktop-community-publish: 验收记录必须覆盖至少 60 分钟耐久门禁')
  }
  if (!Number.isSafeInteger(options.installedExportBytes)
    || options.installedExportBytes < 1024 ** 3) {
    throw new Error('desktop-community-publish: 验收记录必须覆盖至少 1 GiB 安装态导出')
  }
  return {
    formatVersion: 1,
    ...options,
    signed: true,
    signatureVerified: true,
    installerCyclePassed: true,
  }
}

/**
 * Create evidence for an installer-tested build that has no publisher identity.
 * @param options - Preview target, version, and frozen source commit.
 * @returns Deterministic preview acceptance record.
 */
export function createDesktopPreviewAcceptance(
  options: DesktopPreviewAcceptanceOptions,
): DesktopPreviewAcceptance {
  if (!REQUIRED_DESKTOP_COMMUNITY_TARGETS.includes(options.target)
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.version)
    || !/^[a-f0-9]{40}$/.test(options.sourceCommit)) {
    throw new Error('desktop-community-preview: 验收记录的目标、版本或 source commit 无效')
  }
  const expectedSignature = options.target.startsWith('darwin-') ? 'ad-hoc' : 'unsigned'
  if (options.signature !== expectedSignature) {
    throw new Error('desktop-community-preview: 验收记录的平台签名状态无效')
  }
  return {
    formatVersion: 1,
    kind: 'community-desktop-unsigned-preview',
    ...options,
    releaseMode: 'unsigned-preview',
    autoUpdates: false,
    signed: false,
    signatureVerified: true,
    installerCyclePassed: true,
  }
}

/**
 * Validate three signed candidates and produce deterministic Release and Pages plans.
 * This function performs no network access and never mutates the candidate directories.
 * @param options - Candidate root, desired channel, and optional remote-state manifests.
 * @returns Complete publication plan with source paths retained outside the public manifest.
 */
export async function buildDesktopCommunityPublishPlan(
  options: DesktopCommunityPublishOptions,
): Promise<DesktopCommunityPublishPlan> {
  const candidates = await Promise.all(
    REQUIRED_DESKTOP_COMMUNITY_TARGETS.map(target => readCandidate(options.inputRoot, target, 'signed')),
  )
  const first = validateCandidateMatrix(
    candidates, options.expectedVersion, options.expectedSourceCommit, 'desktop-community-publish',
  )
  const promotion = await resolvePromotion(
    first.version,
    options.channel,
    options.publishedCanary,
    options.stableAcceptancePath,
  )

  const releaseFiles: Array<{ name: string; sourcePath: string }> = []
  const assets: DesktopCommunityReleaseAsset[] = []
  for (const candidate of candidates) {
    for (const file of candidate.files) {
      const name = releaseAssetName(candidate.target, file.path)
      if (releaseFiles.some(existing => existing.name === name)) {
        throw new Error(`desktop-community-publish: Release 资产名冲突 ${name}`)
      }
      const sourcePath = join(candidate.root, ...file.path.split('/'))
      const bytes = await readFile(sourcePath)
      releaseFiles.push({ name, sourcePath })
      assets.push({
        name,
        target: candidate.target,
        role: file.role,
        size: bytes.byteLength,
        sha256: sha256(bytes),
      })
    }
  }
  if (promotion !== undefined) {
    releaseFiles.push(promotion.releaseFile)
    assets.push(promotion.asset)
  }
  assets.sort((left, right) => left.name.localeCompare(right.name))
  releaseFiles.sort((left, right) => left.name.localeCompare(right.name))

  const release: DesktopCommunityReleaseManifest = {
    formatVersion: 2,
    distribution: DESKTOP_DISTRIBUTION,
    repository: DESKTOP_REPOSITORY,
    applicationId: DESKTOP_APPLICATION_ID,
    publisher: DESKTOP_PUBLISHER,
    channel: options.channel,
    version: first.version,
    sourceCommit: first.sourceCommit,
    targets: [...REQUIRED_DESKTOP_COMMUNITY_TARGETS],
    assets,
    ...(promotion === undefined ? {} : { promotion: promotion.manifest }),
  }
  assertExistingRelease(release, options.existingRelease)
  return {
    release,
    releaseFiles,
    pages: renderPages(release, candidates),
  }
}

/**
 * Validate an unsigned matrix and retain only manually installed assets and audit material.
 * @param options - Candidate root and exact checkout identity.
 * @returns Preview plan without any updater or Pages files.
 */
export async function buildDesktopCommunityPreviewPlan(
  options: DesktopCommunityPreviewOptions,
): Promise<DesktopCommunityPreviewPlan> {
  const candidates = await Promise.all(
    REQUIRED_DESKTOP_COMMUNITY_TARGETS.map(target => (
      readCandidate(options.inputRoot, target, 'unsigned-preview')
    )),
  )
  const first = validateCandidateMatrix(
    candidates, options.expectedVersion, options.expectedSourceCommit, 'desktop-community-preview',
  )
  const releaseFiles: Array<{ name: string; sourcePath: string }> = []
  const assets: DesktopCommunityReleaseAsset[] = []
  for (const candidate of candidates) {
    const installerRole = candidate.platform === 'darwin' ? 'installer-dmg' : 'installer-exe'
    const installer = candidate.artifacts.find(artifact => artifact.role === installerRole)
    if (installer === undefined) {
      throw new Error(`desktop-community-preview: ${candidate.target} 缺少 ${installerRole}`)
    }
    const files = [
      { path: installer.name, role: installer.role },
      ...PREVIEW_RELEASE_MATERIAL_FILES.map(path => ({ path, role: materialRole(path) })),
    ]
    for (const file of files) {
      const name = releaseAssetName(candidate.target, file.path)
      const sourcePath = join(candidate.root, ...file.path.split('/'))
      const bytes = await readFile(sourcePath)
      releaseFiles.push({ name, sourcePath })
      assets.push({
        name,
        target: candidate.target,
        role: file.role,
        size: bytes.byteLength,
        sha256: sha256(bytes),
      })
    }
  }
  releaseFiles.sort((left, right) => left.name.localeCompare(right.name))
  assets.sort((left, right) => left.name.localeCompare(right.name))
  return {
    release: {
      formatVersion: 1,
      kind: 'unsigned-preview',
      distribution: DESKTOP_DISTRIBUTION,
      repository: DESKTOP_REPOSITORY,
      applicationId: DESKTOP_APPLICATION_ID,
      publisher: DESKTOP_PUBLISHER,
      version: first.version,
      sourceCommit: first.sourceCommit,
      autoUpdates: false,
      signatures: { darwin: 'ad-hoc', win32: 'unsigned' },
      targets: [...REQUIRED_DESKTOP_COMMUNITY_TARGETS],
      assets,
    },
    releaseFiles,
  }
}

/**
 * Materialize a Preview Release tree without creating update metadata.
 * @param plan - Validated unsigned preview plan.
 * @param outputRoot - New or empty output root.
 */
export async function writeDesktopCommunityPreviewPlan(
  plan: DesktopCommunityPreviewPlan,
  outputRoot: string,
): Promise<void> {
  if (existsSync(outputRoot) && (await readdir(outputRoot)).length !== 0) {
    throw new Error('desktop-community-preview: 输出目录必须为空')
  }
  const releaseRoot = join(outputRoot, 'release')
  await mkdir(releaseRoot, { recursive: true })
  await Promise.all(plan.releaseFiles.map(async (file) => {
    await copyFile(file.sourcePath, join(releaseRoot, file.name))
  }))
  const manifestName = 'desktop-community-preview-manifest.json'
  await writeFile(join(releaseRoot, manifestName), jsonText(plan.release))
  const sumNames = [...plan.releaseFiles.map(file => file.name), manifestName].sort()
  const sums = await Promise.all(sumNames.map(async (name) => (
    `${sha256(await readFile(join(releaseRoot, name)))}  ${name}`
  )))
  await writeFile(join(releaseRoot, 'SHA256SUMS'), `${sums.join('\n')}\n`)
}

/**
 * Materialize a validated plan in a new or empty staging directory.
 * @param plan - Plan returned by {@link buildDesktopCommunityPublishPlan}.
 * @param outputRoot - Empty output root that will receive `release/` and `pages/`.
 */
export async function writeDesktopCommunityPublishPlan(
  plan: DesktopCommunityPublishPlan,
  outputRoot: string,
): Promise<void> {
  if (existsSync(outputRoot) && (await readdir(outputRoot)).length !== 0) {
    throw new Error('desktop-community-publish: 输出目录必须为空')
  }
  const releaseRoot = join(outputRoot, 'release')
  const pagesRoot = join(outputRoot, 'pages')
  await mkdir(releaseRoot, { recursive: true })
  await mkdir(pagesRoot, { recursive: true })
  await Promise.all(plan.releaseFiles.map(async (file) => {
    await copyFile(file.sourcePath, join(releaseRoot, file.name))
  }))
  await writeFile(
    join(releaseRoot, 'desktop-community-release-manifest.json'),
    jsonText(plan.release),
  )
  for (const file of plan.pages) {
    const target = join(pagesRoot, ...file.path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    if ('text' in file) await writeFile(target, file.text)
    else await copyFile(file.sourcePath, target)
  }
  await writeFile(join(pagesRoot, '.nojekyll'), '')
}

async function readCandidate(
  inputRoot: string,
  target: DesktopCommunityTarget,
  releaseMode: 'signed' | 'unsigned-preview',
): Promise<Candidate> {
  const root = join(inputRoot, target)
  if (!existsSync(root) || !(await stat(root)).isDirectory()) {
    throw new Error(`desktop-community-publish: 缺少目标目录 ${target}`)
  }
  const [platform, arch] = target.split('-') as ['darwin' | 'win32', 'arm64' | 'x64']
  const updateName = `update-manifest-${target}.json`
  const update = await readObject(join(root, updateName), `${target} update manifest`)
  const provenance = await readObject(join(root, 'build-provenance.json'), `${target} provenance`)
  const acceptanceName = releaseMode === 'signed'
    ? 'release-acceptance.json'
    : 'preview-acceptance.json'
  const acceptance = await readObject(join(root, acceptanceName), `${target} acceptance`)
  assertIdentity(update, `${target} update manifest`)
  assertIdentity(provenance, `${target} provenance`)

  const version = requiredString(update, 'version')
  const sourceCommit = requiredString(update, 'sourceCommit')
  const sourceDate = requiredString(update, 'sourceDate')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`desktop-community-publish: ${target} 版本无效`)
  }
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error(`desktop-community-publish: ${target} source commit 无效`)
  }
  if (!Number.isFinite(Date.parse(sourceDate))) {
    throw new Error(`desktop-community-publish: ${target} source date 无效`)
  }
  if (update.platform !== platform || update.arch !== arch) {
    throw new Error(`desktop-community-publish: ${target} 平台或架构不一致`)
  }
  const expectedChannel = version.includes('-') ? 'canary' : 'stable'
  if (update.channel !== expectedChannel) {
    throw new Error(`desktop-community-publish: ${target} channel 与版本不一致`)
  }
  if (update.updateBaseUrl !== DESKTOP_UPDATE_BASE_URL) {
    throw new Error(`desktop-community-publish: ${target} 更新根地址无效`)
  }

  if (provenance.version !== version
    || provenance.sourceCommit !== sourceCommit
    || provenance.platform !== platform
    || provenance.arch !== arch) {
    throw new Error(`desktop-community-publish: ${target} provenance 版本或 sourceCommit 不一致`)
  }
  const build = provenance.build
  if (typeof build !== 'object' || build === null || Array.isArray(build)
    || (build as Record<string, unknown>).releaseMode !== releaseMode) {
    throw new Error(`desktop-community-publish: ${target} provenance releaseMode 必须是 ${releaseMode}`)
  }
  if (releaseMode === 'signed') assertAcceptance(acceptance, target, version, sourceCommit)
  else assertPreviewAcceptance(acceptance, target, version, sourceCommit, platform)

  const describedArtifacts = parseArtifacts(update.artifacts, target)
  assertArtifactRoles(platform, describedArtifacts)
  const sums = parseSha256Sums(await readFile(join(root, 'SHA256SUMS'), 'utf8'), target)
  const provenanceHashes = parseProvenanceHashes(provenance.artifacts, target)
  const artifacts: CandidateArtifact[] = []
  for (const artifact of describedArtifacts) {
    const path = safeCandidatePath(artifact.name, target)
    const bytes = await readFile(join(root, ...path.split('/')))
    const actual = sha256(bytes)
    if (bytes.byteLength !== artifact.size || actual !== artifact.sha256) {
      throw new Error(`desktop-community-publish: ${target} ${path} SHA-256 或大小不一致`)
    }
    if (sums.get(path) !== actual || provenanceHashes.get(path) !== actual) {
      throw new Error(`desktop-community-publish: ${target} ${path} hash 证据不一致`)
    }
    artifacts.push({ ...artifact, sha1: createHash('sha1').update(bytes).digest('hex') })
  }
  const materialFiles = releaseMode === 'signed' ? SIGNED_MATERIAL_FILES : PREVIEW_MATERIAL_FILES
  for (const name of materialFiles) {
    if (!existsSync(join(root, name)) || !(await stat(join(root, name))).isFile()) {
      throw new Error(`desktop-community-publish: ${target} 缺少材料 ${name}`)
    }
  }
  let windowsReleaseIndex: string | undefined
  if (platform === 'win32') {
    const releaseIndex = artifacts.find(artifact => artifact.role === 'update-index')
    if (releaseIndex === undefined) {
      throw new Error('desktop-community-publish: win32 缺少 update-index')
    }
    windowsReleaseIndex = await readFile(join(root, ...releaseIndex.name.split('/')), 'utf8')
  }
  return {
    target,
    root,
    version,
    sourceCommit,
    sourceDate,
    platform,
    arch,
    artifacts,
    ...(windowsReleaseIndex === undefined ? {} : { windowsReleaseIndex }),
    files: [
      ...artifacts.map(artifact => ({ path: artifact.name, role: artifact.role })),
      { path: updateName, role: 'update-manifest' },
      ...materialFiles.map(path => ({ path, role: materialRole(path) })),
    ],
  }
}

function validateCandidateMatrix(
  candidates: readonly Candidate[],
  expectedVersion: string | undefined,
  expectedSourceCommit: string | undefined,
  subject: string,
): Candidate {
  const [first] = candidates
  if (first === undefined) throw new Error(`${subject}: 目标集合为空`)
  for (const candidate of candidates.slice(1)) {
    if (candidate.version !== first.version) {
      throw new Error(`${subject}: ${candidate.target} version 与矩阵版本不一致`)
    }
    if (candidate.sourceCommit !== first.sourceCommit) {
      throw new Error(`${subject}: ${candidate.target} sourceCommit 与矩阵 source commit 不一致`)
    }
  }
  if (expectedVersion !== undefined && first.version !== expectedVersion) {
    throw new Error(`${subject}: 候选版本与 checkout 期望版本不一致`)
  }
  if (expectedSourceCommit !== undefined && first.sourceCommit !== expectedSourceCommit) {
    throw new Error(`${subject}: 候选 source commit 与 checkout 不一致`)
  }
  return first
}

function assertIdentity(value: Record<string, unknown>, subject: string): void {
  if (value.distribution !== DESKTOP_DISTRIBUTION
    || value.repository !== DESKTOP_REPOSITORY
    || value.applicationId !== DESKTOP_APPLICATION_ID
    || value.publisher !== DESKTOP_PUBLISHER) {
    throw new Error(`desktop-community-publish: ${subject} 发行身份无效`)
  }
}

function assertAcceptance(
  value: Record<string, unknown>,
  target: DesktopCommunityTarget,
  version: string,
  sourceCommit: string,
): void {
  if (value.formatVersion !== 1
    || value.target !== target
    || value.version !== version
    || value.sourceCommit !== sourceCommit
    || value.signed !== true
    || value.signatureVerified !== true
    || value.installerCyclePassed !== true
    || typeof value.enduranceMinutes !== 'number'
    || value.enduranceMinutes < 60
    || typeof value.installedExportBytes !== 'number'
    || value.installedExportBytes < 1024 ** 3) {
    throw new Error(`desktop-community-publish: ${target} 签名或验收证据不完整`)
  }
}

function assertPreviewAcceptance(
  value: Record<string, unknown>,
  target: DesktopCommunityTarget,
  version: string,
  sourceCommit: string,
  platform: Candidate['platform'],
): void {
  const signature = platform === 'darwin' ? 'ad-hoc' : 'unsigned'
  if (value.formatVersion !== 1
    || value.kind !== 'community-desktop-unsigned-preview'
    || value.target !== target
    || value.version !== version
    || value.sourceCommit !== sourceCommit
    || value.releaseMode !== 'unsigned-preview'
    || value.autoUpdates !== false
    || value.signed !== false
    || value.signature !== signature
    || value.signatureVerified !== true
    || value.installerCyclePassed !== true) {
    throw new Error(`desktop-community-preview: ${target} unsigned-preview 验收证据不完整`)
  }
}

function parseArtifacts(value: unknown, target: DesktopCommunityTarget): CandidateArtifact[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`desktop-community-publish: ${target} artifact 列表为空`)
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`desktop-community-publish: ${target} artifact ${String(index)} 无效`)
    }
    const artifact = entry as Record<string, unknown>
    const name = safeCandidatePath(requiredString(artifact, 'name'), target)
    const role = requiredString(artifact, 'role')
    if (typeof artifact.size !== 'number' || !Number.isSafeInteger(artifact.size) || artifact.size < 0
      || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error(`desktop-community-publish: ${target} artifact ${name} 大小或 SHA-256 无效`)
    }
    return { name, role, size: artifact.size, sha256: artifact.sha256, sha1: '' }
  })
}

function assertArtifactRoles(
  platform: Candidate['platform'],
  artifacts: readonly CandidateArtifact[],
): void {
  const counts = new Map<string, number>()
  for (const artifact of artifacts) counts.set(artifact.role, (counts.get(artifact.role) ?? 0) + 1)
  const required = platform === 'darwin'
    ? { 'update-zip': 1, 'installer-dmg': 1 }
    : { 'installer-exe': 1, 'update-index': 1 }
  for (const [role, count] of Object.entries(required)) {
    if (counts.get(role) !== count) {
      throw new Error(`desktop-community-publish: ${platform} 必须恰有 ${String(count)} 个 ${role}`)
    }
  }
  if (platform === 'win32' && (counts.get('update-nupkg') ?? 0) < 1) {
    throw new Error('desktop-community-publish: win32 必须包含 update-nupkg')
  }
}

function parseSha256Sums(value: string, target: DesktopCommunityTarget): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of value.split('\n')) {
    if (line === '') continue
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    if (match === null) throw new Error(`desktop-community-publish: ${target} SHA256SUMS 格式无效`)
    result.set(safeCandidatePath(match[2]!, target), match[1]!)
  }
  return result
}

function parseProvenanceHashes(value: unknown, target: DesktopCommunityTarget): Map<string, string> {
  if (!Array.isArray(value)) {
    throw new Error(`desktop-community-publish: ${target} provenance artifact 列表无效`)
  }
  const result = new Map<string, string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    if (typeof item.path === 'string' && typeof item.hash === 'string') {
      result.set(safeCandidatePath(item.path, target), item.hash)
    }
  }
  return result
}

async function resolvePromotion(
  version: string,
  channel: DesktopCommunityChannel,
  publishedCanary: DesktopCommunityReleaseManifest | undefined,
  stableAcceptancePath: string | undefined,
): Promise<StablePromotionInput | undefined> {
  if (channel === 'canary') {
    if (!version.includes('-')) {
      throw new Error('desktop-community-publish: canary 候选必须使用预发布版本')
    }
    if (stableAcceptancePath !== undefined) {
      throw new Error('desktop-community-publish: canary 不接受 stable 验收记录')
    }
    return undefined
  }
  if (version.includes('-')) {
    throw new Error('desktop-community-publish: stable 候选不能使用预发布版本')
  }
  if (publishedCanary === undefined
    || publishedCanary.formatVersion !== 2
    || publishedCanary.distribution !== DESKTOP_DISTRIBUTION
    || publishedCanary.repository !== DESKTOP_REPOSITORY
    || publishedCanary.applicationId !== DESKTOP_APPLICATION_ID
    || publishedCanary.publisher !== DESKTOP_PUBLISHER
    || publishedCanary.channel !== 'canary'
    || !publishedCanary.version.startsWith(`${version}-`)
    || !sameTargets(publishedCanary.targets)) {
    throw new Error('desktop-community-publish: stable 缺少同一版本线的完整 canary 记录')
  }
  if (stableAcceptancePath === undefined) {
    throw new Error('desktop-community-publish: stable 缺少结构化 canary 验收记录')
  }
  const bytes = await readFile(stableAcceptancePath)
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('desktop-community-publish: stable 验收记录不是有效 JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop-community-publish: stable 验收记录必须是对象')
  }
  const record = value as Record<string, unknown>
  const targets = record.targets
  if (record.formatVersion !== 1
    || record.kind !== 'community-desktop-stable-promotion'
    || record.canaryVersion !== publishedCanary.version
    || record.canarySourceCommit !== publishedCanary.sourceCommit
    || record.stableVersion !== version
    || typeof record.observedAt !== 'string'
    || !Number.isFinite(Date.parse(record.observedAt))
    || typeof record.observationHours !== 'number'
    || record.observationHours < 24
    || typeof record.reviewer !== 'string'
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(record.reviewer)
    || !Array.isArray(targets)
    || targets.length !== REQUIRED_DESKTOP_COMMUNITY_TARGETS.length) {
    throw new Error('desktop-community-publish: stable 验收记录身份、观察期或 reviewer 无效')
  }
  for (const [index, target] of REQUIRED_DESKTOP_COMMUNITY_TARGETS.entries()) {
    const result = targets[index]
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      throw new Error(`desktop-community-publish: stable 验收记录缺少 ${target}`)
    }
    const entry = result as Record<string, unknown>
    if (entry.target !== target
      || entry.cleanInstallPassed !== true
      || entry.previousVersionToCanaryPassed !== true
      || entry.canaryToStableCandidatePassed !== true
      || typeof entry.evidence !== 'string'
      || !entry.evidence.startsWith(`${DESKTOP_REPOSITORY}/`)) {
      throw new Error(`desktop-community-publish: stable 验收记录的 ${target} 证据不完整`)
    }
  }
  const acceptanceSha256 = sha256(bytes)
  return {
    releaseFile: {
      name: 'stable-promotion-acceptance.json',
      sourcePath: stableAcceptancePath,
    },
    asset: {
      name: 'stable-promotion-acceptance.json',
      target: 'release',
      role: 'stable-promotion-acceptance',
      size: bytes.byteLength,
      sha256: acceptanceSha256,
    },
    manifest: {
      canaryVersion: publishedCanary.version,
      canarySourceCommit: publishedCanary.sourceCommit,
      acceptanceRecord: 'stable-promotion-acceptance.json',
      acceptanceSha256,
      reviewer: record.reviewer,
      observedAt: new Date(record.observedAt).toISOString(),
    },
  }
}

function assertExistingRelease(
  desired: DesktopCommunityReleaseManifest,
  existing: DesktopCommunityReleaseManifest | undefined,
): void {
  if (existing === undefined) return
  if (existing.version !== desired.version || existing.sourceCommit !== desired.sourceCommit) {
    throw new Error('desktop-community-publish: 既有 Release 版本或 source commit 不一致')
  }
  const existingAssets = new Map(existing.assets.map(asset => [asset.name, asset.sha256]))
  for (const asset of desired.assets) {
    const hash = existingAssets.get(asset.name)
    if (hash !== undefined && hash !== asset.sha256) {
      throw new Error(`desktop-community-publish: 既有 Release 资产 ${asset.name} 字节不同，不可覆盖`)
    }
  }
}

function renderPages(
  release: DesktopCommunityReleaseManifest,
  candidates: readonly Candidate[],
): DesktopCommunityPageFile[] {
  const files: DesktopCommunityPageFile[] = []
  const channels: readonly DesktopCommunityChannel[] = release.channel === 'stable'
    ? ['canary', 'stable']
    : ['canary']
  for (const channel of channels) {
    for (const candidate of candidates) {
      const root = `desktop-updates/${channel}/${candidate.target}`
      if (candidate.platform === 'darwin') {
        const update = candidate.artifacts.find(artifact => artifact.role === 'update-zip')
        if (update === undefined) throw new Error(`desktop-community-publish: ${candidate.target} 缺少 update-zip`)
        const releaseName = releaseAssetName(candidate.target, update.name)
        files.push({
          path: `${root}/releases.json`,
          text: jsonText({
            url: `${DESKTOP_RELEASE_DOWNLOAD_BASE_URL}/${desktopReleaseTag(release.version)}/${encodeURIComponent(releaseName)}`,
            name: release.version,
            notes: `${DESKTOP_PRODUCT_NAME} ${release.version}`,
            pub_date: new Date(candidate.sourceDate).toISOString(),
          }),
        })
      } else {
        files.push({
          path: `${root}/RELEASES`,
          text: renderWindowsReleaseIndex(release, candidate),
        })
      }
    }
    files.push({
      path: `desktop-updates/${channel}/manifest.json`,
      text: jsonText(release),
    })
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function renderWindowsReleaseIndex(
  release: DesktopCommunityReleaseManifest,
  candidate: Candidate,
): string {
  const source = candidate.windowsReleaseIndex?.replace(/^\uFEFF/, '')
  if (source === undefined) throw new Error('desktop-community-publish: win32 缺少 RELEASES 内容')
  const rendered = source.split(/\r?\n/).filter(line => line !== '').map((line) => {
    const match = /^([a-f0-9]{40})\s+(\S+)\s+(\d+)(\s+#.*)?$/i.exec(line)
    if (match === null) throw new Error('desktop-community-publish: win32 RELEASES 格式无效')
    const token = match[2]!
    let name: string
    try {
      name = token.startsWith('http://') || token.startsWith('https://')
        ? decodeURIComponent(basename(new URL(token).pathname))
        : basename(token)
    } catch {
      throw new Error('desktop-community-publish: win32 RELEASES 包地址无效')
    }
    const artifact = candidate.artifacts.find(item =>
      item.role === 'update-nupkg' && basename(item.name) === name)
    if (artifact === undefined
      || artifact.sha1.toLowerCase() !== match[1]!.toLowerCase()
      || artifact.size !== Number(match[3])) {
      throw new Error(`desktop-community-publish: win32 RELEASES 与 ${name} 字节证据不一致`)
    }
    const releaseName = releaseAssetName(candidate.target, artifact.name)
    const url = `${DESKTOP_RELEASE_DOWNLOAD_BASE_URL}/${desktopReleaseTag(release.version)}/${encodeURIComponent(releaseName)}`
    return `${artifact.sha1}  ${url} ${String(artifact.size)}${match[4] ?? ''}`
  })
  if (rendered.length === 0) throw new Error('desktop-community-publish: win32 RELEASES 为空')
  return `${rendered.join('\n')}\n`
}

function releaseAssetName(target: DesktopCommunityTarget, path: string): string {
  return `${target}--${path.split('/').join('--')}`
}

function materialRole(path: string): string {
  return `material-${basename(path).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

function safeCandidatePath(value: string, target: DesktopCommunityTarget): string {
  const normalized = value.split(sep).join('/')
  if (normalized === ''
    || normalized.startsWith('/')
    || normalized.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`desktop-community-publish: ${target} 候选路径无效 ${JSON.stringify(value)}`)
  }
  return normalized
}

async function readObject(path: string, subject: string): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error(`desktop-community-publish: 缺少或无法解析 ${subject}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`desktop-community-publish: ${subject} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const result = value[field]
  if (typeof result !== 'string' || result === '') {
    throw new Error(`desktop-community-publish: 缺少字符串字段 ${field}`)
  }
  return result
}

function sameTargets(value: readonly DesktopCommunityTarget[]): boolean {
  return value.length === REQUIRED_DESKTOP_COMMUNITY_TARGETS.length
    && value.every((target, index) => target === REQUIRED_DESKTOP_COMMUNITY_TARGETS[index])
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
