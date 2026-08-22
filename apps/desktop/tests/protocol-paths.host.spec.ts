import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DESKTOP_CSP, DesktopResourceMap, parseAppResourceRequest } from '../src/main/protocol.ts'

const roots: string[] = []

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-desktop-protocol-'))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('app:// resource map', () => {
  it('禁止 Renderer 远程连接和脚本 eval', () => {
    expect(DESKTOP_CSP).toContain("script-src 'self'")
    expect(DESKTOP_CSP).toContain("connect-src 'none'")
    expect(DESKTOP_CSP).toContain("font-src 'self' data:")
    expect(DESKTOP_CSP).not.toContain('unsafe-eval')
  })

  it('只接受 localhost、GET/HEAD 与规范路径', () => {
    expect(parseAppResourceRequest('app://localhost/assets/index.js', 'GET')).toEqual({
      method: 'GET', pathname: '/assets/index.js', head: false,
    })
    expect(parseAppResourceRequest('app://localhost/', 'HEAD')).toMatchObject({ pathname: '/index.html', head: true })
    for (const url of [
      'app://evil/index.html',
      'app://user@localhost/index.html',
      'app://localhost/%2e%2e/secret',
      'app://localhost/assets%2fsecret',
      'app://localhost/a%5cb',
      'app://localhost/a%00b',
    ]) expect(() => parseAppResourceRequest(url, 'GET')).toThrow()
    expect(() => parseAppResourceRequest('app://localhost/index.html', 'POST')).toThrow()
  })

  it('映射核心资源和精确插件 id，并拒绝 symlink 逃逸', () => {
    const base = root()
    const renderer = join(base, 'renderer')
    const plugin = join(base, 'plugin.js')
    const outside = join(base, 'outside.js')
    mkdirSync(join(renderer, 'assets'), { recursive: true })
    writeFileSync(join(renderer, 'index.html'), 'ok')
    writeFileSync(join(renderer, 'assets', 'index.js'), 'ok')
    writeFileSync(plugin, 'plugin')
    writeFileSync(outside, 'outside')
    const map = new DesktopResourceMap(realpathSync(renderer))
    map.replacePlugins({
      version: 1,
      rev: 'r1',
      resources: [{
        id: '@deepseek-ai/example', rev: 'p1', urlPath: '/plugins/@deepseek-ai/example/client.js',
        sourcePath: realpathSync(plugin), sourceMapPath: `${realpathSync(plugin)}.map`,
      }],
    })
    expect(map.resolve('/index.html')).toBe(realpathSync(join(renderer, 'index.html')))
    expect(map.resolve('/plugins/@deepseek-ai/example/client.js')).toBe(realpathSync(plugin))
    expect(() => map.resolve('/plugins/@deepseek-ai/unknown/client.js')).toThrow()

    const linked = join(renderer, 'assets', 'escape.js')
    symlinkSync(outside, linked)
    expect(() => map.resolve('/assets/escape.js')).toThrow()
  })
})
