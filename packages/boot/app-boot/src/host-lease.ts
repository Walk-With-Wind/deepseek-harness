/** 每个规范化 DSH_HOME 的跨进程独占 Host 租约。 */
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readlinkSync,
  unlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createConnection, createServer, type Server } from 'node:net'
import { userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import {
  WINDOWS_OWNER_ACKNOWLEDGEMENT,
  WindowsOwnerPipeError,
  createWindowsOwnerListener,
} from './windows-host-lease.ts'

const LEASE_PROTOCOL_VERSION = 1
const OWNER_RESPONSE_LIMIT = 4096
const PROBE_TIMEOUT_MS = 750
const RUNTIME_DIRECTORY = '.runtime'

/** 租约获取失败的稳定错误码。 */
export type HostLeaseErrorCode =
  | 'HOST_LEASE_CONFLICT'
  | 'HOST_LEASE_UNSAFE_PATH'
  | 'HOST_LEASE_UNAVAILABLE'

/** 可向冲突方披露的租约 owner 摘要。 */
export interface HostLeaseOwnerSummary {
  /** Host 产品类型。 */
  readonly kind: 'cli' | 'web' | 'desktop'
  /** Host 所属 DSH 版本。 */
  readonly version: string
  /** 当前 owner 的进程号。 */
  readonly pid: number
  /** ISO 8601 启动时间。 */
  readonly startedAt: string
  /** 随机 nonce 的不可逆短摘要。 */
  readonly nonceDigest: string
}

/** 调用方提供的 owner 身份；进程字段由租约实现生成。 */
export interface HostLeaseOwner {
  /** Host 产品类型。 */
  readonly kind: HostLeaseOwnerSummary['kind']
  /** Host 所属 DSH 版本。 */
  readonly version: string
}

/** 经过 realpath 归一并摘要后的 Harness home。 */
export interface CanonicalHostHome {
  /** 真实且绝对的 Harness home。 */
  readonly path: string
  /** 不暴露路径的稳定 SHA-256 摘要。 */
  readonly key: string
  /** POSIX 租约端点所在的私有目录。 */
  readonly runtimeDir: string
  /** 传给 sockaddr_un 的有界路径目录；长 home 时是指向 runtimeDir 的私有短别名。 */
  readonly addressDir: string
}

/** 成功持有的 Host 租约。 */
export interface HostLease {
  /** 当前 owner 的只读身份摘要。 */
  readonly owner: HostLeaseOwnerSummary
  /** 用于诊断的 socket 或 named-pipe 地址。 */
  readonly address: string
  /** 幂等关闭 listener，并在安全时清除自身平台端点。 */
  release(): Promise<void>
}

/** Host 租约失败，调用方可按稳定 code 映射用户体验。 */
export class HostLeaseError extends Error {
  /**
   * @param code - 稳定失败分类。
   * @param message - 不包含敏感 home 路径的用户可诊断消息。
   * @param owner - 冲突 owner 可披露摘要。
   * @param cause - 原始系统错误。
   */
  constructor(
    readonly code: HostLeaseErrorCode,
    message: string,
    readonly owner?: HostLeaseOwnerSummary,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options)
    this.name = 'HostLeaseError'
  }
}

/** 获取 Host 租约的输入。 */
export interface AcquireHostLeaseOptions {
  /** 待归一化的 Harness home。 */
  readonly home: string
  /** 产品 owner 身份。 */
  readonly owner: HostLeaseOwner
}

/**
 * 建立或校验 owner-only runtime 目录，并返回规范化 home。
 * @param home - 待规范化的 Harness home。
 * @returns 真实路径、稳定摘要与平台端点目录。
 */
export function canonicalizeHostHome(home: string): CanonicalHostHome {
  mkdirSync(resolve(home), { recursive: true, mode: 0o700 })
  const path = realpathSync.native(resolve(home))
  const runtimeDir = join(path, RUNTIME_DIRECTORY)
  if (!existsSync(runtimeDir)) mkdirSync(runtimeDir, { mode: 0o700 })
  const runtime = lstatSync(runtimeDir)
  if (!runtime.isDirectory() || runtime.isSymbolicLink()) {
    throw unsafePath('Host lease runtime path must be a real directory')
  }
  if (typeof process.getuid === 'function' && runtime.uid !== process.getuid()) {
    throw unsafePath('Host lease runtime directory is owned by another user')
  }
  if (process.platform !== 'win32' && (runtime.mode & 0o077) !== 0) {
    throw unsafePath('Host lease runtime directory must grant access only to its owner')
  }
  const key = digest(path)
  return {
    path,
    key,
    runtimeDir,
    addressDir: process.platform === 'win32' ? runtimeDir : resolvePosixAddressDir(runtimeDir, key),
  }
}

