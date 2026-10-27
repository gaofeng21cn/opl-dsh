/** Usage projected from the official Pi RPC request lifecycle and session statistics. */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const sum = (values: readonly number[]): number | undefined => {
  const result = values.reduce((total, value) => total + value, 0)
  return Number.isSafeInteger(result) ? result : undefined
}

function requestUsage(value: unknown): TokenUsage | undefined {
  const usage = object(value)
  const inputTokens = count(usage.input)
  const outputTokens = count(usage.output)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cacheReadTokens = count(usage.cacheRead)
  const cacheWriteTokens = count(usage.cacheWrite)
  const reasoningTokens = count(usage.reasoning)
  if (
    (usage.cacheRead !== undefined && cacheReadTokens === undefined) ||
    (usage.cacheWrite !== undefined && cacheWriteTokens === undefined) ||
    (usage.reasoning !== undefined &&
      (reasoningTokens === undefined || reasoningTokens > outputTokens))
  )
    return undefined
  const known = sum([inputTokens, outputTokens, cacheReadTokens ?? 0, cacheWriteTokens ?? 0])
  if (known === undefined) return undefined
  const reportedTotal = count(usage.totalTokens)
  const totalTokens =
    reportedTotal !== undefined &&
    reportedTotal >= known &&
    (cacheReadTokens === undefined || cacheWriteTokens === undefined || reportedTotal === known)
      ? reportedTotal
      : undefined
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

/**
 * One ACP prompt's completed Pi requests; stream snapshots and history replay add nothing.
 * Each assistant message_start opens one slot and its message_end consumes that slot once.
 */
export class PiTurnUsage {
  private started = false
  private timestamp: unknown
  private invalid = false
  private readonly requests: TokenUsage[] = []
  private readonly responses = new Set<string>()

  constructor(
    private readonly provider: string,
    private readonly model: string,
  ) {}

  /** Clear all observations before dispatching a new prompt. */
  reset(): void {
    this.started = false
    this.timestamp = undefined
    this.invalid = false
    this.requests.length = 0
    this.responses.clear()
  }

  /** Consume events only while the bridge has an active prompt. */
  accept(value: unknown): void {
    const event = object(value)
    const message = object(event.message)
    if (message.role !== 'assistant') return
    if (event.type === 'message_start') {
      if (this.started) this.invalid = true
      this.started = true
      this.timestamp = message.timestamp
      return
    }
    if (event.type !== 'message_end' || !this.started) return
    this.started = false
    if (
      message.provider !== this.provider ||
      message.model !== this.model ||
      (this.timestamp !== undefined && message.timestamp !== this.timestamp)
    ) {
      this.invalid = true
      return
    }
    const responseId = typeof message.responseId === 'string' ? message.responseId : ''
    if (responseId && this.responses.has(responseId)) return
    if (responseId) this.responses.add(responseId)
    const usage = requestUsage(message.usage)
    if (!usage) {
      this.invalid = true
      return
    }
    if (
      usage.inputTokens +
        usage.outputTokens +
        (usage.cacheReadTokens ?? 0) +
        (usage.cacheWriteTokens ?? 0) ===
      0
    )
      return
    if (
      !['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred'].includes(
        String(message.stopReason),
      )
    ) {
      this.invalid = true
      return
    }
    this.requests.push(usage)
  }

  /** Return disjoint token buckets, withholding an incomplete or malformed aggregate. */
  snapshot(): TokenUsage | undefined {
    if (this.invalid || this.started || this.requests.length === 0) return undefined
    const inputTokens = sum(this.requests.map((usage) => usage.inputTokens))
    const outputTokens = sum(this.requests.map((usage) => usage.outputTokens))
    if (inputTokens === undefined || outputTokens === undefined) return undefined
    const result: TokenUsage = { inputTokens, outputTokens }
    for (const key of [
      'totalTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'reasoningTokens',
    ] as const) {
      if (this.requests.some((usage) => usage[key] === undefined)) continue
      const total = sum(this.requests.map((usage) => usage[key]!))
      if (total !== undefined) result[key] = total
    }
    return result
  }
}

/**
 * Read the installed Pi stats estimate only for the pinned model and exact session.
 * A null post-compaction estimate retains capacity without carrying an old occupancy.
 */
export function piContextUsage(
  stateValue: unknown,
  statsValue: unknown,
  expected: { sessionId: string; provider: string; model: string },
): { used?: number; size?: number; estimated?: boolean } | undefined {
  const state = object(stateValue)
  const model = object(state.model)
  if (
    state.sessionId !== expected.sessionId ||
    model.provider !== expected.provider ||
    model.id !== expected.model
  )
    return undefined
  const size = count(model.contextWindow)
  if (size === undefined || size === 0) return undefined
  if (statsValue === undefined) return { size }
  const stats = object(statsValue)
  const context = object(stats.contextUsage)
  const used = count(context.tokens)
  if (stats.sessionId !== expected.sessionId) return undefined
  if (context.contextWindow !== size) return undefined
  if (used === undefined || used > size) return { size }
  return { used, size, estimated: true }
}

/** Parse completed Pi assistant entries when RPC stream events omit provider identity. */
export function piSessionStatsUsage(
  statsValue: unknown,
  expected: { provider: string; model: string },
): TokenUsage | undefined {
  const stats = object(statsValue)
  const entries = Array.isArray(stats.entries) ? stats.entries : []
  const usages: TokenUsage[] = []
  for (const rawEntry of entries) {
    const entry = object(rawEntry)
    const message = object(entry.message)
    if (message.role !== 'assistant') continue
    const provider = typeof message.provider === 'string' ? message.provider : undefined
    const model = typeof message.model === 'string' ? message.model : undefined
    if (
      (provider !== undefined && provider !== expected.provider) ||
      (model !== undefined && model !== expected.model)
    )
      continue
    const usage = requestUsage(message.usage)
    if (
      usage &&
      usage.inputTokens +
        usage.outputTokens +
        (usage.cacheReadTokens ?? 0) +
        (usage.cacheWriteTokens ?? 0) >
        0
    )
      usages.push(usage)
  }
  if (usages.length === 0) return undefined
  const inputTokens = sum(usages.map((usage) => usage.inputTokens))
  const outputTokens = sum(usages.map((usage) => usage.outputTokens))
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const result: TokenUsage = { inputTokens, outputTokens }
  for (const key of [
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ] as const) {
    if (usages.some((usage) => usage[key] === undefined)) continue
    const total = sum(usages.map((usage) => usage[key]!))
    if (total !== undefined) result[key] = total
  }
  return result
}
