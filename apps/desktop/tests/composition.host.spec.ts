import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const root = fileURLToPath(new URL('..', import.meta.url))
const repository = resolve(root, '../..')
const patch = (path: string) => loadOverlayPatches('desktop-composition-test', resolve(repository, path))

describe('Desktop composition', () => {
  it('用 Main 原生能力适配器替换共享 API Gateway', () => {
    const entries = composeEntries([
      patch('packages/bundle/base/cordis.patch.yml'),
      patch('packages/bundle/gui-app/cordis.patch.yml'),
      patch('apps/desktop/cordis.patch.yml'),
    ])
    expect(entries.find(entry => entry.id === 'api-gateway')?.disabled).toBe(true)
    expect(entries.find(entry => entry.id === 'desktop-api-gateway')?.name)
      .toBe('@deepseek-ai/dsh-desktop/utility-api-proxy')
  })
})
