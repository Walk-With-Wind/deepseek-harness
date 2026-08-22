/** Community Desktop home resolution with an isolated default. */
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Default directory name reserved for the Community Build. */
const COMMUNITY_DESKTOP_HOME_DIR_NAME = '.deepseek-harness-community'

/**
 * Resolve the Community Desktop data root.
 *
 * An explicit non-blank `DSH_HOME` intentionally opts into the shared Harness
 * home contract. Without it, Desktop uses a fork-specific directory so the
 * official application and Community Build cannot silently share mutable data.
 * @param environment - Environment mapping used to inspect `DSH_HOME`.
 * @param userHome - Operating-system user home used for the isolated default.
 * @returns A normalized absolute data-root path.
 */
export function resolveCommunityDesktopHome(
  environment: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): string {
  const configured = environment.DSH_HOME
  if (configured !== undefined && configured.trim().length > 0) {
    return resolveDshHome(undefined, environment)
  }
  return resolve(userHome, COMMUNITY_DESKTOP_HOME_DIR_NAME)
}
