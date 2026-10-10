/** An immutable imported candidate becomes the MiniMax catalog launch command. */
export interface MiniMaxCandidateRequest {
  version: string
  /** Omit when choosing an already imported version. Import never replaces a version. */
  source?: string
}
/** Published runtime selection and its previous launch settings. */
export interface MiniMaxCandidateResult {
  version: string
  command: string
  previousCommand: string
  previousPrefix: string[]
  manifestSha256: string
  launcherSha256: string
  /** Candidate files are verified here; ACP and model execution require separate checks. */
  validation: 'static'
}
