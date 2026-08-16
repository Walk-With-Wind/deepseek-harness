/** Main 与 Utility 之间的严格控制协议；业务请求只走独立数据端口。 */
import { z } from 'zod'
import { clientResourceManifestSchema } from '@deepseek-ai/dsh-client-modules'
import { desktopBootGraphSchema } from './boot-graph.ts'

/** 首版桌面控制协议。 */
export const DESKTOP_CONTROL_PROTOCOL_VERSION = 1

/** 可由安装配置调整的监督与传输参数。 */
export interface DesktopConfig {
  readonly bootTimeoutMs: number
  readonly shutdownGraceMs: number
  readonly terminateGraceMs: number
  readonly restartWindowMs: number
  readonly restartMaxAttempts: number
  readonly restartBaseDelayMs: number
  readonly restartMaxDelayMs: number
  readonly restartJitterMs: number
  readonly resumeHealthTimeoutMs: number
  readonly maxInFlightRequests: number
  readonly maxRequestBodyBytes: number
  readonly logMaxBytes: number
  readonly logMaxFiles: number
  readonly updateInitialDelayMs: number
  readonly updateCheckIntervalMs: number
  readonly updateCheckJitterMs: number
}

/** 经过设计验收的 Desktop 首发默认值。 */
export const DEFAULT_DESKTOP_CONFIG: DesktopConfig = Object.freeze({
  bootTimeoutMs: 60_000,
  shutdownGraceMs: 15_000,
  terminateGraceMs: 5_000,
  restartWindowMs: 60_000,
  restartMaxAttempts: 3,
  restartBaseDelayMs: 1_000,
  restartMaxDelayMs: 10_000,
  restartJitterMs: 250,
  resumeHealthTimeoutMs: 5_000,
  maxInFlightRequests: 128,
  maxRequestBodyBytes: 160 * 1024 * 1024,
  logMaxBytes: 5 * 1024 * 1024,
  logMaxFiles: 4,
  updateInitialDelayMs: 15 * 60 * 1000,
  updateCheckIntervalMs: 6 * 60 * 60 * 1000,
  updateCheckJitterMs: 30 * 60 * 1000,
})

const desktopConfigSchema = z.strictObject({
  bootTimeoutMs: z.number().int().min(5_000).max(300_000).default(DEFAULT_DESKTOP_CONFIG.bootTimeoutMs),
  shutdownGraceMs: z.number().int().min(1_000).max(60_000).default(DEFAULT_DESKTOP_CONFIG.shutdownGraceMs),
  terminateGraceMs: z.number().int().min(1_000).max(30_000).default(DEFAULT_DESKTOP_CONFIG.terminateGraceMs),
  restartWindowMs: z.number().int().min(10_000).max(600_000).default(DEFAULT_DESKTOP_CONFIG.restartWindowMs),
  restartMaxAttempts: z.number().int().min(0).max(10).default(DEFAULT_DESKTOP_CONFIG.restartMaxAttempts),
  restartBaseDelayMs: z.number().int().min(100).max(10_000).default(DEFAULT_DESKTOP_CONFIG.restartBaseDelayMs),
  restartMaxDelayMs: z.number().int().min(100).max(60_000).default(DEFAULT_DESKTOP_CONFIG.restartMaxDelayMs),
  restartJitterMs: z.number().int().min(0).max(5_000).default(DEFAULT_DESKTOP_CONFIG.restartJitterMs),
  resumeHealthTimeoutMs: z.number().int().min(1_000).max(30_000).default(DEFAULT_DESKTOP_CONFIG.resumeHealthTimeoutMs),
  maxInFlightRequests: z.number().int().min(1).max(1_024).default(DEFAULT_DESKTOP_CONFIG.maxInFlightRequests),
  maxRequestBodyBytes: z.number().int().min(1024 * 1024).max(160 * 1024 * 1024)
    .default(DEFAULT_DESKTOP_CONFIG.maxRequestBodyBytes),
  logMaxBytes: z.number().int().min(64 * 1024).max(64 * 1024 * 1024).default(DEFAULT_DESKTOP_CONFIG.logMaxBytes),
  logMaxFiles: z.number().int().min(2).max(16).default(DEFAULT_DESKTOP_CONFIG.logMaxFiles),
  updateInitialDelayMs: z.number().int().min(10_000).max(24 * 60 * 60 * 1000)
    .default(DEFAULT_DESKTOP_CONFIG.updateInitialDelayMs),
  updateCheckIntervalMs: z.number().int().min(60 * 60 * 1000).max(7 * 24 * 60 * 60 * 1000)
    .default(DEFAULT_DESKTOP_CONFIG.updateCheckIntervalMs),
  updateCheckJitterMs: z.number().int().min(0).max(60 * 60 * 1000)
    .default(DEFAULT_DESKTOP_CONFIG.updateCheckJitterMs),
}).superRefine((config, context) => {
  if (config.restartMaxDelayMs < config.restartBaseDelayMs) {
    context.addIssue({
      code: 'custom',
      path: ['restartMaxDelayMs'],
      message: 'restartMaxDelayMs 不得小于 restartBaseDelayMs',
    })
  }
  if (config.restartJitterMs > config.restartBaseDelayMs) {
    context.addIssue({
      code: 'custom',
      path: ['restartJitterMs'],
      message: 'restartJitterMs 不得大于 restartBaseDelayMs',
    })
  }
  if (config.updateCheckJitterMs > config.updateCheckIntervalMs / 4) {
    context.addIssue({
      code: 'custom', path: ['updateCheckJitterMs'],
      message: 'updateCheckJitterMs 不得大于更新间隔的四分之一',
    })
  }
})

