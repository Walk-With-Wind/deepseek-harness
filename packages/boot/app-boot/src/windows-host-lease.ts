/** 创建时即受 DACL 保护的 Windows Host owner 命名管道。 */

import type { KoffiFunc, TypeObject } from 'koffi'

const ERROR_ACCESS_DENIED = 5
const ERROR_BROKEN_PIPE = 109
const ERROR_PIPE_BUSY = 231
const ERROR_NO_DATA = 232
const ERROR_IO_PENDING = 997
const ERROR_OPERATION_ABORTED = 995
const ERROR_PIPE_CONNECTED = 535
const ERROR_ALREADY_EXISTS = 183
const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x0008_0000
const FILE_FLAG_OVERLAPPED = 0x4000_0000
const PIPE_ACCESS_DUPLEX = 0x0000_0003
const PIPE_READMODE_BYTE = 0x0000_0000
const PIPE_TYPE_BYTE = 0x0000_0000
const PIPE_WAIT = 0x0000_0000
const PIPE_REJECT_REMOTE_CLIENTS = 0x0000_0008
const PIPE_BUFFER_BYTES = 4096
const WAIT_OBJECT_0 = 0
const WAIT_FAILED = 0xFFFF_FFFF
const INFINITE = 0xFFFF_FFFF
const SDDL_REVISION_1 = 1
const OWNER_ACKNOWLEDGEMENT = 0x06

/** Windows owner pipe 完成一轮身份读取后的确认字节。 */
export const WINDOWS_OWNER_ACKNOWLEDGEMENT = OWNER_ACKNOWLEDGEMENT

/** 已经创建且持有内核所有权的 Windows pipe。 */
export interface WindowsOwnerPipe {
  /** 等待下一位本机客户端连接。 */
  connect(): Promise<void>
  /** 向当前客户端写入完整 owner 载荷。 */
  write(payload: Uint8Array): Promise<void>
  /** 等待客户端确认完整读取 owner 载荷。 */
  readAcknowledgement(): Promise<void>
  /** 断开当前客户端，使同一 pipe 实例可继续接受连接。 */
  disconnect(): void
  /** 取消当前未完成的 overlapped 操作。 */
  cancel(): void
  /** 关闭事件与 pipe 句柄。 */
  close(): void
}

/** Windows pipe 的平台创建适配器。 */
export interface WindowsOwnerPipePlatform {
  /**
   * @param address - 固定前缀且经过摘要的命名管道地址。
   * @param sddl - 创建时应用的受保护 DACL。
   * @returns 已持有唯一 pipe 实例的对象。
   */
  create(address: string, sddl: string): WindowsOwnerPipe
}

/** Windows owner listener 创建参数。 */
export interface CreateWindowsOwnerListenerOptions {
  /** 命名管道地址。 */
  readonly address: string
  /** 当前用户 SID。 */
  readonly sid: string
  /** 有界且以换行结尾的 owner 载荷。 */
  readonly payload: Uint8Array
  /** 测试或平台层注入；生产环境按需载入 Koffi。 */
  readonly platform?: WindowsOwnerPipePlatform
  /** listener 异常退出时的 fail-loud 接收器。 */
  readonly onFatal?: (error: unknown) => void
}

/** Windows owner listener 的最小生命周期。 */
export interface WindowsOwnerListener {
  /** 幂等取消等待并关闭内核句柄。 */
  release(): Promise<void>
}

/**
 * 生成仅允许 SYSTEM 与当前用户完全访问的受保护 DACL。
 * @param sid - 已读取的当前 Windows 用户 SID。
 * @returns 可直接传给安全描述符解析 API 的 SDDL。
 */
export function windowsOwnerPipeSddl(sid: string): string {
  if (!/^S-\d+(?:-\d+)+$/.test(sid)) {
    throw new Error('Host lease Windows SID is invalid')
  }
  return `D:P(A;;GA;;;SY)(A;;GA;;;${sid})`
}

/**
 * 创建 Windows owner listener；端点发布前已经带有最终 DACL。
 * @param options - 地址、SID、owner 载荷与可替换平台实现。
 * @returns 已开始接受本机 owner 探测的 listener。
 */
