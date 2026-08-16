/** Knip workspace 配置中本适配器需要读取的字段。 */
interface KnipWorkspaceConfig extends Record<string, unknown> {
  readonly ignoreDependencies?: readonly string[]
}

/** Knip 根配置中本适配器需要读取的字段。 */
export interface KnipConfig extends Record<string, unknown> {
  readonly ignore?: readonly string[]
  readonly workspaces?: Readonly<Record<string, KnipWorkspaceConfig>>
}

/** 当前仓库内会影响 Knip 输入发现的构建产物状态。 */
interface KnipArtifactState {
  readonly hasBuildOutputs: boolean
  readonly artifactExists: (path: string) => boolean
}

const GENERATED_OUTPUT_PATTERN = '**/lib/**'

/** 由 Typert 构建生成、并会改变 Knip 依赖可见性的运行时入口。 */
const GENERATED_DEPENDENCY_FACES = [
  {
    workspace: 'packages/extensions/cordis-host-runner',
    artifact: 'packages/extensions/cordis-host-runner/lib/typert.host.js',
    dependency: 'zod',
  },
  {
    workspace: 'packages/interaction/commands',
    artifact: 'packages/interaction/commands/lib/typert.host.js',
    dependency: 'zod',
  },
] as const

/**
 * 根据生成入口是否存在，解析不依赖构建状态的 Knip 配置。
 *
 * @param config 源码平面的 Knip 配置。
 * @param artifactExists 判断仓库相对路径是否存在的函数。
 * @returns 保留原配置且仅撤销已由生成入口证明的依赖豁免的新配置。
 */
export function resolveKnipConfigForArtifacts(
  config: KnipConfig,
  artifactState: KnipArtifactState,
): KnipConfig {
  const retainedIgnorePatterns = (config.ignore ?? []).filter(pattern => pattern !== GENERATED_OUTPUT_PATTERN)
  const resolvedIgnorePatterns = artifactState.hasBuildOutputs
    ? [...retainedIgnorePatterns, GENERATED_OUTPUT_PATTERN]
    : retainedIgnorePatterns
  const ignorePatternsChanged = resolvedIgnorePatterns.length !== (config.ignore ?? []).length
    || resolvedIgnorePatterns.some((pattern, index) => pattern !== config.ignore?.[index])
  const { ignore: _ignore, ...configWithoutIgnore } = config
  const configWithResolvedIgnores: KnipConfig = ignorePatternsChanged
    ? resolvedIgnorePatterns.length > 0
      ? { ...config, ignore: resolvedIgnorePatterns }
      : configWithoutIgnore
    : config
  const sourceWorkspaces = configWithResolvedIgnores.workspaces
  if (!sourceWorkspaces) return configWithResolvedIgnores

  let resolvedWorkspaces: Record<string, KnipWorkspaceConfig> | undefined
  for (const face of GENERATED_DEPENDENCY_FACES) {
    if (!artifactState.artifactExists(face.artifact)) continue

    const sourceWorkspace = sourceWorkspaces[face.workspace]
    if (sourceWorkspace === undefined) continue
    const ignoredDependencies = sourceWorkspace.ignoreDependencies
    if (!ignoredDependencies?.includes(face.dependency)) continue

    resolvedWorkspaces ??= { ...sourceWorkspaces }
    const retainedDependencies = ignoredDependencies.filter(dependency => dependency !== face.dependency)
    const { ignoreDependencies: _ignoredDependencies, ...workspaceWithoutIgnores } = sourceWorkspace
    resolvedWorkspaces[face.workspace] = retainedDependencies.length > 0
      ? { ...sourceWorkspace, ignoreDependencies: retainedDependencies }
      : workspaceWithoutIgnores
  }

  return resolvedWorkspaces
    ? { ...configWithResolvedIgnores, workspaces: resolvedWorkspaces }
    : configWithResolvedIgnores
}
