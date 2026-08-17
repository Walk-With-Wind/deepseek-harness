/** 桌面 IPC API 客户端兼容入口。 */
import { CarrierApiClient } from './carrier.ts'
import {
  IpcClientCarrier,
  type IpcClientCarrierOptions,
} from './ipc/client-carrier.ts'
import type { IpcMessagePort } from './ipc/protocol.ts'

/** 使用 `IpcClientCarrier` 的共享 API 客户端，不复制任何业务路由或 schema。 */
export class IpcApiClient extends CarrierApiClient {
  /**
   * 创建桌面 API 客户端。
   * @param port - Preload 转交的数据端口。
   * @param options - IPC 代际与资源上限。
   * @param timeoutMs - 有界一元调用超时。
   */
  constructor(port: IpcMessagePort, options: IpcClientCarrierOptions, timeoutMs?: number) {
    super(new IpcClientCarrier(port, options), timeoutMs)
  }
}