export async function createWindowsOwnerListener(
  options: CreateWindowsOwnerListenerOptions,
): Promise<WindowsOwnerListener> {
  const platform = options.platform ?? await loadWindowsOwnerPipePlatform()
  const pipe = platform.create(options.address, windowsOwnerPipeSddl(options.sid))
  const lifecycle = { stopping: false }
  const isStopping = (): boolean => lifecycle.stopping
  let released: Promise<void> | undefined
  const onFatal = options.onFatal ?? failLoud

  const serving = (async () => {
    try {
      while (!isStopping()) {
        try {
          await pipe.connect()
        } catch (error) {
          if (isStopping()) break
          if (error instanceof WindowsPipeClientError) continue
          throw error
        }
        if (isStopping()) break
        try {
          await pipe.write(options.payload)
          await pipe.readAcknowledgement()
        } catch (error) {
          if (!isStopping() && !(error instanceof WindowsPipeClientError)) throw error
        } finally {
          pipe.disconnect()
        }
      }
    } finally {
      pipe.close()
    }
  })()
  void serving.catch(onFatal)

  return {
    release() {
      released ??= (async () => {
        lifecycle.stopping = true
        let cancelError: Error | undefined
        try {
          pipe.cancel()
        } catch (error) {
          cancelError = errorValue(error)
          // 取消 API 自身失败时直接关闭句柄，避免 listener 永久阻塞应用退出。
          pipe.close()
        }
        await serving.catch(() => undefined)
        if (cancelError !== undefined) throw cancelError
      })()
      return released
    },
  }
}

function failLoud(error: unknown): void {
  process.nextTick(() => { throw errorValue(error) })
}

/** 把原生 callback 或平台替身给出的未知失败收敛为 Error。 */
function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

class WindowsPipeClientError extends Error {}

/** 原生调用失败，并保留 Win32 error code 供租约层稳定分类。 */
export class WindowsOwnerPipeError extends Error {
  /**
   * @param code - `GetLastError()` 返回值。
   * @param operation - 失败的 Win32 API。
   */
  constructor(readonly code: number, operation: string) {
    super(`${operation} failed with Win32 error ${String(code)}`)
    this.name = 'WindowsOwnerPipeError'
  }

  /** 该错误是否表示同名 pipe 已由另一进程持有。 */
  get addressInUse(): boolean {
    return this.code === ERROR_ACCESS_DENIED
      || this.code === ERROR_PIPE_BUSY
      || this.code === ERROR_ALREADY_EXISTS
  }
}

type NativePointer = bigint | null

interface WindowsFunctions {
  readonly getLastError: KoffiFunc<() => number>
  readonly localFree: KoffiFunc<(memory: NativePointer) => NativePointer>
  readonly closeHandle: KoffiFunc<(handle: NativePointer) => number>
  readonly createEventW: KoffiFunc<(
    attributes: null, manualReset: number, initialState: number, name: null,
  ) => NativePointer>
  readonly resetEvent: KoffiFunc<(event: NativePointer) => number>
  readonly waitForSingleObject: KoffiFunc<(handle: NativePointer, milliseconds: number) => number>
  readonly cancelIoEx: KoffiFunc<(handle: NativePointer, overlapped: NativePointer | null) => number>
  readonly disconnectNamedPipe: KoffiFunc<(pipe: NativePointer) => number>
  readonly connectNamedPipe: KoffiFunc<(pipe: NativePointer, overlapped: NativePointer) => number>
  readonly writeFile: KoffiFunc<(
    file: NativePointer, buffer: Uint8Array, bytes: number,
    written: NativePointer, overlapped: NativePointer,
  ) => number>
  readonly readFile: KoffiFunc<(
    file: NativePointer, buffer: Uint8Array, bytes: number,
    read: NativePointer, overlapped: NativePointer,
  ) => number>
  readonly getOverlappedResult: KoffiFunc<(
    file: NativePointer, overlapped: NativePointer, transferred: NativePointer, wait: number,
  ) => number>
  readonly convertStringSecurityDescriptorToSecurityDescriptorW: KoffiFunc<(
    sddl: string, revision: number, descriptor: NativePointer, size: null,
  ) => number>
  readonly createNamedPipeW: KoffiFunc<(
    address: string, openMode: number, pipeMode: number, maxInstances: number,
    outBufferSize: number, inBufferSize: number, timeout: number, attributes: NativePointer,
  ) => NativePointer>
}