/** 校验并补齐 Desktop 配置。 */
export function parseDesktopConfig(value: unknown): DesktopConfig {
  return desktopConfigSchema.parse(value)
}

const generation = z.number().int().positive()
const operationId = z.string().min(1).max(128)
const appVersion = z.string().min(1).max(128)
const stableMessage = z.string().min(1).max(1024)
const absolutePath = z.string().min(1).max(32_768).refine(
  path => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\'),
  '路径必须是绝对路径',
)
const pathOpenIntent = z.enum(['default', 'text-editor'])

/** Main 支持的两种受控路径打开意图。 */
export type DesktopPathOpenIntent = z.infer<typeof pathOpenIntent>
/** Main 发给 Utility 的消息。 */
const mainControlFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('host/hello'),
    protocolVersion: z.literal(DESKTOP_CONTROL_PROTOCOL_VERSION),
    generation,
    appVersion,
    homeKey: z.string().regex(/^[a-f0-9]{64}$/),
    config: desktopConfigSchema,
  }),
  z.strictObject({ type: z.literal('host/shutdown'), generation, deadline: z.number().int().nonnegative(), reason: stableMessage }),
  z.strictObject({ type: z.literal('host/health'), generation, operationId }),
  z.strictObject({ type: z.literal('data/attach'), generation, connectionId: operationId }),
  z.strictObject({ type: z.literal('dialog/result'), generation, operationId, path: absolutePath.nullable() }),
  z.strictObject({
    type: z.literal('path/result'), generation, operationId,
    outcome: z.enum(['opened', 'failed']), message: stableMessage.optional(),
  }),
  z.strictObject({ type: z.literal('export/start'), generation, operationId, sessionId: z.string().min(1).max(256), targetPath: absolutePath }),
  z.strictObject({ type: z.literal('export/cancel'), generation, operationId }),
])

/** Utility 发给 Main 的消息。 */
const utilityControlFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('host/ready'),
    protocolVersion: z.literal(DESKTOP_CONTROL_PROTOCOL_VERSION),
    generation,
    appVersion,
    resources: clientResourceManifestSchema,
    boot: desktopBootGraphSchema,
  }),
  z.strictObject({ type: z.literal('host/failed'), generation, code: z.string().min(1).max(128), message: stableMessage }),
  z.strictObject({ type: z.literal('host/quiescent'), generation }),
  z.strictObject({ type: z.literal('host/healthy'), generation, operationId }),
  z.strictObject({ type: z.literal('dialog/open-directory'), generation, operationId }),
  z.strictObject({ type: z.literal('path/open'), generation, operationId, path: absolutePath, intent: pathOpenIntent }),
  z.strictObject({ type: z.literal('path/cancel'), generation, operationId }),
  z.strictObject({ type: z.literal('export/progress'), generation, operationId, bytes: z.number().int().nonnegative() }),
  z.strictObject({
    type: z.literal('export/result'), generation, operationId,
    outcome: z.enum(['saved', 'cancelled', 'failed']),
    message: stableMessage.optional(),
  }),
])

/** Main → Utility 控制帧。 */
export type MainControlFrame = z.infer<typeof mainControlFrameSchema>
/** Utility → Main 控制帧。 */
export type UtilityControlFrame = z.infer<typeof utilityControlFrameSchema>

/** 校验 Main → Utility wire 值。 */
export function parseMainControlFrame(value: unknown): MainControlFrame {
  return mainControlFrameSchema.parse(value)
}

/** 校验 Utility → Main wire 值。 */
export function parseUtilityControlFrame(value: unknown): UtilityControlFrame {
  return utilityControlFrameSchema.parse(value)
}