/**
 * 从规范化 home 派生不接受用户输入片段的端点地址。
 * @param home - 已规范化的 Harness home。
 * @returns 当前平台的 Unix socket 或 Windows named-pipe 地址。
 */
export function hostLeaseAddress(home: CanonicalHostHome): string {
  if (process.platform !== 'win32') {
    return join(home.addressDir, `host-${home.key.slice(0, 20)}.sock`)
  }
  const sid = currentWindowsSid()
  return `\\\\.\\pipe\\dsh-host-${digest(`${sid}\0${home.key}`).slice(0, 32)}`
}

function resolvePosixAddressDir(runtimeDir: string, key: string): string {
  const directAddress = join(runtimeDir, `host-${key.slice(0, 20)}.sock`)
  if (Buffer.byteLength(directAddress) <= 100) return runtimeDir
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid
  const base = join('/tmp', `dsh-host-lease-${String(uid)}`)
  if (!existsSync(base)) mkdirSync(base, { mode: 0o700 })
  const baseStat = lstatSync(base)
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()
    || baseStat.uid !== uid || (baseStat.mode & 0o077) !== 0) {
    throw unsafePath('Host lease short-path directory is not a private directory owned by the current user')
  }
  const alias = join(base, `home-${key.slice(0, 20)}`)
  try {
    symlinkSync(runtimeDir, alias, 'dir')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable('Host lease short-path alias could not be created', error)
  }
  const aliasStat = lstatSync(alias)
  if (!aliasStat.isSymbolicLink() || realpathSync.native(alias) !== runtimeDir) {
    throw unsafePath('Host lease short-path alias does not resolve to the canonical Harness runtime directory')
  }
  // 读取一次链接可同时验证它不是平台不支持的目录 junction 表现；真实归属仍由 realpath 判定。
  readlinkSync(alias)
  return alias
}

/**
 * 取得一个规范化 DSH_HOME 的独占 Host listener。
 * @param options - Harness home 与产品 owner 身份。
 * @returns 已经持有平台端点且可幂等释放的租约。
 */
export async function acquireHostLease(options: AcquireHostLeaseOptions): Promise<HostLease> {
  const home = canonicalizeHostHome(options.home)
  const address = hostLeaseAddress(home)
  const owner = createOwner(options.owner)
  if (process.platform === 'win32') {
    return acquireWindowsHostLease(address, owner)
  }
  const server = createOwnerServer(owner)

  try {
    await listen(server, address)
  } catch (error) {
    if (!isAddressInUse(error)) {
      throw unavailable('Host lease listener could not start', error)
    }
    const probe = await probeOwner(address)
    if (probe.kind === 'alive') {
      throw conflict(probe.owner)
    }
    await reclaimPosixSocket(home, address, server, owner)
  }

  try {
    const socketIdentity = readSocketIdentity(address)
    return createLease(server, address, owner, socketIdentity, home)
  } catch (error) {
    await closeServer(server)
    throw error
  }
}

