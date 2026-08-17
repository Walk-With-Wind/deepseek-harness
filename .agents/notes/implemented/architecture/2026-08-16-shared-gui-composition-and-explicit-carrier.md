# Agent Note: shared GUI composition and explicit client carrier

Status: implemented

English | [中文](2026-08-16-shared-gui-composition-and-explicit-carrier.zh.md)

## Problem

The browser bundle owned two unrelated concerns: the reusable GUI Host/client composition and the HTTP/WebSocket product transport. Adding a desktop carrier by copying that patch would create two owners for storage, the API gateway, client rows, Agent Preset rules, and their defaults. The browser shell also read `window.__DSH_BOOT__` and the connection plugin constructed its own Web transport, so the shared React/Cordis startup path could not accept an IPC manifest or carrier without environment detection.

## Decision

GUI profiles use three ordered ownership layers. `dsh-base` owns mode-neutral Harness capabilities. `dsh-gui-app` owns transport-neutral GUI Host services, storage, the shared client roster, GUI defaults, and per-session Agent Preset composition. A product layer then owns only its carrier and platform resources: `dsh-web-app` provides Web startup, WebServer, HTTP/WebSocket bindings, browser module delivery, directory-picker selection, and client HMR; the desktop application supplies its private IPC and native providers. The shipped Web template is therefore `dsh-base + dsh-gui-app + dsh-web-app`.

`AppGuiEntry` is the shared GUI kernel. Its constructor receives a parsed boot manifest, a `ClientCarrier`, an optional bundle loader, and platform capabilities. A shell-owned bootstrap entry provides the carrier and platform capabilities through Cordis before product client rows activate. `AppWebEntry` remains a thin compatibility adapter that parses `window.__DSH_BOOT__`, creates `WebClientCarrier`, and delegates to `AppGuiEntry`.

The client connection plugin injects `clientCarrier`; it does not inspect the browser environment or construct a Web transport. `CarrierApiClient` retains the shared API envelope and schema behavior while delegating Fetch and downlink bytes to the carrier. `createConnectionRpc` likewise receives an explicit Fetch implementation and logical base URL. The browser adapter fixes its authority and base URL at carrier construction, so later page-global mutation cannot retarget an established client.

Host API routing follows the same split. The transport-neutral dispatcher owns request parsing, handler invocation, response envelopes, stream pull/cancel behavior, and registry cleanup. Web and IPC adapters translate only their outer carrier frames. `ClientModuleRegistry` owns package discovery, graph hashing, and a strict resource manifest; its `/web` entry owns WebServer routes and HTML injection, while Desktop maps the same trusted manifest through `app://`. A closed host supplies `hostModuleBaseUrl`, so host-owned adapters resolve from the installed application before the profile dependency tree without hiding profile-installed plugins.

## Alternatives considered

| Rejected | Reason |
|---|---|
| Copy the Web patch into a desktop patch | Shared rows, defaults, and Agent Preset rules would immediately have two owners and drift independently. |
| Keep `AppWebEntry` as the shared kernel and branch on Electron globals | Shared code would depend on a product runtime and would make browser-global detection part of the transport contract. |
| Let the connection plugin continue constructing `WebApiClient` | A desktop entry could pass a manifest but could not select the physical transport without another hidden global or product branch. |
| Put shared GUI rows in `dsh-base` | Headless would acquire Host/client capabilities it intentionally omits. |

## Consequences

- Web composition now has three shipped bundle layers; exact installation-owned legacy tuples are normalized to the new template.
- A second GUI product reuses one roster and one set of defaults, and implements only its carrier, resource delivery, and native providers.
- Missing carrier provision leaves the connection row pending and the existing full-entry activation sweep reports the absent service loudly.
- The GUI kernel still lives in `packages/client/web` to avoid a duplicate UI package; the package name is historical, while `AppGuiEntry` is product-neutral.
- Module discovery and resource identity have one transport-neutral owner; Web route/HTML injection and Desktop `app://` mapping are separate adapters.
- Desktop applies these seams through its [four-process, security, lifecycle, and release decision](2026-08-16-electron-desktop-process-security-and-release.md); no shared package imports Electron.