interface KoffiRuntime {
  readonly pointer: (type: string | TypeObject) => TypeObject
  readonly struct: (name: string, fields: Record<string, string | TypeObject>) => TypeObject
  readonly alloc: (type: string | TypeObject, count: number) => NativePointer
  readonly encode: (pointer: NativePointer, type: string | TypeObject, value: unknown) => void
  readonly decode: (pointer: NativePointer, type: string | TypeObject) => unknown
  readonly load: (path: string) => {
    func<T extends (...args: never[]) => unknown>(
      convention: string, name: string, result: string | TypeObject,
      parameters: Array<string | TypeObject>,
    ): KoffiFunc<T>
  }
}

async function loadWindowsOwnerPipePlatform(): Promise<WindowsOwnerPipePlatform> {
  if (process.platform !== 'win32') {
    throw new Error('Windows Host lease pipe is only available on Windows')
  }
  const koffi = (await import('koffi')).default as unknown as KoffiRuntime
  return createNativeWindowsPlatform(koffi)
}

function createNativeWindowsPlatform(koffi: KoffiRuntime): WindowsOwnerPipePlatform {
  const voidPointer = koffi.pointer('void')
  const securityAttributes = koffi.struct('DSH_SECURITY_ATTRIBUTES', {
    nLength: 'uint32',
    lpSecurityDescriptor: voidPointer,
    bInheritHandle: 'int32',
  })
  const overlapped = koffi.struct('DSH_OVERLAPPED', {
    Internal: 'uintptr_t',
    InternalHigh: 'uintptr_t',
    Offset: 'uint32',
    OffsetHigh: 'uint32',
    hEvent: voidPointer,
  })
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const bind = <T extends (...args: never[]) => unknown>(
    library: ReturnType<KoffiRuntime['load']>, name: string,
    result: string | TypeObject, parameters: Array<string | TypeObject>,
  ): KoffiFunc<T> => library.func<T>('__stdcall', name, result, parameters)
  const functions: WindowsFunctions = {
    getLastError: bind(kernel32, 'GetLastError', 'uint32', []),
    localFree: bind(kernel32, 'LocalFree', voidPointer, [voidPointer]),
    closeHandle: bind(kernel32, 'CloseHandle', 'int', [voidPointer]),
    createEventW: bind(kernel32, 'CreateEventW', voidPointer, [voidPointer, 'int', 'int', 'str16']),
    resetEvent: bind(kernel32, 'ResetEvent', 'int', [voidPointer]),
    waitForSingleObject: bind(kernel32, 'WaitForSingleObject', 'uint32', [voidPointer, 'uint32']),
    cancelIoEx: bind(kernel32, 'CancelIoEx', 'int', [voidPointer, voidPointer]),
    disconnectNamedPipe: bind(kernel32, 'DisconnectNamedPipe', 'int', [voidPointer]),
    connectNamedPipe: bind(kernel32, 'ConnectNamedPipe', 'int', [voidPointer, koffi.pointer(overlapped)]),
    writeFile: bind(kernel32, 'WriteFile', 'int', [
      voidPointer, koffi.pointer('uint8'), 'uint32', koffi.pointer('uint32'), koffi.pointer(overlapped),
    ]),
    readFile: bind(kernel32, 'ReadFile', 'int', [
      voidPointer, koffi.pointer('uint8'), 'uint32', koffi.pointer('uint32'), koffi.pointer(overlapped),
    ]),
    getOverlappedResult: bind(kernel32, 'GetOverlappedResult', 'int', [
      voidPointer, koffi.pointer(overlapped), koffi.pointer('uint32'), 'int',
    ]),
    convertStringSecurityDescriptorToSecurityDescriptorW: bind(
      advapi32,
      'ConvertStringSecurityDescriptorToSecurityDescriptorW',
      'int',
      ['str16', 'uint32', koffi.pointer(voidPointer), voidPointer],
    ),
    createNamedPipeW: bind(kernel32, 'CreateNamedPipeW', voidPointer, [
      'str16', 'uint32', 'uint32', 'uint32', 'uint32', 'uint32', 'uint32', koffi.pointer(securityAttributes),
    ]),
  }
  return {
    create(address, sddl) {
      return new NativeWindowsOwnerPipe(koffi, functions, securityAttributes, overlapped, address, sddl)
    },
  }
}

