import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HostLeaseError,
  acquireHostLease,
  canonicalizeHostHome,
  hostLeaseAddress,
} from '../src/host-lease.ts'

const roots: string[] = []
const children: ChildProcess[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'dsh-host-lease-'))
  roots.push(root)
  return root
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill(signal)
  await once(child, 'exit')
}

afterEach(async () => {
  await Promise.all(children.map(child => stopChild(child).catch(() => undefined)))
  children.length = 0
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.runIf(process.platform !== 'win32')('POSIX HostLease', () => {
  it('把同一真实 home 的符号链接路径归一为同一个租约键', () => {
    const root = temporaryRoot()
    const home = join(root, 'home')
    const alias = join(root, 'home-link')
    mkdirSync(home)
    symlinkSync(home, alias)

    const direct = canonicalizeHostHome(home)
    const linked = canonicalizeHostHome(alias)

    expect(linked).toEqual(direct)
    expect(hostLeaseAddress(direct)).toContain(join(home, '.runtime', 'host-'))
  })

  it('在一个 Host 持有时返回稳定冲突，并在释放后允许重新取得', async () => {
    const home = join(temporaryRoot(), 'home')
    const first = await acquireHostLease({
      home,
      owner: { kind: 'web', version: 'test' },
    })

    let conflict: unknown
    try {
      await acquireHostLease({ home, owner: { kind: 'cli', version: 'test' } })
    } catch (error) {
      conflict = error
    }
    expect(conflict).toBeInstanceOf(HostLeaseError)
    expect(conflict).toMatchObject({
      code: 'HOST_LEASE_CONFLICT',
      owner: { kind: 'web', pid: process.pid, version: 'test' },
    })

    await first.release()
    const next = await acquireHostLease({ home, owner: { kind: 'cli', version: 'test' } })
    await next.release()
  })

  it('长 home 使用私有短路径别名，正常释放后清除别名', async () => {
    const home = join(temporaryRoot(), 'very-long-profile-runtime-directory-name'.repeat(3))
    const lease = await acquireHostLease({ home, owner: { kind: 'cli', version: 'test' } })
    const canonical = canonicalizeHostHome(home)
    expect(canonical.addressDir).not.toBe(canonical.runtimeDir)
    expect(existsSync(canonical.addressDir)).toBe(true)

    await lease.release()

    expect(existsSync(canonical.addressDir)).toBe(false)
  })

  it('异常退出后只回收安全的残留 socket，并由新进程取得租约', async () => {
    const home = join(temporaryRoot(), 'home')
    const source = pathToFileURL(join(import.meta.dirname, '../src/host-lease.ts')).href
    const child = spawn(process.execPath, [
      '--import', 'tsx/esm', '--input-type=module', '-e',
      `import { acquireHostLease } from ${JSON.stringify(source)};
const lease = await acquireHostLease({ home: ${JSON.stringify(home)}, owner: { kind: 'desktop', version: 'test-child' } });
process.stdout.write('READY\\n');
setInterval(() => {}, 1000);
process.on('SIGTERM', async () => { await lease.release(); process.exit(0); });`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    await once(child.stdout, 'data')

    await expect(acquireHostLease({
      home,
      owner: { kind: 'cli', version: 'test-parent' },
    })).rejects.toMatchObject({ code: 'HOST_LEASE_CONFLICT' })

    await stopChild(child, 'SIGKILL')
    const recovered = await acquireHostLease({
      home,
      owner: { kind: 'cli', version: 'test-parent' },
    })
    await recovered.release()
  })

  it('多个回收者不能删除另一个启动者持有的清理互斥文件', async () => {
    const home = join(temporaryRoot(), 'home')
    const source = pathToFileURL(join(import.meta.dirname, '../src/host-lease.ts')).href
    const child = spawn(process.execPath, [
      '--import', 'tsx/esm', '--input-type=module', '-e',
      `import { acquireHostLease } from ${JSON.stringify(source)};
await acquireHostLease({ home: ${JSON.stringify(home)}, owner: { kind: 'desktop', version: 'stale-owner' } });
process.stdout.write('READY\\n');
setInterval(() => {}, 1000);`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    await once(child.stdout, 'data')
    await stopChild(child, 'SIGKILL')

    const canonical = canonicalizeHostHome(home)
    const cleanupPath = join(canonical.runtimeDir, `host-${canonical.key.slice(0, 20)}.cleanup`)
    writeFileSync(cleanupPath, 'active-cleaner\n', { mode: 0o600 })
    const contenders = await Promise.allSettled([
      acquireHostLease({ home, owner: { kind: 'cli', version: 'contender-a' } }),
      acquireHostLease({ home, owner: { kind: 'web', version: 'contender-b' } }),
    ])

    expect(contenders.every(result => result.status === 'rejected')).toBe(true)
    expect(readFileSync(cleanupPath, 'utf8')).toBe('active-cleaner\n')
  })

  it('拒绝不安全的 runtime 目录以及普通文件或符号链接端点，且不删除它们', async () => {
    const root = temporaryRoot()
    const insecureHome = join(root, 'insecure-home')
    mkdirSync(join(insecureHome, '.runtime'), { recursive: true, mode: 0o755 })
    chmodSync(join(insecureHome, '.runtime'), 0o755)
    await expect(acquireHostLease({
      home: insecureHome,
      owner: { kind: 'cli', version: 'test' },
    })).rejects.toMatchObject({ code: 'HOST_LEASE_UNSAFE_PATH' })

    const fileHome = join(root, 'file-home')
    const canonical = canonicalizeHostHome(fileHome)
    const address = hostLeaseAddress(canonical)
    writeFileSync(address, 'do not delete')
    await expect(acquireHostLease({
      home: fileHome,
      owner: { kind: 'cli', version: 'test' },
    })).rejects.toMatchObject({ code: 'HOST_LEASE_UNSAFE_PATH' })
    expect(existsSync(address)).toBe(true)

    rmSync(address)
    const target = join(root, 'target')
    writeFileSync(target, 'target')
    symlinkSync(target, address)
    await expect(acquireHostLease({
      home: fileHome,
      owner: { kind: 'cli', version: 'test' },
    })).rejects.toMatchObject({ code: 'HOST_LEASE_UNSAFE_PATH' })
    expect(existsSync(address)).toBe(true)
  })
})

describe.runIf(process.platform === 'win32')('Windows HostLease', () => {
  it('以当前用户 SID 和 home 摘要命名 pipe，并保持独占直至释放', async () => {
    const home = join(temporaryRoot(), 'home')
    const first = await acquireHostLease({ home, owner: { kind: 'desktop', version: 'test' } })
    expect(first.address).toMatch(/^\\\\\.\\pipe\\dsh-host-[a-f0-9]{32}$/)
    await expect(acquireHostLease({
      home,
      owner: { kind: 'cli', version: 'test' },
    })).rejects.toMatchObject({
      code: 'HOST_LEASE_CONFLICT',
      owner: { kind: 'desktop', pid: process.pid },
    })

    await first.release()
    const next = await acquireHostLease({ home, owner: { kind: 'cli', version: 'test' } })
    await next.release()
  })
})
