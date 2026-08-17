/** Desktop Main 使用的客户端 bundle 资源清单 DTO 与严格 schema。 */
import { isAbsolute } from 'node:path'
import { z } from 'zod'

/** 首版客户端资源清单。 */
export const CLIENT_RESOURCE_MANIFEST_VERSION = 1

/** 一个已由模块注册 core 解析并校验的 bundle 资源。 */
export interface ClientResourceEntry {
  /** 包名，也是启动图条目 id。 */
  readonly id: string
  /** bundle 内容代际。 */
  readonly rev: string
  /** Renderer 可见的不透明 app/web URL 路径。 */
  readonly urlPath: string
  /** Utility 发给 Main 的可信 bundle 真实路径。 */
  readonly sourcePath: string
  /** 与 bundle 同目录的 source map 候选真实路径。 */
  readonly sourceMapPath: string
}

/** 当前模块图对应的不可变资源清单。 */
export interface ClientResourceManifest {
  /** DTO 协议版本。 */
  readonly version: typeof CLIENT_RESOURCE_MANIFEST_VERSION
  /** 与启动图一致的整体内容代际。 */
  readonly rev: string
  /** 每个 GUI 客户端包恰好一个 bundle 资源。 */
  readonly resources: readonly ClientResourceEntry[]
}

const resourceEntrySchema = z.strictObject({
  id: z.string().min(1).max(256),
  rev: z.string().min(1).max(128),
  urlPath: z.string().min(1).max(1024),
  sourcePath: z.string().refine(isAbsolute, 'sourcePath 必须是绝对路径'),
  sourceMapPath: z.string().refine(isAbsolute, 'sourceMapPath 必须是绝对路径'),
})

/** Desktop 控制端口资源清单的严格 wire schema。 */
export const clientResourceManifestSchema = z.strictObject({
  version: z.literal(CLIENT_RESOURCE_MANIFEST_VERSION),
  rev: z.string().min(1).max(128),
  resources: z.array(resourceEntrySchema).max(4096),
}).superRefine((manifest, context) => {
  const ids = new Set<string>()
  for (const [index, resource] of manifest.resources.entries()) {
    if (ids.has(resource.id)) {
      context.addIssue({ code: 'custom', path: ['resources', index, 'id'], message: '资源 id 重复' })
    }
    ids.add(resource.id)
    if (resource.urlPath !== `/plugins/${resource.id}/client.js`) {
      context.addIssue({ code: 'custom', path: ['resources', index, 'urlPath'], message: 'urlPath 与资源 id 不匹配' })
    }
    if (resource.sourceMapPath !== `${resource.sourcePath}.map`) {
      context.addIssue({ code: 'custom', path: ['resources', index, 'sourceMapPath'], message: 'sourceMapPath 必须紧邻 bundle' })
    }
  }
})

/**
 * 校验控制端口传入的资源清单。
 * @param value - 未知 wire 值。
 * @returns 严格校验后的资源清单。
 */
export function parseClientResourceManifest(value: unknown): ClientResourceManifest {
  return clientResourceManifestSchema.parse(value)
}
