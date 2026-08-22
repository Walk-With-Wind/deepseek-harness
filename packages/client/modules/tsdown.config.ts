import type { UserConfig } from 'tsdown'
import { clientBundle } from '../tsdown.client.ts'

/** Build one stable ESM entry without hash-named shared chunks. */
function companion(entry: string, platform: 'browser' | 'node'): UserConfig {
  return {
    entry: [entry],
    outDir: 'lib',
    format: ['esm'],
    platform,
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }
}

export default clientBundle(
  '@deepseek-ai/dsh-client-modules',
  ['lib/types/index.js', 'lib/types/invariant.js'],
  {
    companions: [
      companion('lib/types/bootstrap.js', 'browser'),
      companion('lib/types/web.js', 'node'),
    ],
  },
)