async function acquireWindowsHostLease(
  address: string,
  owner: HostLeaseOwnerSummary,
): Promise<HostLease> {
  try {
    const listener = await createWindowsOwnerListener({
      address,
      sid: currentWindowsSid(),
      payload: new TextEncoder().encode(ownerPayload(owner)),
    })
    return { owner, address, release: () => listener.release() }
  } catch (error) {
    if (!(error instanceof WindowsOwnerPipeError) || !error.addressInUse) {
      throw unavailable('Host lease named pipe could not start with its protected DACL', error)
    }
    const probe = await probeOwner(address)
    if (probe.kind === 'alive') throw conflict(probe.owner)
    throw unavailable('Host lease named pipe is unavailable and cannot be reclaimed safely', probe.error)
  }
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function createOwner(owner: HostLeaseOwner): HostLeaseOwnerSummary {
  if (owner.version === '' || owner.version.length > 128) {
    throw unavailable('Host lease owner version must contain 1 to 128 characters')
  }
  return {
    kind: owner.kind,
    version: owner.version,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    nonceDigest: digest(randomBytes(32)).slice(0, 24),
  }
}

function createOwnerServer(owner: HostLeaseOwnerSummary): Server {
  const payload = ownerPayload(owner)
  const server = createServer((socket) => {
    socket.end(payload)
  })
  // listener 建立后的系统错误由下一次启动重新诊断；这里避免 EventEmitter 无监听器终止进程。
  server.on('error', () => {})
  return server
}

function ownerPayload(owner: HostLeaseOwnerSummary): string {
  return `${JSON.stringify({ protocolVersion: LEASE_PROTOCOL_VERSION, owner })}\n`
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ path: address, exclusive: true })
  })
}

type ProbeResult =
  | { readonly kind: 'alive'; readonly owner?: HostLeaseOwnerSummary }
  | { readonly kind: 'stale'; readonly error: unknown }

function probeOwner(address: string): Promise<ProbeResult> {
  return new Promise((resolveProbe) => {
    const socket = createConnection(address)
    const chunks: Buffer[] = []
    let bytes = 0
    let connected = false
    let settled = false
    const settle = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveProbe(result)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.on('connect', () => { connected = true })
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > OWNER_RESPONSE_LIMIT) {
        settle({ kind: 'alive' })
        return
      }
      chunks.push(chunk)
      if (process.platform === 'win32' && chunk.includes(0x0A)) {
        const owner = parseOwner(Buffer.concat(chunks).toString('utf8'))
        socket.write(Buffer.from([WINDOWS_OWNER_ACKNOWLEDGEMENT]), () => {
          settle(owner === undefined ? { kind: 'alive' } : { kind: 'alive', owner })
        })
      }
    })
    socket.on('end', () => {
      const owner = parseOwner(Buffer.concat(chunks).toString('utf8'))
      settle(owner === undefined ? { kind: 'alive' } : { kind: 'alive', owner })
    })
    socket.on('timeout', () => {
      settle(connected ? { kind: 'alive' } : { kind: 'stale', error: new Error('Host lease probe timed out') })
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (!connected && (error.code === 'ECONNREFUSED' || error.code === 'ENOENT')) {
        settle({ kind: 'stale', error })
      } else {
        settle(connected ? { kind: 'alive' } : { kind: 'stale', error })
      }
    })
  })
}

function parseOwner(text: string): HostLeaseOwnerSummary | undefined {
  try {
    const value = JSON.parse(text.trim()) as unknown
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (record.protocolVersion !== LEASE_PROTOCOL_VERSION
      || typeof record.owner !== 'object' || record.owner === null) return undefined
    const owner = record.owner as Record<string, unknown>
    if ((owner.kind !== 'cli' && owner.kind !== 'web' && owner.kind !== 'desktop')
      || typeof owner.version !== 'string' || owner.version === '' || owner.version.length > 128
      || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.startedAt !== 'string' || !Number.isFinite(Date.parse(owner.startedAt))
      || typeof owner.nonceDigest !== 'string' || !/^[a-f0-9]{24}$/.test(owner.nonceDigest)) return undefined
    return {
      kind: owner.kind,
      version: owner.version,
      pid: owner.pid,
      startedAt: owner.startedAt,
      nonceDigest: owner.nonceDigest,
    }
  } catch {
    // 活 listener 即构成冲突；畸形身份只是不披露 owner，不改变所有权判断。
    return undefined
  }
}

