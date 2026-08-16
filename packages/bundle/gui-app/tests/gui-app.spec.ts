/**
 * GUI 组合包约束：共享行只有一个所有者，且 GUI 层不依赖浏览器传输。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { guiAppResourceOverlays, SHIPPED_AGENT_PRESET_ROOT } from '../src/index.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const repository = resolve(root, '../../..')
const patch = (path: string) => loadOverlayPatches('gui-app-test', resolve(repository, path))

const SHARED_GUI_ROWS = [
  'api-gateway',
  'api-remotes',
  'client-runtime',
  'connection',
  'cordis-client-runner',
  'cordis-host-runner',
  'message-feedback',
  'modules',
  'session-log-download',
  'storage-domain',
  'ui-conversation',
  'ui-layout',
  'ui-settings',
  'workspace',
] as const

const WEB_TRANSPORT_ROWS = [
  'client-hmr',
  'connection-web',
  'modules-web',
  'web-runtime',
  'web-startup',
  'webserver',
] as const

describe('dsh-gui-app bundle', () => {
  it('ships one shared Agent Preset roster and exposes its product overlay', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { files?: string[] }
    expect(manifest.files).toContain('agent-presets')
    expect(readdirSync(SHIPPED_AGENT_PRESET_ROOT).sort()).toEqual(['code', 'cordis', 'minimal', 'standard'])
    expect(guiAppResourceOverlays(new Map([
      ['agent-presets', { config: { default: 'standard', includeUserRoot: true } }],
    ]))).toEqual([{
      id: 'agent-presets',
      config: {
        default: 'standard',
        includeUserRoot: true,
        roots: [{ path: SHIPPED_AGENT_PRESET_ROOT, trust: 'system' }],
      },
    }])
    expect(guiAppResourceOverlays(new Map())).toEqual([])
  })

  it('owns every shared GUI row exactly once without browser transport rows', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')

    const guiEntries = composeEntries([
      patch('packages/bundle/base/cordis.patch.yml'),
      patch('packages/bundle/gui-app/cordis.patch.yml'),
    ])
    const ids = guiEntries.map(entry => entry.id)
    for (const id of SHARED_GUI_ROWS) expect(ids.filter(candidate => candidate === id), id).toHaveLength(1)
    for (const id of WEB_TRANSPORT_ROWS) expect(ids, id).not.toContain(id)
  })

  it('keeps shared GUI rows out of the browser transport layer', () => {
    const webRows = composeEntries([patch('packages/bundle/web-app/cordis.patch.yml')])
    const ids = webRows.map(entry => entry.id)
    for (const id of SHARED_GUI_ROWS) expect(ids, id).not.toContain(id)
    for (const id of WEB_TRANSPORT_ROWS) expect(ids.filter(candidate => candidate === id), id).toHaveLength(1)
  })
})
