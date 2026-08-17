import { defineConfig } from 'tsdown'

const shared = {
  outDir: 'lib',
  platform: 'node' as const,
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Electron 由宿主进程提供；把它打入 ESM 会引入依赖内部的 CommonJS __dirname。
  deps: { neverBundle: ['electron'] },
}

/** Main、Utility 与 Preload 独立成单文件入口，避免运行时依赖构建目录中的共享 chunk。 */
export default defineConfig([
  {
    ...shared,
    entry: { main: 'lib/types-host/main/index.js' },
    format: ['esm'],
  },
  {
    ...shared,
    entry: { utility: 'lib/types-host/utility/index.js' },
    format: ['esm'],
  },
  {
    ...shared,
    entry: { 'utility-provider': 'lib/types-host/utility/provider.js' },
    format: ['esm'],
  },
  {
    ...shared,
    entry: { 'utility-api-proxy': 'lib/types-host/utility/api-proxy.js' },
    format: ['esm'],
  },
  {
    ...shared,
    entry: { preload: 'lib/types-host/preload/index.js' },
    format: ['cjs'],
    // 沙箱 Preload 无法从应用的 node_modules 加载业务依赖。
    deps: {
      neverBundle: ['electron'],
      alwaysBundle: ['zod'],
      onlyBundle: ['zod'],
    },
  },
])
