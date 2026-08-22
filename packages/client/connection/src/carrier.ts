/**
 * Statically linked browser carriers for product shells.
 *
 * The `./client` export is a Loader registration bundle and must not be
 * imported as ESM by Web or Desktop entrypoints.
 * @module @deepseek-ai/dsh-client-connection/carrier
 */
export type {
  ClientCarrier,
  ClientCarrierAuthority,
  DownlinkKind,
} from './client/carrier.ts'
export {
  WebClientCarrier,
  type WebClientCarrierOptions,
} from './client/web-carrier.ts'
export {
  IpcClientCarrier,
  type IpcClientCarrierOptions,
} from './client/ipc/client-carrier.ts'
