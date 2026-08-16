import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireHostLease,
  bootProfileRuntime,
  prepareProfileRuntime,
  PROFILE_ROOT_FILENAME,
} from '../src/index.ts'

const roots: string[] = []

function fixture(): { root: string; home: string; installAnchor: string } {
  const root = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'dsh-profile-runtime-'))
  roots.push(root)
  const home = join(root, 'home')
  const app = join(root, 'app')
  const profile = join(home, 'profiles', 'test')
  mkdirSync(profile, { recursive: true })
  mkdirSync(app, { recursive: true })
  const installAnchor = join(app, 'package.json')
  writeFileSync(installAnchor, JSON.stringify({ name: 'fixture-app', version: '1.0.0' }))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'fixture-profile',
    private: true,
    dsh: { profile: { bundles: [] } },
  }))
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  return { root, home, installAnchor }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('process-neutral profile runtime', () => {
  it('统一准备 profile 根配置与补丁组合，不读取进程 signal 或退出语义', () => {
    const { home, installAnchor } = fixture()
    const runtime = prepareProfileRuntime({
      binName: 'fixture',
      profileName: 'test',
      installAnchor,
      home,
      overlays: [{ insert: [{ id: 'one', name: 'fixture:one' }] }],
    })

    expect(runtime.rootConfigPath).toBe(join(home, 'profiles', 'test', PROFILE_ROOT_FILENAME))
    expect(runtime.rows.get('one')?.name).toBe('fixture:one')
    expect(runtime.patches()).toEqual([{ insert: [{ id: 'one', name: 'fixture:one' }] }])
  })

  it('在任何 profile 写入和 Loader 创建前取得租约，并在根 Context 释放后最后释放', async () => {
    const { home, installAnchor } = fixture()
    const occupied = await acquireHostLease({ home, owner: { kind: 'cli', version: 'first' } })
    await expect(bootProfileRuntime({
      binName: 'fixture',
      profileName: 'test',
      installAnchor,
      home,
      owner: { kind: 'web', version: 'second' },
      watchUserPatches: false,
    })).rejects.toMatchObject({ code: 'HOST_LEASE_CONFLICT' })
    await occupied.release()

    const order: string[] = []
    const booted = await bootProfileRuntime({
      binName: 'fixture',
      profileName: 'test',
      installAnchor,
      home,
      owner: { kind: 'web', version: 'second' },
      watchUserPatches: false,
      prepare(ctx) {
        expect(ctx.hostLease.owner.kind).toBe('web')
        ctx.effect(() => () => { order.push('host-effects-disposed') })
      },
    })
    await expect(acquireHostLease({
      home,
      owner: { kind: 'cli', version: 'competitor' },
    })).rejects.toMatchObject({ code: 'HOST_LEASE_CONFLICT' })

    await booted.ctx.fiber.dispose()
    expect(order).toEqual(['host-effects-disposed'])
    const reacquired = await acquireHostLease({ home, owner: { kind: 'cli', version: 'after' } })
    await reacquired.release()
  })

  it('Host 准备失败时释放租约并保留原始启动错误', async () => {
    const { home, installAnchor } = fixture()
    await expect(bootProfileRuntime({
      binName: 'fixture',
      profileName: 'test',
      installAnchor,
      home,
      owner: { kind: 'cli', version: 'failed' },
      watchUserPatches: false,
      prepare() {
        throw new Error('fixture prepare failed')
      },
    })).rejects.toThrow('fixture prepare failed')

    const reacquired = await acquireHostLease({ home, owner: { kind: 'cli', version: 'after-failure' } })
    await reacquired.release()
  })
})
