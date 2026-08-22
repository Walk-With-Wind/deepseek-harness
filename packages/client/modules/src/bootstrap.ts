/**
 * Statically linked module-system bootstrap for product shells.
 *
 * The `./client` export is a Loader registration bundle. Desktop links this
 * ESM entry so the bootstrap functions and the enrolled plugin share one
 * module-system instance.
 * @module @deepseek-ai/dsh-client-modules/bootstrap
 */
export * from './client/index.ts'
