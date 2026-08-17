/** Desktop 两条受信协议共用的客户端启动图校验。 */
import { z } from 'zod'

const bootEntrySchema = z.strictObject({
  id: z.string().min(1).max(256),
  url: z.string().min(1).max(2048),
  rev: z.string().min(1).max(128),
  inject: z.array(z.string().min(1).max(256)).max(256).optional(),
  immediately: z.boolean().optional(),
})

/** Utility 生成、Renderer 消费的闭合启动图。 */
export const desktopBootGraphSchema = z.strictObject({
  rev: z.string().min(1).max(128),
  entries: z.array(bootEntrySchema).max(4096),
})
