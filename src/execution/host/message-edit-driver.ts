/** Vendor history operations used by the shared same-conversation edit transaction. */
import type { HarnessSession } from '../contracts/sessions.ts'
import type { AcpRequestSurface, AcpSessionSnapshot, AdapterLaunch } from './adapters/types.ts'
import type { HarnessStatistics } from '../contracts/usage.ts'

/** A real user input in the active vendor history, never a text-derived identity. */
export interface ExternalEditBoundary {
  id: string
  /** Optional statistics for this exact native user input, read in the same control lifecycle. */
  statistics?: HarnessStatistics
  /** Exact text when supplied by the public protocol; summaries must not populate this. */
  text?: string
  /** Number of image blocks in this vendor input; absence means text-only. */
  imageCount?: number
  /** Vendor-specific restriction for this boundary. */
  unavailableReason?: string
}

/** Read-only history observation; its token covers the vendor facts used for mutation. */
export interface ExternalEditHistory {
  sessionId: string
  token: string
  boundaries: ExternalEditBoundary[]
  /** Latest input with a verified terminal reply or owned engine exit and stable idle history. */
  settledInputId?: string
  /** Durable request receipts issued by the bridge for exact native input identities. */
  receivedInputs?: { requestId: string; inputId: string }[]
}

/** Shared owner supplies transport lifecycle and retains all record/prompt ownership. */
export interface ExternalEditContext {
  readonly record: Readonly<HarnessSession>
  readonly launch: AdapterLaunch
  readonly signal: AbortSignal
  transport(): AcpRequestSurface
  snapshot(): AcpSessionSnapshot
  /** Stop this record's idle connection; never changes its persisted binding. */
  disconnect(): Promise<void>
  /** Reconnect the specified vendor identity and verify the original route/permissions. */
  reconnect(sessionId: string): Promise<void>
  /** Replay into a separate observation, preserving configured MCP servers and the stored turns. */
  replayHistory?(): Promise<ExternalEditHistory>
}

/** Exact retained user-boundary correspondence after a vendor changes history. */
export interface ExternalEditResult {
  sessionId: string
  retained: { previousId: string; nextId: string }[]
  /** The new empty session is already active and need not support loading before its first prompt. */
  ephemeral?: boolean
}

export type ExternalMessageEditFailure =
  | 'unsupported'
  | 'busy'
  | 'aborted'
  | 'stale'
  | 'history-changed'
  | 'target-unknown'
  | 'target-unavailable'
  | 'control-unavailable'
  | 'fork-rejected'
  | 'uncertain'
  | 'protocol'

const FAILURE_MESSAGES: Record<ExternalMessageEditFailure, string> = {
  unsupported: '当前官方 CLI 版本不提供消息编辑所需的会话历史接口',
  busy: '会话仍在执行，暂时不能编辑历史',
  aborted: '编辑已取消',
  stale: '会话身份已变化，请重新读取',
  'history-changed': '会话历史已变化，请重新读取',
  'target-unknown': '目标消息不在当前活动历史中',
  'target-unavailable': '目标消息当前不可编辑',
  'control-unavailable': '无法启动官方 CLI 的临时控制服务',
  'fork-rejected': '官方 CLI 拒绝了本次分支请求',
  uncertain: '分支结果不确定，请核对会话历史',
  protocol: '官方 CLI 返回了无法验证的会话历史',
}

/** Fixed, credential-free failure. `status` is the only vendor response fact retained. */
export class ExternalMessageEditError extends Error {
  readonly code: ExternalMessageEditFailure
  readonly status: number | undefined
  constructor(code: ExternalMessageEditFailure, status?: number) {
    super(FAILURE_MESSAGES[code])
    this.name = 'ExternalMessageEditError'
    this.code = code
    this.status = status
  }
}

/**
 * A driver never sends the replacement prompt, writes HarnessSession records, or edits DSH history.
 * The shared owner journals invocation before rewind and blocks all sends on uncertain outcomes.
 */
export interface ExternalMessageEditDriver {
  /** Read the current active user boundaries, refusing an unverified capability. */
  read(context: ExternalEditContext): Promise<ExternalEditHistory>
  /**
   * Exclude target and its tail without reverting files or deleting old branches.
   * Revalidate expected history immediately before mutation. Throw on uncertain results;
   * callers must not interpret an exception as proof the vendor was unchanged.
   */
  rewind(
    context: ExternalEditContext,
    input: { operationId: string; targetId: string; expected: ExternalEditHistory },
  ): Promise<ExternalEditResult>
}
