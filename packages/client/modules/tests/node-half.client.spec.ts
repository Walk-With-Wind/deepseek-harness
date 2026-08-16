/** Node-half composition diagnostics for package metadata and built client bundles. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  ClientModuleRegistry,
  parseClientResourceManifest,
} from '../src/index.ts'
import { apply as applyWeb } from '../src/web.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Create a resolvable package whose client export points at the returned path. */
function writePackage(
  packageName: string,
  metadata: Record<string, unknown> = { dsh: { client: { platform: 'web' } } },
): string {
  root ??= realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-modules-')))
  const pkgRoot = join(root, 'node_modules', ...packageName.split('/'))
  const clientPath = join(pkgRoot, 'lib', 'client.js')
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: packageName,
    exports: {
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    ...metadata,
  }))
  return clientPath
}

/** Construct the node-half service and capture its plugin-bundle route. */
function constructWithRoute(packageNames: string[]): { service: ClientModuleRegistry; route: WebRoute } {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  ctx.provide('loader', {
    *entries() {
      for (const packageName of packageNames) {
        yield { options: { name: packageName }, fiber: {}, disabled: false }
      }
    },
  })
  let route: WebRoute | undefined
  const webServer: Pick<WebServer, 'port' | 'register' | 'tapIndex'> = {
    port: 0,
    register: (candidate) => {
      if (candidate.path === '/plugins') route = candidate
      return () => {}
    },
    tapIndex: () => () => {},
  }
  ctx.provide('webServer', webServer as WebServer)
  const service = new ClientModuleRegistry(ctx)
  applyWeb(ctx)
  if (route === undefined) throw new Error('client bundle route was not registered')
  return { service, route }
}

/** Construct the node-half service over the enabled fixture entries. */
function construct(packageNames: string[]): ClientModuleRegistry {
  return constructWithRoute(packageNames).service
}

