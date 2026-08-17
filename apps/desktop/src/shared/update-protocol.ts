/** Main 与 Renderer 共用的闭合更新状态。 */
import { z } from 'zod'

const desktopUpdateChannelSchema = z.enum(['stable', 'canary'])
const common = {
  channel: desktopUpdateChannelSchema,
  currentVersion: z.string().min(1).max(128),
}

/** Renderer 可见的更新状态；不包含 feed URL、本机路径或签名细节。 */
export const desktopUpdateStateSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('IDLE'), ...common }),
  z.strictObject({ phase: z.literal('CHECKING'), ...common }),
  z.strictObject({
    phase: z.literal('DOWNLOADING'), ...common,
    targetVersion: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({
    phase: z.literal('READY'), ...common,
    targetVersion: z.string().min(1).max(128),
  }),
  z.strictObject({
    phase: z.literal('INSTALLING'), ...common,
    targetVersion: z.string().min(1).max(128),
  }),
  z.strictObject({
    phase: z.literal('ERROR'), ...common,
    code: z.string().regex(/^[A-Z0-9_.-]{1,128}$/),
    message: z.string().min(1).max(1024),
    retryable: z.boolean(),
  }),
])

export type DesktopUpdateChannel = z.infer<typeof desktopUpdateChannelSchema>
export type DesktopUpdateState = z.infer<typeof desktopUpdateStateSchema>
