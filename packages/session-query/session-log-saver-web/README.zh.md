# @deepseek-ai/dsh-session-log-saver-web

[English](README.md) | 中文

共享 `SessionLogSaver` 服务的浏览器 provider。它通过产品注入的 `ClientCarrier` 执行 `HEAD` 请求，再把同源 Session 导出 URL 和建议文件名交给浏览器下载管理器。ZIP 生成与流语义仍由 `dsh-host-apiproxy` 负责；弹窗状态、并发折叠和 `/export` 集成仍由 `dsh-session-log-export` 负责。

## 组合

```yaml
- id: session-log-saver-web
  name: '@deepseek-ai/dsh-session-log-saver-web'
```

Web bundle 挂载本 provider。Desktop 组合为同一服务提供另一实现，不装载本包。

## 模型体验

无，因为保存 Session 日志属于用户控制平面，不会增加模型可见内容。

#### KV Cache 影响

无；本 provider 不改变模型请求。

## 已知限制与暂缓事项

- 最终下载位置由浏览器自身设置决定。
- 浏览器接受 GET 流之后发生的失败由浏览器下载管理器报告。
