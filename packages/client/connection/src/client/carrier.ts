/**
 * GUI 客户端的载体接口与通用 API 客户端。
 *
 * @module @deepseek-ai/dsh-client-connection/client/carrier
 */
import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from './api.ts'
import { AbstractApiClient } from './api.ts'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'

/** 客户端载体的调用权限来源。 */
export type ClientCarrierAuthority = 'local' | 'remote-trusted' | 'remote-untrusted'

/** 两条长期事件下行流的稳定名称。 */
export type DownlinkKind = 'mux' | 'host'

/** 只暴露协议解析所需能力，避免载体层依赖具体 schema 库。 */
interface ValueParser<T> {
  /** 校验未知输入并返回领域值。 */
  parse(input: unknown): T
}

/**
 * 与产品实现无关的客户端载体。
 *
 * 每个下行分片必须包含一个完整的 UTF-8 `ServerRequest` JSON 信封。载体负责背压、
 * 取消和物理连接生命周期；本层负责协议 schema 校验与领域帧解析。
 */
export interface ClientCarrier {
  /** 载体建立时已经判定的权限来源。 */
  readonly authority: ClientCarrierAuthority
  /** 业务路径解析所用的逻辑基址；IPC 载体使用内部保留地址。 */
  readonly baseUrl: string
  /** 执行一个 Fetch 语义请求。 */
  fetch(input: URL | Request, init?: RequestInit): Promise<Response>
  /** 打开一条按完整信封分片的事件下行流。 */
  connectDownlink(
    kind: DownlinkKind,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<Uint8Array>
  /** 关闭载体拥有的全部物理连接和在途请求。 */
  close(reason?: unknown): Promise<void>
}

/**
 * 把 `ClientCarrier` 适配为共享 `IApiClient` 协议实现。
 */
export class CarrierApiClient extends AbstractApiClient {
  /**
   * 创建通用 API 客户端。
   * @param carrier - 已由产品入口选择并注入的载体。
   * @param timeoutMs - 有界一元调用的超时时间。
   */
  constructor(
    /** 产品入口已选择的物理载体。 */
    readonly carrier: ClientCarrier,
    timeoutMs?: number,
  ) {
    super(timeoutMs)
  }

  /** @internal */
  protected override resolveBase(): string {
    return this.carrier.baseUrl
  }

  /** @internal */
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return this.carrier.fetch(input, init)
  }

  /** @internal */
  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readCarrierDownlink('mux', signal, muxFrameSchema, onOpen)
  }

  /** @internal */
  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readCarrierDownlink('host', signal, hostFrameSchema, onOpen)
  }

  /** 解析载体按信封分片的字节流，并隔离单个畸形帧。 */
  private async *readCarrierDownlink<F extends MuxFrame | HostFrame>(
    kind: DownlinkKind,
    signal: AbortSignal,
    frameSchema: ValueParser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    for await (const bytes of this.carrier.connectDownlink(kind, signal, onOpen)) {
      let full: ServerRequest
      let frame: F
      try {
        full = serverRequestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        console.error(`[client-connection] 丢弃 ${kind} 下行中的畸形信封：`, error)
        continue
      }
      this.onEnvelope(full)
      yield { rpcId: full.rpcId, payload: frame }
    }
  }
}
