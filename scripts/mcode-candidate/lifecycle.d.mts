/** Static candidate checks shared with the Host; they never execute candidate code. */
export interface CandidateVerification {
  passed: boolean
  failed: string[]
  launcherPath?: string
  manifestSha256: string | null
  launcherSha256: string | null
}
export function defaultStoreRoot(env?: NodeJS.ProcessEnv): string
export function assertStoreRoot(store: string): string
export function versionDir(store: string, version: string): string
export function verifyImportCandidate(
  source: string,
  options: { version: string; manifestPath: string },
): CandidateVerification
export function importCandidate(options: {
  source: string
  store: string
  version: string
  activeTasks: number
}): { ok: boolean; failed?: string[] }
