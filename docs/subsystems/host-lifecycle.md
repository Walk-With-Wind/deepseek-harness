# Host lifecycle

English | [中文](host-lifecycle.zh.md)

The process-neutral Host boot and exclusive-home lifecycle in [dsh-app-boot](../../packages/boot/app-boot). `prepareProfileRuntime` composes bundle, profile, home, and product overlays without owning process signals or stdio. `bootProfileRuntime` acquires `ctx.hostLease` before business plugins, mounts and settles that composition, and registers patch watchers and lease release under the root Cordis lifecycle. CLI, Web, and Desktop Utility provide only their process-specific owner identity, adapters, and shutdown behavior.

Source: [`packages/boot/app-boot/src/host-lease.ts`](../../packages/boot/app-boot/src/host-lease.ts)

## Canonical home and owner identity

The home is resolved to a real absolute path before identity is derived. `key` is a SHA-256 digest used in endpoints and diagnostics so consumers do not need the path. The runtime directory must be a real owner-only directory. A POSIX home whose socket path is too long uses an owner-only short symlink whose real target must equal that directory; Windows derives the pipe name from the current user SID and home digest.

```ts type-equiv
/** 可向冲突方披露的租约 owner 摘要。 */
interface HostLeaseOwnerSummary {
  /** Host 产品类型。 */
  readonly kind: 'cli' | 'web' | 'desktop'
  /** Host 所属 DSH 版本。 */
  readonly version: string
  /** 当前 owner 的进程号。 */
  readonly pid: number
  /** ISO 8601 启动时间。 */
  readonly startedAt: string
  /** 随机 nonce 的不可逆短摘要。 */
  readonly nonceDigest: string
}
```

```ts type-equiv
/** 调用方提供的 owner 身份；进程字段由租约实现生成。 */
interface HostLeaseOwner {
  /** Host 产品类型。 */
  readonly kind: HostLeaseOwnerSummary['kind']
  /** Host 所属 DSH 版本。 */
  readonly version: string
}
```

```ts type-equiv
/** 经过 realpath 归一并摘要后的 Harness home。 */
interface CanonicalHostHome {
  /** 真实且绝对的 Harness home。 */
  readonly path: string
  /** 不暴露路径的稳定 SHA-256 摘要。 */
  readonly key: string
  /** POSIX 租约端点所在的私有目录。 */
  readonly runtimeDir: string
  /** 传给 sockaddr_un 的有界路径目录；长 home 时是指向 runtimeDir 的私有短别名。 */
  readonly addressDir: string
}
```

## Lease behavior

Acquisition either starts the owner listener or fails with a stable `HostLeaseError` code. A live owner returns a redacted `HostLeaseOwnerSummary`. POSIX cleanup occurs only after address-in-use, a failed bounded owner probe, safe parent/endpoint classification, and unchanged socket identity. Windows creates a named pipe with an explicit current-user-only DACL and refuses ambiguous reclamation. `release()` is idempotent and removes only the endpoint identity created by that lease.

```ts type-equiv
/** 成功持有的 Host 租约。 */
interface HostLease {
  /** 当前 owner 的只读身份摘要。 */
  readonly owner: HostLeaseOwnerSummary
  /** 用于诊断的 socket 或 named-pipe 地址。 */
  readonly address: string
  /** 幂等关闭 listener，并在安全时清除自身平台端点。 */
  release(): Promise<void>
}
```

The lease belongs in the process that performs business writes, not a launcher or window process. Its presence does not mean the Host is ready: the owning application separately waits for complete profile activation and required resource manifests. Clean shutdown awaits Cordis disposal and lease release; a forced process exit is recoverable on the next acquisition but is never reported as quiescent.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxhostlease--hostlease"></a>

### `ctx.hostLease` — `HostLease`

成功持有的 Host 租约。

```ts cordis-catalog
/** 幂等关闭 listener，并在安全时清除自身平台端点。 */
release(): Promise<void>
```

Source: [`packages/boot/app-boot/src/host-lease.ts:71`](../../packages/boot/app-boot/src/host-lease.ts)
<!-- END GENERATED cordis-surface -->
