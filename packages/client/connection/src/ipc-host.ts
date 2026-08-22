/** Utility/worker 可用的 IPC Host bridge；不导入浏览器载体或 Electron。 */
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
} from './client/ipc/protocol.ts'
export {
  IpcHostBridge,
  type IpcHostBridgeResourceSnapshot,
  type IpcHostBridgeOptions,
  type IpcHostDispatch,
  type IpcHostDispatchContext,
} from './client/ipc/host-bridge.ts'
