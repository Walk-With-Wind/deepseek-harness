import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSafeStagingTarget,
  detectBinaryArchitectures,
  ensureKnownNativeExecutableModes,
  materializeStagedLinks,
  pruneKnownNativeVariants,
  resolvePnpmInvocation,
  verifyJavaScriptRuntimeClosure,
  verifyNativeRuntimeFiles,
  verifyOwnedPeerClosure,
  verifySymlinkFree,
} from './runtime-staging.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-staging-'))
  roots.push(root)
  return root
}

describe('runtime staging', () => {
  it('通过 pnpm JavaScript 入口执行部署以兼容 Windows Node 24', () => {
    expect(resolvePnpmInvocation(['--filter', '@deepseek-ai/dsh-desktop', 'deploy'], {
      npm_execpath: 'C:\\pnpm\\pnpm.cjs',
    })).toEqual({
      command: process.execPath,
      args: ['C:\\pnpm\\pnpm.cjs', '--filter', '@deepseek-ai/dsh-desktop', 'deploy'],
    })
    expect(resolvePnpmInvocation(['deploy'], {
      PNPM_HOME: 'C:\\setup-pnpm\\node_modules\\.bin',
    }, 'win32', () => true)).toEqual({
      command: process.execPath,
      args: ['C:\\setup-pnpm\\node_modules\\pnpm\\bin\\pnpm.cjs', 'deploy'],
    })
    expect(resolvePnpmInvocation(['deploy'], {}, 'linux')).toEqual({
      command: 'pnpm',
      args: ['deploy'],
    })
    expect(() => resolvePnpmInvocation([], {}, 'win32', () => false)).toThrow(/PNPM_HOME/)
  })

  it('物化包链接、丢弃 .bin 链接并拒绝残留链接', async () => {
    const root = await fixture()
    const source = join(root, 'source')
    const nodeModules = join(root, 'stage', 'node_modules')
    await mkdir(source, { recursive: true })
    await mkdir(join(nodeModules, '.bin'), { recursive: true })
    await writeFile(join(source, 'index.js'), 'export {}\n')
    await symlink(source, join(nodeModules, 'example'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(join(source, 'index.js'), join(nodeModules, '.bin', 'example'), 'file')

    await materializeStagedLinks(nodeModules)

    expect(await readFile(join(nodeModules, 'example', 'index.js'), 'utf8')).toBe('export {}\n')
    await expect(verifySymlinkFree(join(root, 'stage'))).resolves.toBeUndefined()
  })

  it('仅允许仓库内不包含仓库根的 staging 目标', async () => {
    const root = await fixture()
    expect(() => { assertSafeStagingTarget(root, join(root, '.artifacts', 'desktop')) }).not.toThrow()
    expect(() => { assertSafeStagingTarget(root, root) }).toThrow(/拒绝清理/)
    expect(() => { assertSafeStagingTarget(root, join(tmpdir(), 'outside-runtime-staging')) })
      .toThrow(/必须位于仓库内/)
  })

  it('识别 ELF 与 PE 架构', () => {
    const elf = new Uint8Array(64)
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
    new DataView(elf.buffer).setUint16(18, 0xb7, true)
    expect(detectBinaryArchitectures(elf)).toEqual(['arm64'])

    const pe = new Uint8Array(128)
    pe.set([0x4d, 0x5a])
    const view = new DataView(pe.buffer)
    view.setUint32(0x3c, 64, true)
    view.setUint32(64, 0x00004550, true)
    view.setUint16(68, 0x8664, true)
    expect(detectBinaryArchitectures(pe)).toEqual(['x64'])
  })

  it('校验原生文件的架构与执行位', async () => {
    const root = await fixture()
    const helper = join(root, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper')
    await mkdir(join(helper, '..'), { recursive: true })
    const mach = new Uint8Array(32)
    const view = new DataView(mach.buffer)
    view.setUint32(0, 0xfeedfacf, false)
    view.setUint32(4, 0x0100000c, false)
    await writeFile(helper, mach)
    const dylib = join(root, 'node_modules', '@img', 'sharp-libvips-darwin-arm64', 'lib', 'libvips.dylib')
    await mkdir(join(dylib, '..'), { recursive: true })
    await writeFile(dylib, mach)
    await ensureKnownNativeExecutableModes(root, 'darwin', 'arm64')

    await expect(verifyNativeRuntimeFiles(root, 'darwin', 'arm64')).resolves.toEqual([
      {
        relativePath: 'node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips.dylib',
        kind: 'shared-library',
        architectures: ['arm64'],
      },
      {
        relativePath: 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
        kind: 'spawn-helper',
        architectures: ['arm64'],
      },
    ])
    await expect(verifyNativeRuntimeFiles(root, 'darwin', 'x64')).rejects.toThrow(/不包含目标架构/)
  })

  it('把 Linux Landlock launcher 纳入执行位与架构清单', async () => {
    const root = await fixture()
    const launcher = join(
      root, 'node_modules', '@deepseek-ai',
      'node-addon-landlock-run-linux-x64', 'bin', 'landlock-run',
    )
    await mkdir(join(launcher, '..'), { recursive: true })
    const elf = new Uint8Array(64)
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
    new DataView(elf.buffer).setUint16(18, 0x3e, true)
    await writeFile(launcher, elf)

    await ensureKnownNativeExecutableModes(root, 'linux', 'x64')
    await expect(verifyNativeRuntimeFiles(root, 'linux', 'x64')).resolves.toEqual([{
      relativePath: 'node_modules/@deepseek-ai/node-addon-landlock-run-linux-x64/bin/landlock-run',
      kind: 'landlock',
      architectures: ['x64'],
    }])
  })

  it('只保留 node-pty 的目标平台预编译目录', async () => {
    const root = await fixture()
    const prebuilds = join(root, 'node_modules', 'node-pty', 'prebuilds')
    const conpty = join(root, 'node_modules', 'node-pty', 'third_party', 'conpty', '1.0.0')
    await Promise.all(['darwin-arm64', 'darwin-x64', 'win32-x64'].map(name => (
      mkdir(join(prebuilds, name), { recursive: true })
    )))
    await Promise.all(['win10-arm64', 'win10-x64'].map(name => mkdir(join(conpty, name), { recursive: true })))

    await pruneKnownNativeVariants(root, 'darwin', 'arm64')

    await expect(readdir(prebuilds)).resolves.toEqual(['darwin-arm64'])
    await expect(readdir(join(root, 'node_modules', 'node-pty', 'third_party'))).resolves.toEqual([])
  })

  it('Windows 只保留目标架构的 node-pty ConPTY 运行库', async () => {
    const root = await fixture()
    const conpty = join(root, 'node_modules', 'node-pty', 'third_party', 'conpty', '1.0.0')
    await Promise.all(['win10-arm64', 'win10-x64'].map(name => mkdir(join(conpty, name), { recursive: true })))

    await pruneKnownNativeVariants(root, 'win32', 'x64')

    await expect(readdir(conpty)).resolves.toEqual(['win10-x64'])
  })

  it('拒绝缺失的工作区 peer，并允许显式排除载体专属 peer', async () => {
    const root = await fixture()
    const provider = join(root, 'node_modules', '@deepseek-ai', 'provider')
    await mkdir(provider, { recursive: true })
    await writeFile(join(provider, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/provider',
      peerDependencies: {
        '@deepseek-ai/contract': 'workspace:^',
        '@deepseek-ai/web-only': 'workspace:^',
      },
    }))

    await expect(verifyOwnedPeerClosure(root, ['@deepseek-ai/web-only']))
      .rejects.toThrow(/@deepseek-ai\/contract/)
    const contract = join(root, 'node_modules', '@deepseek-ai', 'contract')
    await mkdir(contract, { recursive: true })
    await writeFile(join(contract, 'package.json'), '{"name":"@deepseek-ai/contract"}')
    await expect(verifyOwnedPeerClosure(root, ['@deepseek-ai/web-only'])).resolves.toBeUndefined()
  })

  it('拒绝发布白名单漏掉的相对 JavaScript 运行时文件', async () => {
    const root = await fixture()
    const lib = join(root, 'node_modules', '@deepseek-ai', 'pkg', 'lib')
    await mkdir(lib, { recursive: true })
    await writeFile(join(lib, '..', 'package.json'), '{"name":"@deepseek-ai/pkg","main":"lib/index.js"}')
    await writeFile(join(lib, 'index.js'), "const typeName = \"import('./ghost.js')\"\nimport './chunk.js'\n")

    await expect(verifyJavaScriptRuntimeClosure(root)).rejects.toThrow(/chunk\.js/)
    await writeFile(join(lib, 'chunk.js'), 'export {}\n')
    await expect(verifyJavaScriptRuntimeClosure(root)).resolves.toBeUndefined()
  })
})
