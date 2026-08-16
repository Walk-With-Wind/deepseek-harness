/** Main 与 Renderer 共用的闭合更新状态。 */
import { z } from 'zod'

const desktopUpdateChannelSchema = z.enum(['stable', 'canary'])
const common = {
  channel: desktopUpdateChannelSchema,
  currentVersion: z.string().min(1).max(128),
}

/** Renderer 可见的更新状态；不包含 feed URL、本机路径或签名细节。 */
export const desktopUpdateStateSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('IDLE'), supported: z.literal(true), ...common }),
  z.strictObject({ phase: z.literal('CHECKING'), supported: z.literal(true), ...common }),
  z.strictObject({
    phase: z.literal('DOWNLOADING'), supported: z.literal(true), ...common,
    targetVersion: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({
    phase: z.literal('READY'), supported: z.literal(true), ...common,
    targetVersion: z.string().min(1).max(128),
  }),
  z.strictObject({
    phase: z.literal('INSTALLING'), supported: z.literal(true), ...common,
    targetVersion: z.string().min(1).max(128),
  }),
  z.strictObject({
    phase: z.literal('ERROR'), supported: z.literal(true), ...common,
    code: z.string().regex(/^[A-Z0-9_.-]{1,128}$/),
    message: z.string().min(1).max(1024),
    retryable: z.boolean(),
  }),
  z.strictObject({
    phase: z.literal('UNSUPPORTED'), supported: z.literal(false), ...common,
    guidance: z.string().min(1).max(1024),
    releasePageUrl: z.url().max(2048),
  }),
])

export type DesktopUpdateChannel = z.infer<typeof desktopUpdateChannelSchema>
export type DesktopUpdateState = z.infer<typeof desktopUpdateStateSchema>
