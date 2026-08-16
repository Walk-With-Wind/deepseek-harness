/** 浏览器 API 客户端兼容入口。 */
import { CarrierApiClient } from './carrier.ts'
import { WebClientCarrier, type WebClientCarrierOptions } from './web-carrier.ts'

/**
 * 使用 `WebClientCarrier` 的共享 API 客户端。
 *
 * 新的 GUI 启动路径直接注入载体；该类保留给只需要独立 API 客户端的调用方。
 */
export class WebApiClient extends CarrierApiClient {
  /**
   * 创建浏览器 API 客户端。
   * @param options - 浏览器载体的显式平台依赖。
   * @param timeoutMs - 有界一元调用的超时时间。
   */
  constructor(options: WebClientCarrierOptions = {}, timeoutMs?: number) {
    super(new WebClientCarrier(options), timeoutMs)
  }
}

export { WebClientCarrier, type WebClientCarrierOptions } from './web-carrier.ts'