class NativeWindowsOwnerPipe implements WindowsOwnerPipe {
  private readonly pipe: NativePointer
  private readonly event: NativePointer
  private readonly overlappedMemory: NativePointer
  private closed = false

  constructor(
    private readonly koffi: KoffiRuntime,
    private readonly api: WindowsFunctions,
    securityAttributes: TypeObject,
    private readonly overlapped: TypeObject,
    address: string,
    sddl: string,
  ) {
    const descriptorSlot = this.koffi.alloc(this.koffi.pointer('void'), 1)
    checkBoolean(
      this.api,
      this.api.convertStringSecurityDescriptorToSecurityDescriptorW(
        sddl, SDDL_REVISION_1, descriptorSlot, null,
      ),
      'ConvertStringSecurityDescriptorToSecurityDescriptorW',
    )
    const descriptor = this.koffi.decode(descriptorSlot, this.koffi.pointer('void')) as NativePointer
    const attributes = this.koffi.alloc(securityAttributes, 1)
    this.koffi.encode(attributes, securityAttributes, {
      nLength: securityAttributes.size,
      lpSecurityDescriptor: descriptor,
      bInheritHandle: 0,
    })
    let pipe: NativePointer = null
    try {
      pipe = this.api.createNamedPipeW(
        address,
        PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1,
        PIPE_BUFFER_BYTES,
        PIPE_BUFFER_BYTES,
        0,
        attributes,
      )
      if (isInvalidHandle(pipe)) throw new WindowsOwnerPipeError(this.api.getLastError(), 'CreateNamedPipeW')
    } finally {
      const freed = this.api.localFree(descriptor)
      if (!isNullPointer(freed)) {
        const code = this.api.getLastError()
        if (!isInvalidHandle(pipe)) this.api.closeHandle(pipe)
        throw new WindowsOwnerPipeError(code, 'LocalFree')
      }
    }
    this.pipe = pipe
    this.event = this.api.createEventW(null, 1, 0, null)
    if (isNullPointer(this.event)) {
      const code = this.api.getLastError()
      this.api.closeHandle(this.pipe)
      throw new WindowsOwnerPipeError(code, 'CreateEventW')
    }
    this.overlappedMemory = this.koffi.alloc(this.overlapped, 1)
    this.resetOverlapped()
  }

  async connect(): Promise<void> {
    this.resetOverlapped()
    if (this.api.connectNamedPipe(this.pipe, this.overlappedMemory) !== 0) return
    const code = this.api.getLastError()
    if (code === ERROR_PIPE_CONNECTED) return
    if (code !== ERROR_IO_PENDING) throw clientOrSystemError(code, 'ConnectNamedPipe')
    await this.finishOverlapped('ConnectNamedPipe')
  }

  async write(payload: Uint8Array): Promise<void> {
    await this.transfer('WriteFile', payload, bytes => (
      this.api.writeFile(this.pipe, payload, payload.byteLength, bytes, this.overlappedMemory)
    ))
  }

  async readAcknowledgement(): Promise<void> {
    const acknowledgement = new Uint8Array(1)
    await this.transfer('ReadFile', acknowledgement, bytes => (
      this.api.readFile(this.pipe, acknowledgement, 1, bytes, this.overlappedMemory)
    ))
    if (acknowledgement[0] !== OWNER_ACKNOWLEDGEMENT) {
      throw new WindowsPipeClientError('Host lease client sent an invalid acknowledgement')
    }
  }

