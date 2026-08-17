/** Electron 私有 IPC channel 名称；Renderer 只能通过 preload 的窄 API 间接使用。 */
export const DESKTOP_CHANNELS = Object.freeze({
  bootstrap: 'dsh:desktop/bootstrap',
  command: 'dsh:desktop/command',
  hostState: 'dsh:desktop/host-state',
  updateState: 'dsh:desktop/update-state',
})

/** Preload 向主 world 转交数据端口时使用的 DOM 消息标签。 */
export const DESKTOP_DATA_PORT_MESSAGE = 'dsh:desktop/data-port'
