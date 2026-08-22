/** Client-bundle resource manifest DTO and strict schema consumed by Desktop Main. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'

/** First client-resource manifest format. */
export const CLIENT_RESOURCE_MANIFEST_VERSION = 1

/** One bundle resource resolved and validated by the module-registry core. */
export interface ClientResourceEntry {
  /** Package name and boot-graph entry id. */
  readonly id: string
  /** Bundle content generation. */
  readonly rev: string
  /** Opaque app/Web URL path exposed to Renderer. */
  readonly urlPath: string
  /** Trusted bundle path sent from Utility to Main. */
  readonly sourcePath: string
  /** Candidate source-map path adjacent to the bundle. */
  readonly sourceMapPath: string
}

/** Immutable resource manifest for the current module graph. */
export interface ClientResourceManifest {
  /** DTO format version. */
  readonly version: typeof CLIENT_RESOURCE_MANIFEST_VERSION
  /** Aggregate content generation shared with the boot graph. */
  readonly rev: string
  /** Exactly one bundle resource for each GUI client package. */
  readonly resources: readonly ClientResourceEntry[]
}

const resourceEntrySchema = z.strictObject({
  id: z.string().min(1).max(256),
  rev: z.string().min(1).max(128),
  urlPath: z.string().min(1).max(1024),
  sourcePath: z.string().refine(isAbsolute, 'sourcePath must be absolute'),
  sourceMapPath: z.string().refine(isAbsolute, 'sourceMapPath must be absolute'),
})

/** Strict wire schema for the Desktop control-port resource manifest. */
export const clientResourceManifestSchema = z.strictObject({
  version: z.literal(CLIENT_RESOURCE_MANIFEST_VERSION),
  rev: z.string().min(1).max(128),
  resources: z.array(resourceEntrySchema).max(4096),
}).superRefine((manifest, context) => {
  const ids = new Set<string>()
  for (const [index, resource] of manifest.resources.entries()) {
    if (ids.has(resource.id)) {
      context.addIssue({ code: 'custom', path: ['resources', index, 'id'], message: 'duplicate resource id' })
    }
    ids.add(resource.id)
    if (resource.urlPath !== `/plugins/${resource.id}/client.js`) {
      context.addIssue({ code: 'custom', path: ['resources', index, 'urlPath'], message: 'urlPath does not match the resource id' })
    }
    if (resource.sourceMapPath !== `${resource.sourcePath}.map`) {
      context.addIssue({ code: 'custom', path: ['resources', index, 'sourceMapPath'], message: 'sourceMapPath must be adjacent to the bundle' })
    }
  }
})

/**
 * Validate a resource manifest received over the control port.
 * @param value - Unknown wire value.
 * @returns The strictly validated resource manifest.
 */
export function parseClientResourceManifest(value: unknown): ClientResourceManifest {
  return clientResourceManifestSchema.parse(value)
}