describe('client bundle activation', () => {
  it('在首次图读取前同步结算尚未运行的增量扫描', () => {
    const packageName = '@fixture/late-client'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const entries: Array<{ options: { name: string }; fiber: object; disabled: boolean }> = []
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(root!).href + '/'
    ctx.provide('loader', {
      *entries() { yield * entries },
    })
    const service = new ClientModuleRegistry(ctx)
    const lateEntry = { options: { name: packageName }, fiber: {}, disabled: false }
    entries.push(lateEntry)
    // 首次快照可能早于增量通知到达，但此时 Loader 已经完成整个 Host 图激活。

    expect(service.graph().entries.map(entry => entry.id)).toEqual([packageName])
    expect(service.resourceManifest().resources.map(resource => resource.id)).toEqual([packageName])
  })

  it('接收模块注册器同级条目的激活通知', async () => {
    const packageName = '@fixture/sibling-client'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const entries: Array<{ options: { name: string }; fiber: object; disabled: boolean }> = []
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(root!).href + '/'
    ctx.provide('loader', {
      *entries() { yield * entries },
    })
    const lateEntry = { options: { name: packageName }, fiber: {}, disabled: false }
    ctx.on('internal/plugin', (fiber) => {
      // 模拟 Loader 的全局监听：条目归属在原始 internal/plugin 发布后才写入 Fiber。
      ;(fiber as unknown as { entry?: typeof lateEntry }).entry ??= lateEntry
    }, { global: true })
    let service: ClientModuleRegistry | undefined
    await ctx.plugin({
      apply(inner) { service = new ClientModuleRegistry(inner) },
    })
    entries.push(lateEntry)
    await ctx.plugin({
      apply(inner) {
        // Loader 条目与 modules 条目互为同级，增量监听必须跨 Fiber 作用域接收通知。
        inner.emit('internal/plugin', {} as never)
      },
    })

    expect(service?.graph().entries.map(entry => entry.id)).toEqual([packageName])
  })

  it('封闭宿主优先从显式模块基址解析客户端包', () => {
    const packageName = '@fixture/host-owned-client'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const ctx = new Context()
    ctx.baseUrl = 'file:///nonexistent-profile/cordis.yml'
    ctx.provide('hostModuleBaseUrl', pathToFileURL(join(root!, 'host-entry.mjs')).href)
    ctx.provide('loader', {
      *entries() {
        yield { options: { name: packageName }, fiber: {}, disabled: false }
      },
    })

    expect(new ClientModuleRegistry(ctx).graph().entries.map(entry => entry.id)).toEqual([packageName])
  })

  it('封闭宿主从 Profile 基址解析组合包的传递客户端依赖', () => {
    const packageName = '@fixture/profile-owned-client'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(join(root!, 'profiles', 'desktop', 'cordis.yml')).href
    ctx.provide('hostModuleBaseUrl', pathToFileURL(join(tmpdir(), 'dsh-unrelated-host', 'entry.mjs')).href)
    ctx.provide('loader', {
      *entries() {
        yield { options: { name: packageName }, fiber: {}, disabled: false }
      },
    })

    expect(new ClientModuleRegistry(ctx).graph().entries.map(entry => entry.id)).toEqual([packageName])
  })

  it('allows sibling dsh roles', () => {
    const currentName = '@fixture/current-client-field'
    const clientPath = writePackage(currentName, {
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
        profile: { bundles: [] },
      },
    })
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    expect(construct([currentName]).graph().entries.map(entry => entry.id)).toEqual([currentName])
  })

  it('groups missing bundles under one source-build instruction with a package/path list', () => {
    const firstName = '@fixture/missing-first'
    const secondName = '@fixture/missing-second'
    const firstPath = writePackage(firstName)
    const secondPath = writePackage(secondName)
    expect(() => construct([firstName, secondName])).toThrow([
      'client-modules: 2 client packages failed to compose:',
      '  client bundles not found; run `pnpm run build` before launch:',
      `    - package: ${firstName}`,
      `      path: ${firstPath}`,
      `    - package: ${secondName}`,
      `      path: ${secondPath}`,
    ].join('\n'))
  })

  it('does not report other bundle read failures as missing builds', () => {
    const packageName = '@fixture/unreadable-client'
    const clientPath = writePackage(packageName)
    mkdirSync(clientPath, { recursive: true })
    let thrown: unknown
    try {
      construct([packageName])
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toContain('client-modules: 1 client package failed to compose:')
    expect(String(thrown)).toContain('  other failures:')
    expect(String(thrown)).toContain('EISDIR')
    expect(String(thrown)).not.toContain('pnpm run build')
  })

  it('serves the source map beside a registered client bundle', async () => {
    const packageName = '@fixture/source-map'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const map = '{"version":3,"sources":["src/client/index.tsx"]}\n'
    writeFileSync(`${clientPath}.map`, map)
    const { route } = constructWithRoute([packageName])
    let status = 0
    let headers: Record<string, string> | undefined
    let body = ''
    const response = {
      writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
        status = nextStatus
        headers = nextHeaders
        return response
      },
      end(chunk?: Uint8Array) {
        body = chunk === undefined ? '' : Buffer.from(chunk).toString('utf8')
        return response
      },
    } as unknown as ServerResponse

    await route.handler({
      method: 'GET',
      url: `/plugins/${packageName}/client.js.map`,
    } as IncomingMessage, response)

    expect(status).toBe(200)
    expect(headers).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    })
    expect(body).toBe(map)
  })

  it('生成严格、不可变且与启动图同代的 Desktop 资源清单', () => {
    const packageName = '@fixture/resource-manifest'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const service = construct([packageName])

    const manifest = service.resourceManifest()
    expect(parseClientResourceManifest(manifest)).toEqual(manifest)
    expect(manifest.rev).toBe(service.graph().rev)
    expect(manifest.resources).toEqual([{
      id: packageName,
      rev: service.graph().entries[0]?.rev,
      urlPath: `/plugins/${packageName}/client.js`,
      sourcePath: realpathSync(clientPath),
      sourceMapPath: `${realpathSync(clientPath)}.map`,
    }])
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.resources)).toBe(true)
    expect(() => parseClientResourceManifest({
      ...manifest,
      unexpected: true,
    })).toThrow()
  })

  it('拒绝 client export 通过符号链接逃逸所属包根', () => {
    const packageName = '@fixture/symlink-escape'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    const outside = join(root!, 'outside-client.js')
    writeFileSync(outside, 'module.exports = {}\n')
    symlinkSync(outside, clientPath)

    expect(() => construct([packageName])).toThrow(/client bundle resolves outside its package root/)
  })
})