  disconnect(): void {
    if (this.closed) return
    if (this.api.disconnectNamedPipe(this.pipe) === 0) {
      const code = this.api.getLastError()
      if (code !== ERROR_NO_DATA && code !== ERROR_BROKEN_PIPE) {
        throw new WindowsOwnerPipeError(code, 'DisconnectNamedPipe')
      }
    }
  }

  cancel(): void {
    if (this.closed) return
    if (this.api.cancelIoEx(this.pipe, null) === 0) {
      const code = this.api.getLastError()
      // 当前没有未完成 I/O 时 ERROR_NOT_FOUND 不影响关闭。
      if (code !== 1168) throw new WindowsOwnerPipeError(code, 'CancelIoEx')
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const eventResult = this.api.closeHandle(this.event)
    const pipeResult = this.api.closeHandle(this.pipe)
    if (eventResult === 0 || pipeResult === 0) {
      throw new WindowsOwnerPipeError(this.api.getLastError(), 'CloseHandle')
    }
  }

  private async transfer(
    operation: string,
    buffer: Uint8Array,
    begin: (transferred: NativePointer) => number,
  ): Promise<void> {
    this.resetOverlapped()
    const transferred = this.koffi.alloc('uint32', 1)
    if (begin(transferred) === 0) {
      const code = this.api.getLastError()
      if (code !== ERROR_IO_PENDING) throw clientOrSystemError(code, operation)
      await this.finishOverlapped(operation, transferred)
    }
    const count = this.koffi.decode(transferred, 'uint32') as number
    if (count !== buffer.byteLength) {
      throw new WindowsPipeClientError(`${operation} transferred an incomplete owner frame`)
    }
  }

  private async finishOverlapped(operation: string, transferred?: NativePointer): Promise<void> {
    const wait = await waitForSingleObjectAsync(this.api.waitForSingleObject, this.event)
    if (wait === WAIT_FAILED) throw new WindowsOwnerPipeError(this.api.getLastError(), 'WaitForSingleObject')
    if (wait !== WAIT_OBJECT_0) throw new WindowsOwnerPipeError(wait, 'WaitForSingleObject')
    const bytes = transferred ?? this.koffi.alloc('uint32', 1)
    if (this.api.getOverlappedResult(this.pipe, this.overlappedMemory, bytes, 0) === 0) {
      throw clientOrSystemError(this.api.getLastError(), operation)
    }
  }

  private resetOverlapped(): void {
    checkBoolean(this.api, this.api.resetEvent(this.event), 'ResetEvent')
    this.koffi.encode(this.overlappedMemory, this.overlapped, {
      Internal: 0,
      InternalHigh: 0,
      Offset: 0,
      OffsetHigh: 0,
      hEvent: this.event,
    })
  }
}

function waitForSingleObjectAsync(
  fn: WindowsFunctions['waitForSingleObject'],
  event: NativePointer,
): Promise<number> {
  return new Promise((resolve, reject) => {
    fn.async(event, INFINITE, (error: unknown, result: number) => {
      if (error === null || error === undefined) resolve(result)
      else reject(errorValue(error))
    })
  })
}

function clientOrSystemError(code: number, operation: string): Error {
  if (code === ERROR_BROKEN_PIPE || code === ERROR_NO_DATA || code === ERROR_OPERATION_ABORTED) {
    return new WindowsPipeClientError(`${operation} ended with Win32 error ${String(code)}`)
  }
  return new WindowsOwnerPipeError(code, operation)
}

function checkBoolean(api: WindowsFunctions, result: number, operation: string): void {
  if (result === 0) throw new WindowsOwnerPipeError(api.getLastError(), operation)
}

function isNullPointer(pointer: NativePointer): boolean {
  return pointer === null || pointer === 0n
}

function isInvalidHandle(pointer: NativePointer): boolean {
  return isNullPointer(pointer) || pointer === -1n || pointer === 0xFFFF_FFFF_FFFF_FFFFn
}
