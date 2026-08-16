# @deepseek-ai/dsh-session-log-saver-web

English | [中文](README.zh.md)

Browser provider for the shared `SessionLogSaver` service. It performs a `HEAD` request through the product-provided `ClientCarrier`, then gives the same-origin session-export URL and suggested filename to the browser download manager. ZIP generation and stream semantics remain owned by `dsh-host-apiproxy`; dialog state, concurrency collapse, and `/export` integration remain owned by `dsh-session-log-export`.

## Composition

```yaml
- id: session-log-saver-web
  name: '@deepseek-ai/dsh-session-log-saver-web'
```

The Web bundle mounts this provider. Desktop composition supplies a different provider for the same service and does not load this package.

## Model Experience

None, as saving a Session log stays on the human control plane and adds no model-visible content.

#### KV Cache effect

None; the provider leaves model requests unchanged.

## Known Limitations and Deferred Work

- The browser chooses the final download destination according to its own settings.
- Failures after the browser accepts the GET stream are reported by the browser download manager.
