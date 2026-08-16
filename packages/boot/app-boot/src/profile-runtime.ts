/** 不依赖进程 signal、stdio 或退出语义的 Profile Host 启动运行时。 */
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { acquireHostLease, type HostLease, type HostLeaseOwner } from './host-lease.ts'
import {
  composeEntries,
  healProfilesModuleFallback,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  type Profile,
} from './profile.ts'
import {
  boot,
  loadOptionalPatches,
  loadOverlayPatches,
  watchUserPatches,
} from './index.ts'

/** Loader 使用的空 Profile 根配置文件名。 */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

const PROFILE_ROOT_CONFIG = `# dsh profile 根配置为空；实际树由 bundle、用户层与产品 overlay 依次组合。
[]
`

/** 准备 Profile 组合的进程无关参数。 */
export interface PrepareProfileRuntimeOptions {
  /** 启动诊断前缀。 */
  readonly binName: string
  /** Profile 名称。 */
  readonly profileName: string
  /** 当前产品安装包的 package.json。 */
  readonly installAnchor: string
  /** 规范化前的 Harness home。 */
  readonly home?: string
  /** 是否读取 Profile 用户 patch。 */
  readonly userLayer?: boolean
  /** 是否读取 home 级用户 patch；默认与 Host 启动一致地启用。 */
  readonly homeUserLayer?: boolean
  /** 调用方显式传入的 overlay 文件，按顺序应用。 */
  readonly overlayFiles?: readonly string[]
  /** 产品直接提供的 overlay，位于用户层之上。 */
  readonly overlays?: readonly PatchOptions[]
  /** 根据初始组合增加产品 overlay，例如 telemetry 或随安装资源根。 */
  readonly extendOverlays?: (rows: ReadonlyMap<string, EntryOptions>) => readonly PatchOptions[]
}

/** 已解析且可重复组合的 Profile 启动输入。 */
export interface PreparedProfileRuntime {
  /** 当前 Profile 及其 bundle 层。 */
  readonly profile: Profile
  /** 当前启动使用的 Harness home。 */
  readonly home: string
  /** Loader 的空根配置绝对路径。 */
  readonly rootConfigPath: string
  /** 最终组合的行索引。 */
  readonly rows: ReadonlyMap<string, EntryOptions>
  /** 返回本次启动的深克隆 patch 列表。 */
  patches(): PatchOptions[]
  /** 重新读取两个用户层，并返回可用于 HMR 的深克隆 patch 列表。 */
  livePatches(): PatchOptions[]
}

/** Profile 启动与 watcher 设置参数。 */
export interface BootProfileRuntimeOptions extends PrepareProfileRuntimeOptions {
  /** 当前 Host 的租约身份。 */
  readonly owner: HostLeaseOwner
  /** Loader 安装后、配置树挂载前的产品准备逻辑。 */
  readonly prepare?: (ctx: Context) => Promise<void> | void
  /** 已安装 Host 解析裸包名时使用的显式基址。 */
  readonly bareModuleBaseUrl?: string
  /** 是否保持 Profile 与 home 用户 patch 热更新；默认启用。 */
  readonly watchUserPatches?: boolean
}

/** 成功启动的 Profile Host。 */
export interface BootedProfileRuntime {
  /** 已稳定的根 Cordis Context。 */
  readonly ctx: Context
  /** 本次启动持有的 Host 租约。 */
  readonly lease: HostLease
  /** 本次启动的 Profile 组合。 */
  readonly runtime: PreparedProfileRuntime
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 共享 app-boot 在任何 Host 插件挂载前取得的独占租约。 */
    hostLease: HostLease
  }
}

/**
 * 返回 Home 级用户 patch 路径。
 * @param home - Harness home；省略时使用当前解析结果。
 * @returns `cordis.patch.yml` 的绝对路径。
 */
export function homeProfilePatchPath(home: string = resolveDshHome()): string {
  return join(home, PROFILE_PATCH_FILENAME)
}

/**
 * 解析 Profile、应用 patch 层并写入 Loader 所需的空根配置。
 * @param options - Profile、安装锚点、用户层与产品 overlay。
 * @returns 可重复组合和刷新用户层的进程无关启动输入。
 */
