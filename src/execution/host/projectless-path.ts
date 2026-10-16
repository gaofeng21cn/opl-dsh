/** One reserved working directory per Session this suite creates without a Workspace. */
import { join } from 'node:path'

/** Directory name this suite reserves under the DSH home for projectless Session working directories. */
export const PROJECTLESS_SESSION_DIRECTORY = 'tasks'

/**
 * The exact working directory reserved for one projectless Session. The value is
 * a naming decision of this suite: the Session is created with this `cwd`, so the
 * reserved shape is what later tells a projectless Session from an ordinary
 * ungrouped one.
 * @param home - resolved DSH home directory.
 * @param sessionId - the Session the directory is reserved for.
 * @returns the projectless working directory for that Session.
 */
export function projectlessSessionCwd(home: string, sessionId: string): string {
  return join(home, PROJECTLESS_SESSION_DIRECTORY, sessionId)
}
