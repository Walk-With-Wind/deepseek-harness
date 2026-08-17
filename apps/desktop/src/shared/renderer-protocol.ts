/** Sandboxed Renderer 与 Preload/Main 之间的最小命令协议。 */
import { z } from 'zod'
import { desktopBootGraphSchema } from './boot-graph.ts'
import { desktopUpdateStateSchema, type DesktopUpdateState } from './update-protocol.ts'

/** Renderer bridge 协议版本。 */
export const DESKTOP_RENDERER_PROTOCOL_VERSION = 1

/** Main 在可信资源清单安装后交给 Renderer 的启动信息。 */
const desktopBootstrapSchema = z.strictObject({
  protocolVersion: z.literal(DESKTOP_RENDERER_PROTOCOL_VERSION),
  generation: z.number().int().positive(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  appVersion: z.string().min(1).max(128),
  boot: desktopBootGraphSchema,
  installedUnaryLatencyAcceptance: z.literal(true).optional(),
})

/** Preload 可转发给 Main 的闭合命令集合。 */
const rendererCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('session-log/save'),
    operationId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(256),
    suggestedName: z.string().min(1).max(200)
      .regex(/^[^/\\\0]+\.zip$/i, '建议文件名必须是单个 .zip 文件名'),
  }),
  z.strictObject({
    type: z.literal('operation/cancel'),
    operationId: z.string().min(1).max(128),
  }),
  z.strictObject({ type: z.literal('host/retry') }),
  z.strictObject({ type: z.literal('update/check') }),
  z.strictObject({ type: z.literal('update/install') }),
  z.strictObject({
    type: z.literal('diagnostics/export'),
    operationId: z.string().min(1).max(128),
  }),
  z.strictObject({
    type: z.literal('renderer/ready'),
    generation: z.number().int().positive(),
  }),
  z.strictObject({
    type: z.literal('renderer/failed'),
    generation: z.number().int().positive(),
    message: z.string().min(1).max(1024),
  }),
])

/** Renderer 可见的 Host 状态。 */
const rendererHostStateSchema = z.strictObject({
  phase: z.enum(['STARTING', 'READY', 'DEGRADED', 'RECOVERING', 'FAILED', 'CIRCUIT_OPEN', 'STOPPING']),
  generation: z.number().int().nonnegative(),
  code: z.string().min(1).max(128).optional(),
  message: z.string().min(1).max(1024).optional(),
})

/** Main 返回给 Preload/Renderer 的闭合命令结果。 */
const rendererCommandResultSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('session-log/result'),
    operationId: z.string().min(1).max(128),
    outcome: z.enum(['saved', 'cancelled', 'failed']),
    message: z.string().min(1).max(1024).optional(),
  }),
  z.strictObject({
    type: z.literal('operation/cancel-result'),
    operationId: z.string().min(1).max(128),
    outcome: z.literal('accepted'),
  }),
  z.strictObject({
    type: z.literal('host/retry-result'),
    outcome: z.enum(['accepted', 'ignored']),
  }),
  z.strictObject({
    type: z.literal('update/action-result'),
    action: z.enum(['check', 'install']),
    outcome: z.enum(['accepted', 'ignored']),
  }),
  z.strictObject({
    type: z.literal('diagnostics/result'),
    operationId: z.string().min(1).max(128),
    outcome: z.enum(['saved', 'cancelled', 'failed']),
    message: z.string().min(1).max(1024).optional(),
  }),
  z.strictObject({
    type: z.literal('renderer/status-result'),
    outcome: z.enum(['accepted', 'ignored']),
  }),
])

export type DesktopBootstrap = z.infer<typeof desktopBootstrapSchema>
export type RendererCommand = z.infer<typeof rendererCommandSchema>
export type RendererHostState = z.infer<typeof rendererHostStateSchema>
export type RendererCommandResult = z.infer<typeof rendererCommandResultSchema>

/** 校验 Main → Renderer 启动清单。 */
export function parseDesktopBootstrap(value: unknown): DesktopBootstrap {
  return desktopBootstrapSchema.parse(value)
}

/** 校验 Renderer → Main 命令。 */
export function parseRendererCommand(value: unknown): RendererCommand {
  return rendererCommandSchema.parse(value)
}

/** 校验 Main → Renderer 状态通知。 */
export function parseRendererHostState(value: unknown): RendererHostState {
  return rendererHostStateSchema.parse(value)
}

/** 校验 Main → Renderer 命令结果。 */
export function parseRendererCommandResult(value: unknown): RendererCommandResult {
  return rendererCommandResultSchema.parse(value)
}

/** contextBridge 暴露的唯一桌面 API。 */
export interface DesktopRendererApi {
  /** 领取一次启动清单。 */
  bootstrap(): Promise<DesktopBootstrap>
  /** 在主 world 安装好监听器后，单次转交本次启动的数据端口。 */
  releaseDataPort(): void
  /** 发起由 Main 校验 sender 与参数的窄命令。 */
  invoke(command: RendererCommand): Promise<RendererCommandResult>
  /** 订阅脱敏 Host 状态；返回取消订阅函数。 */
  onHostState(listener: (state: RendererHostState) => void): () => void
  /** 订阅闭合更新状态；返回取消订阅函数。 */
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void
}

/** 校验 Main → Renderer 更新状态。 */
export function parseRendererUpdateState(value: unknown): DesktopUpdateState {
  return desktopUpdateStateSchema.parse(value)
}

export type { DesktopUpdateState }

declare global {
  interface Window {
    /** Preload 通过 contextBridge 暴露的冻结 API。 */
    dshDesktop?: DesktopRendererApi
  }
}
