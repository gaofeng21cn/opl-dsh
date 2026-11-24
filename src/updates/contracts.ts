/** Automatic installation never changes the official Desktop version. */
export type OplUpdateMode = 'notify' | 'on-launch' | 'idle'

/** Persisted user choice for preparing and applying compatible updates. */
export interface OplUpdatePolicy {
  mode: OplUpdateMode
  idleMinutes: number
  countdownSeconds: number
}

/** A pending restart is observable and can be postponed before handoff. */
export interface OplUpdateRestart {
  phase: 'waiting' | 'countdown' | 'handoff' | 'blocked' | 'failed'
  dueAt: string | null
  reason:
    'busy' | 'activity-unknown' | 'other-profile' | 'desktop-unavailable' | 'update-failed' | null
}

/** Public update status contains release metadata, never local installer paths. */
export interface OplUpdateRelease {
  summary?: string
  version: string
  officialVersion: string
  url: string
  publishedAt: string
  compatibility: 'enhancement' | 'full-suite'
}

/** Safe categories for a failed enhancement preparation. */
export type OplUpdateError =
  | 'check-failed'
  | 'prepare-failed'
  | 'prepare-network-failed'
  | 'prepare-proxy-failed'
  | 'prepare-timeout'
  | 'prepare-http-failed'
  | 'prepare-integrity-failed'
  | 'prepare-release-changed'
  | 'prepare-lock-failed'
  | 'prepare-installation-failed'
  | null

/** Safe stage for a failed update operation. */
export type OplUpdateFailureStage =
  | 'acquire'
  | 'installation'
  | 'discovery'
  | 'download'
  | 'verify'
  | 'stage'
  | 'confirm'
  | 'cancel'
  | 'apply'
  | 'save'

/** Safe reason for a failed update operation. */
export type OplUpdateFailureReason =
  | 'network'
  | 'proxy'
  | 'timeout'
  | 'http'
  | 'integrity'
  | 'busy'
  | 'installation'
  | 'release-changed'
  | 'filesystem'
  | 'unknown'

/** Bounded failure details safe to persist and show in the client. */
export interface OplUpdateFailure {
  stage: OplUpdateFailureStage
  reason: OplUpdateFailureReason
  httpStatus?: number
  systemCode?: string
}

/** Status of the Computer Use component installed for this DSH host. */
export interface KimiCuUpdateStatus {
  installedVersion: string | null
  latestVersion: string | null
  available: boolean
  error?: string
  updating?: boolean
}

/** Last successful discovery survives a failed or cancelled check. */
export interface OplUpdateStatus {
  kimiCu?: KimiCuUpdateStatus
  installedVersion: string
  officialVersion: string
  localCandidate: boolean
  automatic: boolean
  checking: boolean
  preparing: boolean
  checkedAt: string | null
  lastSuccessAt: string | null
  error: OplUpdateError
  failure: OplUpdateFailure | null
  release: OplUpdateRelease | null
  pendingVersion: string | null
  policy?: OplUpdatePolicy
  restart?: OplUpdateRestart | undefined
}

/** Browser consumers use generated RPC through this component interface. */
export interface OplUpdateApi {
  status(): Promise<OplUpdateStatus>
  check(): Promise<OplUpdateStatus>
  updateKimiCu?(): Promise<OplUpdateStatus>
  setAutomatic(enabled: boolean): Promise<OplUpdateStatus>
  prepare(): Promise<OplUpdateStatus>
  applyNow(): Promise<OplUpdateStatus>
  cancel(): Promise<OplUpdateStatus>
  setPolicy(policy: OplUpdatePolicy): Promise<OplUpdateStatus>
  postpone(): Promise<OplUpdateStatus>
  activity(): Promise<void>
}
