/** Electron 无关的 IPC Fetch 协议、Renderer carrier 与 Utility Host bridge。 */
export {
  IPC_DATA_PROTOCOL_VERSION,
  IPC_DEFAULT_MAX_IN_FLIGHT_REQUESTS,
  IPC_DEFAULT_MAX_REQUEST_BODY_BYTES,
  IPC_MAX_CHUNK_BYTES,
  IPC_MAX_HEADER_BYTES,
  IpcTransportError,
  errorFromFailure,
  ipcDataFrameSchema,
  type IpcDataFrame,
  type IpcFailureCode,
  type IpcFailureFrame,
  type IpcMessagePort,
} from './protocol.ts'
export {
  IpcClientCarrier,
  type IpcClientCarrierOptions,
} from './client-carrier.ts'
export {
  IpcHostBridge,
  type IpcHostBridgeResourceSnapshot,
  type IpcHostBridgeOptions,
  type IpcHostDispatch,
  type IpcHostDispatchContext,
} from './host-bridge.ts'