export function prepareProfileRuntime(options: PrepareProfileRuntimeOptions): PreparedProfileRuntime {
  const home = resolve(options.home ?? resolveDshHome())
  healProfilesModuleFallback(options.installAnchor, home)
  const profile = loadProfile(
    options.binName,
    options.profileName,
    options.installAnchor,
    home,
    options.userLayer === undefined ? {} : { userLayer: options.userLayer },
  )
  const rootConfigPath = join(profile.dir, PROFILE_ROOT_FILENAME)
  writeFileSync(rootConfigPath, PROFILE_ROOT_CONFIG)
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  const homePatches = options.homeUserLayer === false
    ? []
    : loadOptionalPatches(options.binName, homeProfilePatchPath(home)) ?? []
  const fileOverlays = (options.overlayFiles ?? [])
    .flatMap(file => loadOverlayPatches(options.binName, resolve(file)))
  const baseOverlays = [...fileOverlays, ...(options.overlays ?? [])]
  const preliminaryRows = indexRows(composeEntries([
    bundlePatches,
    profile.patches,
    homePatches,
    baseOverlays,
  ]))
  const productOverlays = options.extendOverlays?.(preliminaryRows) ?? []
  const overlays = [...baseOverlays, ...productOverlays]
  const rows = indexRows(composeEntries([
    bundlePatches,
    profile.patches,
    homePatches,
    overlays,
  ]))
  const patchList = (): PatchOptions[] => [
    ...bundlePatches,
    ...profile.patches,
    ...homePatches,
    ...overlays,
  ]
  return {
    profile,
    home,
    rootConfigPath,
    rows,
    patches: () => structuredClone(patchList()),
    livePatches: () => structuredClone([
      ...bundlePatches,
      ...loadOptionalPatches(options.binName, profile.patchPath) ?? [],
      ...options.homeUserLayer === false
        ? []
        : loadOptionalPatches(options.binName, homeProfilePatchPath(home)) ?? [],
      ...overlays,
    ]),
  }
}

/**
 * 先取得 Host 租约，再准备、挂载并安定 Profile 插件树。
 * @param options - Profile 组合、Host owner 与产品准备参数。
 * @returns 已稳定的根 Context、租约与启动输入。
 */
export async function bootProfileRuntime(options: BootProfileRuntimeOptions): Promise<BootedProfileRuntime> {
  const home = resolve(options.home ?? resolveDshHome())
  const lease = await acquireHostLease({ home, owner: options.owner })
  let ctx: Context | undefined
  try {
    const runtime = prepareProfileRuntime({ ...options, home })
    ctx = await boot(
      options.binName,
      runtime.rootConfigPath,
      runtime.patches(),
      async (hostCtx) => {
        hostCtx.provide('hostLease', lease)
        // 根 effect 最先注册；Cordis 会先释放后注册的 Host effects，再释放租约。
        hostCtx.effect(() => async () => { await lease.release() }, 'app-boot: Host lease')
        await options.prepare?.(hostCtx)
      },
      options.bareModuleBaseUrl,
    )
    if (options.watchUserPatches !== false) await watchRuntimeUserPatches(ctx, runtime, options.binName)
    return { ctx, lease, runtime }
  } catch (error) {
    if (ctx !== undefined) await ctx.fiber.dispose()
    await lease.release()
    throw error
  }
}

function indexRows(entries: readonly EntryOptions[]): ReadonlyMap<string, EntryOptions> {
  const rows = new Map<string, EntryOptions>()
  for (const row of entries) if (typeof row.id === 'string') rows.set(row.id, row)
  return rows
}

async function watchRuntimeUserPatches(
  ctx: Context,
  runtime: PreparedProfileRuntime,
  binName: string,
): Promise<void> {
  if (ctx.fiber.state !== FiberState.ACTIVE || ctx.get('loader') === undefined) return
  try {
    if (ctx.get('hmr') === undefined) {
      if (ctx.get('timer') === undefined) {
        await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
      }
      await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
    }
    const compose = (): PatchOptions[] => runtime.livePatches()
    await watchUserPatches(ctx, {
      binName,
      filename: runtime.profile.patchPath,
      compose,
    })
    await watchUserPatches(ctx, {
      binName,
      filename: homeProfilePatchPath(runtime.home),
      compose,
    })
  } catch (error) {
    // 一次性 surface 可在 watcher 设置期间主动释放；只有仍存活的树才把设置失败视为启动错误。
    if (ctx.get('loader') !== undefined) throw error
  }
}
