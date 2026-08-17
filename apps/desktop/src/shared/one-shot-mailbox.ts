/** 允许值与等待方任意先到、且只完成一次的一次性邮箱。 */
export class OneShotMailbox<T> {
  private pending: T | undefined
  private waiter: ((value: T) => void) | undefined
  private taken = false

  /**
   * 发布一次值。
   * @param value - 需要交付给唯一领取方的值。
   * @returns 值是否被接受；重复值会被拒绝并由调用方负责清理。
   */
  publish(value: T): boolean {
    if (this.pending !== undefined || (this.taken && this.waiter === undefined)) return false
    const waiter = this.waiter
    if (waiter === undefined) {
      this.pending = value
    } else {
      this.waiter = undefined
      waiter(value)
    }
    return true
  }

  /** @returns 唯一值；重复领取会明确失败。 */
  take(): Promise<T> {
    if (this.taken) return Promise.reject(new Error('一次性邮箱已经领取'))
    this.taken = true
    if (this.pending !== undefined) {
      const value = this.pending
      this.pending = undefined
      return Promise.resolve(value)
    }
    return new Promise((resolve) => { this.waiter = resolve })
  }
}
