/**
 * `dsh` Profile 的进程 adapter：共享 app-boot 负责租约、组合、Loader 与 watcher，
 * 本文件只保留 signal、fail-loud、命令行服务和进程退出语义。
 * @module @deepseek-ai/dsh/profile-boot
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  PROFILE_ROOT_FILENAME,
  bootProfileRuntime,
  homeProfilePatchPath,
  installFailLoud,
  prepareProfileRuntime,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { guiAppResourceOverlays } from '@deepseek-ai/dsh-gui-app'
import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'

const NAME = 'dsh'
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** 当前 dsh 安装的 package.json，作为 bundle 裸包名的第一解析锚点。 */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

export { PROFILE_ROOT_FILENAME }

/** 返回当前 Harness home 的用户 patch 路径。 */
export function homePatchPath(): string {
  return homeProfilePatchPath()
}

/** 把 telemetry 环境硬开关转换为最终 overlay。 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/** 为配置 dump 准备 Profile；Host 正常启动改由 bootProfileRuntime 一次性完成。 */
export function prepareProfile(name: string, userLayer = true): Profile {
  return prepareProfileRuntime({
    binName: NAME,
    profileName: name,
    installAnchor: INSTALL_ANCHOR,
    userLayer,
    homeUserLayer: userLayer,
  }).profile
}

/** 一个 `dsh` Profile 调用的进程参数。 */
export interface RunProfileOptions {
  /** 启动前冻结的环境来源快照。 */
  readonly environment: LaunchEnvironmentSnapshot
  /** 待启动的 Profile 名称。 */
  readonly profile: string
  /** 按 argv 顺序应用的 `--patch` 文件。 */
  readonly patchFiles: readonly string[]
  /** 交给应用树的内部参数。 */
  readonly args: readonly string[]
}

/** 启动一个 Profile，并把进程生命周期接到共享 Host 运行时。 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  const app: { current?: Context } = {}
  const shutdown = createProcessShutdown(async () => { await app.current?.fiber.dispose() })
  const interrupt = (code: number): void => { shutdown.interrupt(code) }
  process.on('SIGTERM', () => { interrupt(0) })
  process.on('SIGINT', () => { interrupt(130) })
  installFailLoud(NAME, process, async () => { await app.current?.fiber.dispose() })

  const booted = await bootProfileRuntime({
    binName: NAME,
    profileName: options.profile,
    installAnchor: INSTALL_ANCHOR,
    overlayFiles: options.patchFiles,
    owner: {
      kind: options.profile === 'web' ? 'web' : 'cli',
      version: readVersion(),
    },
    extendOverlays: rows => productOverlays(rows),
    prepare(hostCtx) {
      app.current = hostCtx
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
      provideCmdline(hostCtx, {
        args: options.args,
        exit: code => void shutdown.shutdown(code),
      })
    },
  })
  app.current = booted.ctx
  return { ctx: booted.ctx, shutdown }
}

function productOverlays(rows: ReadonlyMap<string, EntryOptions>): PatchOptions[] {
  const overlays: PatchOptions[] = [...guiAppResourceOverlays(rows)]
  const telemetry = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
  if (telemetry !== undefined) overlays.push(telemetry)
  return overlays
}

function readVersion(): string {
  const manifest = JSON.parse(readFileSync(INSTALL_ANCHOR, 'utf8')) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}
