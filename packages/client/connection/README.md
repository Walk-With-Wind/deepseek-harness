# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

Wire consumer layer: the client plugin injects the product-selected `ctx.clientCarrier` and mounts `ctx.connection` (shared API client + carrier authority + observable generation-scoped `hostDescription` + single-consumer stream-loop starter). `ClientCarrier` exposes a logical base URL, Fetch semantics, two complete-envelope byte downlinks, authority, and asynchronous close without importing Web or Electron types. `CarrierApiClient` keeps the shared API envelope/schema behavior; `createConnectionRpc` takes the carrier's explicit Fetch implementation. `WebClientCarrier` is the browser adapter, using HTTP POST plus one downlink-only WebSocket each for `events.mux` and `events.host`; its authority and base URL are fixed at construction. Each readiness handshake publishes the exact `host.describe` value before `onConnected`, and generation loss or stop clears it. The Host half still owns the `/api` route, Fetch bridge, Web trust fence, and WebSocket upgrades; a registered Typert interceptor claims its Remote endpoints before the API Proxy fallback. The privileged-method trust policy and the [WebSocket downlink decision](../../../.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md) remain unchanged.

## /api browser-trust fence

The node half guards every entry under `/api` before bridging or upgrading (`src/api-request-trust.ts`). Every request — browser-marked or not — must present a `Host` that is a loopback authority or matches a `trustedHosts` entry: exact on `host:port` entries, any port on port-less entries, both sides compared through WHATWG normalization (DNS-rebinding defense). There is deliberately no shortcut for unmarked HTTP requests: over plain HTTP a browser attaches neither `Origin` nor Fetch-Metadata to image and navigation reads, so an unmarked request may still be a rebound browser read with a readable response, and Host is the one header rebinding cannot forge; a browser WebSocket handshake carries `Origin` and passes the same comparison. Non-browser clients pass the same fence via loopback, deployment-derived LAN IP literals, or a declared authority. When markers are present, an attached `Origin` must equal the Host authority, and an explicit `sec-fetch-site: cross-site` marker is refused. A `trustedHosts` entry that is not a bare, canonical `host[:port]` authority — one WHATWG parsing reads back exactly as written — fails the plugin load loudly: parsing would otherwise quietly authorize the hostname inside `harness.internal/path`, or broaden a dangling-colon or zero-padded port to an any-port grant. HTTP failures answer plain 403 before any RPC dispatch; upgrade failures reject the handshake before any event stream starts. Non-loopback compositions must trust their serving authorities explicitly: the Web runtime derives LAN IP literals from an all-interfaces server config, while `trustedHosts` in cordis.yml and the CLI's `--trusted-host` flag declare named authorities. `dsh web --host 0.0.0.0` is intentionally unsupported until remote access has an authentication layer. The fence is a reachability policy, not authentication; the Web carrier provides no authentication layer. Decision record: [the api browser-trust boundary Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md).

## `/api` WebSocket downlinks

`/api/events.mux` and `/api/events.host` each accept a WebSocket upgrade and send only the corresponding `ServerRequest` text messages to the browser; the client sends no application data over these sockets. If either socket ends, the current connection generation fails and rebuilds both streams; readiness still requires both sockets to be open and the `host.describe` HTTP call to succeed. Host teardown terminates both sockets, aborts their sources, and waits for source cleanup before returning. Ordinary network GETs to these paths return 426 with no SSE fallback; `toFetchHandler`'s SSE codec serves only the isomorphic in-process carrier.

## Desktop IPC carrier

`IpcClientCarrier` and `IpcHostBridge` run the same Fetch-shaped protocol over one generation-bound `MessagePort` without opening a network listener. The closed frame union carries request and response metadata plus pull-driven body chunks; each direction permits one outstanding pull and at most one 1 MiB chunk in flight, propagates cancellation and physical port closure, and rejects stale-generation traffic. The Renderer carrier coalesces small upstream chunks into 1 MiB frames before structured cloning, which bounds resident data while avoiding one cross-process copy per browser-sized 64 KiB chunk.

`IpcHostBridge.resourceSnapshot()` reports only lifecycle phase and aggregate request/reader counts. Desktop Utility aggregates those values with bridge and native-operation counts for release endurance gates; neither API exposes request ids, routes, paths, or body content.

## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **History resumes an unattached session** — opening history may create the host-side agent and add latency to the first open; there is no persistence-only read path.
- **The Web `/api` bridge buffers each request body in memory** — `maxRequestBodyBytes` (default 160 MiB, which accommodates the default 100 MiB raw image aggregate plus the bounded upload manifest) is therefore also the per-request resident bound. Desktop IPC does not share this buffering behavior; lowering Web residency further requires a streaming `node:http` bridge.