async function reclaimPosixSocket(
  home: CanonicalHostHome,
  address: string,
  server: Server,
  owner: HostLeaseOwnerSummary,
): Promise<void> {
  const cleanupPath = join(home.runtimeDir, `host-${home.key.slice(0, 20)}.cleanup`)
  let cleanupFd: number | undefined
  let cleanupOwned = false
  try {
    cleanupFd = openSync(cleanupPath, 'wx', 0o600)
    cleanupOwned = true
    writeFileSync(cleanupFd, `${JSON.stringify({ pid: process.pid, nonceDigest: owner.nonceDigest })}\n`)
  } catch (error) {
    if (cleanupFd !== undefined) closeSync(cleanupFd)
    // 只有创建成功的启动者拥有该路径；EEXIST 表示另一个回收者仍持有互斥权。
    if (cleanupOwned) {
      try {
        unlinkSync(cleanupPath)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw unavailable('Host lease stale-socket cleanup lock could not be reset', cleanupError)
        }
      }
    }
    throw unavailable('Host lease stale-socket cleanup is already in progress; retry after the competing startup finishes', error)
  }
  try {
    const before = readSocketIdentity(address)
    const secondProbe = await probeOwner(address)
    if (secondProbe.kind === 'alive') throw conflict(secondProbe.owner)
    const after = readSocketIdentity(address)
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw unsafePath('Host lease endpoint changed while stale cleanup was in progress')
    }
    unlinkSync(address)
    try {
      await listen(server, address)
    } catch (error) {
      if (!isAddressInUse(error)) throw unavailable('Host lease listener could not start after stale cleanup', error)
      const winner = await probeOwner(address)
      if (winner.kind === 'alive') throw conflict(winner.owner)
      throw unavailable('Host lease endpoint remained unavailable after one stale cleanup attempt', winner.error)
    }
  } finally {
    closeSync(cleanupFd)
    try {
      unlinkSync(cleanupPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

interface SocketIdentity {
  readonly dev: number
  readonly ino: number
  readonly uid: number
}

function readSocketIdentity(address: string): SocketIdentity {
  let stat
  try {
    stat = lstatSync(address)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw unavailable('Host lease endpoint disappeared during ownership validation', error)
    }
    throw unavailable('Host lease endpoint could not be inspected', error)
  }
  if (stat.isSymbolicLink() || !stat.isSocket()) {
    throw unsafePath('Host lease endpoint is not a real Unix-domain socket')
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw unsafePath('Host lease endpoint is owned by another user')
  }
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid }
}

function createLease(
  server: Server,
  address: string,
  owner: HostLeaseOwnerSummary,
  socketIdentity: SocketIdentity | undefined,
  home: CanonicalHostHome,
): HostLease {
  let releasing: Promise<void> | undefined
  return {
    owner,
    address,
    release() {
      releasing ??= closeServer(server).then(() => {
        if (socketIdentity === undefined) return
        const physicalAddress = join(home.runtimeDir, `host-${home.key.slice(0, 20)}.sock`)
        try {
          const current = lstatSync(physicalAddress)
          if (current.isSocket() && current.dev === socketIdentity.dev && current.ino === socketIdentity.ino) {
            unlinkSync(physicalAddress)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        removeUnusedAddressAlias(home, physicalAddress)
      })
      return releasing
    },
  }
}

function removeUnusedAddressAlias(home: CanonicalHostHome, physicalAddress: string): void {
  if (home.addressDir === home.runtimeDir || existsSync(physicalAddress)) return
  try {
    const alias = lstatSync(home.addressDir)
    if (alias.isSymbolicLink() && realpathSync.native(home.addressDir) === home.runtimeDir) {
      unlinkSync(home.addressDir)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose()
      else rejectClose(error)
    })
  })
}

function currentWindowsSid(): string {
  if (process.platform !== 'win32') return `${String(userInfo().uid)}:${userInfo().username}`
  try {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const output = execFileSync(join(systemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
    })
    const sid = output.match(/S-\d+(?:-\d+)+/)?.[0]
    if (sid === undefined) throw new Error('whoami returned no SID')
    return sid
  } catch (error) {
    throw unavailable('Host lease could not determine the current Windows user SID', error)
  }
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
}

function conflict(owner: HostLeaseOwnerSummary | undefined): HostLeaseError {
  const detail = owner === undefined
    ? 'another live Host'
    : `${owner.kind} Host pid ${String(owner.pid)} (version ${owner.version})`
  return new HostLeaseError(
    'HOST_LEASE_CONFLICT',
    `Harness home is already in use by ${detail}. Close that Host and retry; the competing process was not modified.`,
    owner,
  )
}

function unsafePath(message: string): HostLeaseError {
  return new HostLeaseError('HOST_LEASE_UNSAFE_PATH', message)
}

function unavailable(message: string, cause?: unknown): HostLeaseError {
  return new HostLeaseError('HOST_LEASE_UNAVAILABLE', message, undefined, { cause })
}
