/** Desktop Renderer 复用 Web GUI 的分块、源码别名与浏览器化规则。 */
import { fileURLToPath } from 'node:url'
import { defineConfig, type AliasOptions, type PluginOption, type UserConfig } from 'vite'
import webGuiConfig from '../web/vite.config.ts'

const shared = webGuiConfig as UserConfig
const sharedAliases = shared.resolve?.alias as AliasOptions | undefined
const plugins = (shared.plugins ?? []).filter((plugin: PluginOption) => {
  if (plugin === false || plugin === null || plugin === undefined || Array.isArray(plugin)) return true
  return plugin.name !== 'dsh-reject-standalone-web-serve'
})

export default defineConfig({
  ...shared,
  plugins,
  resolve: {
    ...shared.resolve,
    alias: [
      {
        find: /^@deepseek-ai\/dsh-client-ui-theme\/styles\/(.+)$/,
        replacement: `${fileURLToPath(new URL('../../packages/client/ui-theme/src/styles/', import.meta.url))}$1`,
      },
      ...(Array.isArray(sharedAliases) ? sharedAliases : []),
    ],
  },
  build: {
    ...shared.build,
    outDir: 'renderer',
    emptyOutDir: true,
    // CSP 只允许同源字体；小字体也必须输出为可审计的独立资源。
    assetsInlineLimit: 0,
    // 生产安装包不携带 Renderer 源码；受控符号产物由发布流水线单独保存。
    sourcemap: false,
  },
})
