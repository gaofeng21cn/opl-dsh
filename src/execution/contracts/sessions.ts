/** OPL projections over native Harness sessions. No provider secrets cross this face. */
export const GROK_COMBINATION = 'grok-build/grok-4.7'
export const DSH_COMBINATION = 'dsh/deepseek-flash'
export type HarnessState =
  | 'idle'
  | 'queued'
  | 'waiting_child'
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
export type HarnessOrigin = { kind: 'codex' | 'dsh' | 'harness' | 'desktop'; sessionId: string }
export interface HarnessApproval {
  id: string
  title: string
  /** Shell command supplied by the CLI for this pending human decision. */
  command?: string
  options: { optionId: string; name: string; kind: string }[]
}
export interface HarnessTurn {
  operationId: string
  fingerprint: string
  prompt: string
  reasoningEffort?: string
  /** Canonical declared write paths for scheduling, not a sandbox restriction. */
  writeScope?: string[]
  text: string
  /** Provider-supplied text and reasoning in arrival order; absent on older records. */
  content?: { type: 'text' | 'reasoning'; text: string }[]
  state: HarnessState
  stopReason?: string
  error?: string
  report?: CollaborationReport
  review?: CollaborationReview
  delivery?: CollaborationDelivery
  tools: HarnessTool[]
}
/** ACP tool data retained for transcript rendering, never for tool execution. */
export interface HarnessTool {
  id: string
  title: string
  status: string
  kind: string
  /** Verbatim ACP JSON; arbitrary CLI payloads stay outside the Remote type graph. */
  inputJson?: string
  outputJson?: string
  contentJson?: string
  locationsJson?: string
}
export interface HarnessSession {
  id: string
  combination: string
  harnessRef: string
  modelRef: import('./catalog.ts').ModelRef
  /**
   * Explicit reasoning setting for this combination, carried verbatim to the Harness.
   * An adapter decides what it means: an effort id, or a switch such as `on`/`off`.
   * Absent means the caller expressed no choice, and the Harness default applies. An
   * explicit value is never rewritten onto that default, including on reload.
   */
  reasoningEffort?: string
  cwd: string
  acpSessionId: string
  /** Ordinary official DSH conversation; distinct from the CLI's ACP session. */
  nativeSessionId?: string
  autoWakePaused?: boolean
  assignment?: CollaborationAssignment
  origin: HarnessOrigin
  title: string
  /** True when the official Harness supplied the title rather than the prompt fallback. */
  titleFromHarness?: boolean
  sandbox: 'read-only' | 'workspace' | 'full-access'
  createdAt: string
  updatedAt: string
  turns: HarnessTurn[]
}
export interface HarnessSnapshot extends HarnessSession {
  connected: boolean
  state: HarnessState
  approvals: HarnessApproval[]
}
export interface HarnessCatalog {
  combinations: {
    id: string
    name: string
    model: string
    modelId: string
    harness: string
    source: string
    available: boolean
    reason?: string
  }[]
  sessions: HarnessSnapshot[]
}

/** Task and delivery state live with the existing OPL session record. */
export interface CollaborationAssignment {
  taskId: string
  objective: string
  acceptance: string
  autoReview: boolean
  maxRevisions: number
  revisions: number
  createdAt: string
}
export interface CollaborationReport {
  summary: string
  artifacts: string[]
  checks: string[]
  remaining: string[]
}
export interface CollaborationReview {
  decision: 'pending' | 'accepted' | 'changes_requested'
  note?: string
  reviewedAt?: string
}
export interface CollaborationDelivery {
  id: string
  state: 'pending' | 'delivering' | 'delivered' | 'blocked'
  attempt: number
  error?: string
}
