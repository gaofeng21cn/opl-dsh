/** Pinned package verification does not start Codex or access an account. */
export interface CodexCandidateVerification {
  version: string
  command: string
  manifestSha256: string
  executableSha256: string
  validation: 'static'
}
export const codexCandidatePlan: {
  id: string
  platform: string
  arch: string
  files: Record<string, string>
}
export function plainPath(path: string): string
export function verifyCodexCandidate(
  directory: string,
  version?: string,
): CodexCandidateVerification
export function importCodexCandidate(
  source: string,
  store: string,
  version?: string,
): CodexCandidateVerification
export function packageCodexCandidate(
  binary: string,
  output: string,
  assets?: string,
): CodexCandidateVerification
