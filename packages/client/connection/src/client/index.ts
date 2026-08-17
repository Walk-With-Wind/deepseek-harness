/**
 * GUI 连接插件。产品入口注入载体，本插件提供共享 API 客户端，并由运行时对象层在接收器就绪后
 * 启动连接控制器。测试清单仍可显式选择无网络 fixture 客户端。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HostDescription, IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { FixtureApiClient } from './fixture.ts'
import { CarrierApiClient, type ClientCarrier } from './carrier.ts'
import { createConnectionRpc } from './rpc.ts'
import type { ClientConnectionRpc } from '../rpc.ts'
export {
  CarrierApiClient,
  type ClientCarrier,
  type ClientCarrierAuthority,
  type DownlinkKind,
} from './carrier.ts'
export { createConnectionRpc, createWebConnectionRpc } from './rpc.ts'
export { WebClientCarrier, type WebClientCarrierOptions } from './web-carrier.ts'
export { IpcApiClient } from './ipc-api-client.ts'
export {
  IPC_DATA_PROTOCOL_VERSION,
  IPC_DEFAULT_MAX_IN_FLIGHT_REQUESTS,
  IPC_DEFAULT_MAX_REQUEST_BODY_BYTES,
  IPC_MAX_CHUNK_BYTES,
  IPC_MAX_HEADER_BYTES,
  IpcClientCarrier,
  IpcHostBridge,
  IpcTransportError,
  errorFromFailure,
  ipcDataFrameSchema,
  type IpcClientCarrierOptions,
  type IpcDataFrame,
  type IpcFailureCode,
  type IpcFailureFrame,
  type IpcHostBridgeOptions,
  type IpcHostDispatch,
  type IpcHostDispatchContext,
  type IpcMessagePort,
} from './ipc/index.ts'

// 重新导出可在 GUI 进程安全使用的 apiproxy 协议与核心类型。
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, AttachmentBlobPayload, AttachmentBlobValue,
  PromptContentPart, PromptUploadContentPart,
  PromptUploadImageSource, PromptUploadPayload, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  DirectoryEntry, DirectoryListing,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView,
  SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  MessageId, ModelReasoningEffort, ModelSelection, QueueAction, QueuedInboxItem, SessionModels,
  SubagentsApi, SubagentAddress, SubagentCatalog, SubagentListEntry, SubagentPromptReceipt,
  JobView,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  HostDescription, IApiClient, SessionId, SessionEvent, ContentBlock, StreamChunk,
  GoalsApi, GoalRef,
  SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
  CredentialsApi, CredentialView, ConfigurableProviderView, DiscoveredModelView, LlmApi,
} from './api.ts'
export {
  RpcId,
  AbstractApiClient,
  transportError,
} from './api.ts'

// 连接循环类型通过 ConnectionHandle.start 公开，控制器实现仍保留在包内。
export type { ConnectionConfig, ConnectionSinks, ConnectionState }
export type { ClientConnectionRpc } from '../rpc.ts'

/** 每次连接握手完成后发布的可观察 Host 描述。 */
export interface HostDescriptionSource {
  /** 当前连接代的最新描述；连接前和重连期间为空。 */
  getSnapshot(): HostDescription | undefined
  /** 订阅描述替换与连接丢失。 */
  subscribe(listener: () => void): () => void
}

/** 产品入口必须先提供客户端载体。 */
export const inject = ['clientCarrier']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 产品入口在插件图启动前提供的客户端载体。 */
    clientCarrier: ClientCarrier
  }
}

/**
 * The ctx.connection service API: the API client plus a one-shot
 * controller starter (the runtime plugin supplies sinks when its object layer
 * is ready — connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Shared api client (fixture or real, decided at boot from the page URL). */
  readonly api: IApiClient
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /** Generation-scoped Host facts, including native path-open capability. */
  readonly hostDescription: HostDescriptionSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

/**
 * 客户端插件：消费产品入口注入的载体，并提供 `ctx.connection`。
 * @param ctx - 客户端 Cordis 上下文。
 */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  const carrier = ctx.clientCarrier
  const api: IApiClient = fixtureClient ?? new CarrierApiClient(carrier)
  const rpc = fixtureClient?.rpc
    ?? createConnectionRpc(carrier.fetch.bind(carrier), carrier.baseUrl)
  let started = false
  let description: HostDescription | undefined
  const descriptionListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] host-description listener threw:', error)
      }
    }
  }
  const handle: ConnectionHandle = {
    api,
    isLoopback: carrier.authority === 'local',
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    rpc,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const controller = new ConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
          publishDescription(next)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') publishDescription(undefined)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      controller.start()
      return {
        stop: () => {
          controller.stop()
          publishDescription(undefined)
        },
      }
    },
  }
  ctx.provide('connection', handle)
}
