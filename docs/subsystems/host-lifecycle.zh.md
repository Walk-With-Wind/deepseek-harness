# Host 生命周期

[English](host-lifecycle.md) | 中文

[dsh-app-boot](../../packages/boot/app-boot) 中与进程无关的 Host 启动和独占 home 生命周期。`prepareProfileRuntime` 组合 bundle、profile、home 与产品 overlay，不持有进程 signal 或 stdio。`bootProfileRuntime` 在业务插件前取得 `ctx.hostLease`，挂载并安定该组合，再把 patch watcher 与租约释放登记到根 Cordis 生命周期下。CLI、Web 与 Desktop Utility 只提供各自进程特定的 owner 身份、adapter 与关停行为。

源码：[`packages/boot/app-boot/src/host-lease.ts`](../../packages/boot/app-boot/src/host-lease.ts)

## 规范化 home 与 owner 身份

派生身份前，home 会解析为真实绝对路径。`key` 是 endpoint 与诊断使用的 SHA-256 摘要，因此消费方不需要取得路径。runtime 目录必须是 owner-only 真实目录。POSIX home 的 socket 路径过长时，会使用 owner-only 短符号链接，且其真实目标必须等于该目录；Windows 从当前用户 SID 与 home 摘要派生 pipe 名。

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

## 租约行为

获取操作要么启动 owner listener，要么通过稳定 `HostLeaseError` code 失败。live owner 返回脱敏 `HostLeaseOwnerSummary`。POSIX 只有在 address-in-use、有限 owner probe 失败、父目录／endpoint 分类安全且 socket 身份未改变后才清理。Windows 使用显式仅当前用户 DACL 创建 named pipe，并拒绝含混回收。`release()` 可幂等调用，并且只移除该租约创建的 endpoint 身份。

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

租约应位于执行业务写入的进程中，而非 launcher 或窗口进程。租约存在不代表 Host 已 ready；所属应用还要分别等待完整 profile 激活和必需资源 manifest。干净关停会等待 Cordis dispose 与租约释放；强制进程退出可在下次获取时恢复，但永远不会报告为 quiescent。

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
