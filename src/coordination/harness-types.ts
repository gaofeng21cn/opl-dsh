/** OPL projections over native Harness sessions. No provider secrets cross this face. */
export const GROK_COMBINATION = 'grok-build/grok-4.7'
export const DSH_COMBINATION = 'dsh/deepseek-flash'
export type HarnessState = 'idle' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type HarnessOrigin = { kind: 'codex' | 'dsh' | 'harness' | 'desktop'; sessionId: string }
export interface HarnessApproval {
  id: string
  title: string
  options: { optionId: string; name: string; kind: string }[]
}
export interface HarnessTurn {
  operationId: string
  fingerprint: string
  prompt: string
  text: string
  state: HarnessState
  stopReason?: string
  error?: string
  tools: { id: string; title: string; status: string; kind: string }[]
}
export interface HarnessSession {
  id: string
  combination: string
  cwd: string
  acpSessionId: string
  origin: HarnessOrigin
  title: string
  sandbox: 'read-only' | 'workspace'
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
  combinations: { id: string; name: string; available: boolean; reason?: string }[]
  sessions: HarnessSnapshot[]
}
