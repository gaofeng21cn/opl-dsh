/** Native Harness usage normalization; this module does not own protocol state. */

/** ACP result metadata key for owned per-turn token accounting. */
export const NATIVE_TURN_USAGE_META = 'opl/turnUsage'
/** ACP result metadata key for a separate context occupancy reading. */
export const NATIVE_CONTEXT_USAGE_META = 'opl/contextUsage'
/** ACP update metadata key that marks estimated context occupancy. */
export const NATIVE_CONTEXT_ESTIMATED_META = 'opl/contextEstimated'

/** DSH token fields normalized from one complete native turn result. */
export interface NativeTokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** Native context occupancy kept separate from turn token accounting. */
export interface NativeContextUsage {
  used?: number
  size?: number
  estimated?: boolean
}

type UsageSemantics = 'input-inclusive-cache' | 'input-disjoint-cache'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function sum(values: number[]): number | undefined {
  const total = values.reduce((current, value) => current + value, 0)
  return Number.isSafeInteger(total) ? total : undefined
}

/** Parse one complete request or turn and project cache tokens into disjoint buckets. */
export function normalizeNativeUsage(
  value: unknown,
  semantics: UsageSemantics,
  names: {
    input?: string
    output?: string
    total?: string
    cacheRead?: string
    cacheWrite?: string
    reasoning?: string
  } = {},
): NativeTokenUsage | undefined {
  const usage = object(value)
  const input = integer(usage[names.input ?? 'inputTokens'])
  const output = integer(usage[names.output ?? 'outputTokens'])
  if (input === undefined || output === undefined) return undefined
  const cacheRead = integer(usage[names.cacheRead ?? 'cacheReadTokens'])
  const cacheWrite = integer(usage[names.cacheWrite ?? 'cacheWriteTokens'])
  const reasoning = integer(usage[names.reasoning ?? 'reasoningTokens'])
  for (const key of [
    names.cacheRead ?? 'cacheReadTokens',
    names.cacheWrite ?? 'cacheWriteTokens',
    names.reasoning ?? 'reasoningTokens',
  ])
    if (usage[key] !== undefined && integer(usage[key]) === undefined) return undefined
  const rawTotalValue = usage[names.total ?? 'totalTokens']
  const rawTotal = rawTotalValue === undefined ? undefined : integer(rawTotalValue)
  if (rawTotalValue !== undefined && rawTotal === undefined) return undefined
  if (reasoning !== undefined && reasoning > output) return undefined

  const cacheReadTokens = cacheRead
  const cacheWriteTokens = cacheWrite
  let inputTokens = input
  if (semantics === 'input-inclusive-cache') {
    const cacheCount = sum([cacheRead ?? 0, cacheWrite ?? 0])
    if (cacheCount === undefined || cacheCount > input) return undefined
    inputTokens -= cacheCount
  }

  const promptTotal = sum([inputTokens, cacheReadTokens ?? 0, cacheWriteTokens ?? 0])
  const totalTokens = promptTotal === undefined ? undefined : sum([promptTotal, output])
  if (totalTokens === undefined) return undefined
  if (rawTotal !== undefined && rawTotal !== totalTokens) return undefined
  if (totalTokens === 0) return undefined

  return {
    inputTokens,
    outputTokens: output,
    totalTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/** Build one context reading without treating it as billed token usage. */
export function normalizeNativeContextUsage(value: unknown): NativeContextUsage | undefined {
  const context = object(value)
  const usedValue = context.used
  const sizeValue = context.size
  const used = usedValue === undefined ? undefined : integer(usedValue)
  const size = sizeValue === undefined ? undefined : integer(sizeValue)
  if (
    (usedValue !== undefined && used === undefined) ||
    (sizeValue !== undefined && size === undefined)
  )
    return undefined
  if (used === undefined && size === undefined) return undefined
  if (size === 0 || (used !== undefined && size !== undefined && used > size)) return undefined
  return {
    ...(used === undefined ? {} : { used }),
    ...(size === undefined ? {} : { size }),
    ...(typeof context.estimated === 'boolean' ? { estimated: context.estimated } : {}),
  }
}

/** Shape owned bridge turn usage for the parent parser. */
export function nativeTurnUsageMeta(usage: NativeTokenUsage | undefined): object | undefined {
  return usage ? { [NATIVE_TURN_USAGE_META]: { version: 1, usage } } : undefined
}

/** Shape context metadata while keeping it separate from request accounting. */
export function nativeContextUsageMeta(
  context: NativeContextUsage | undefined,
): object | undefined {
  return context ? { [NATIVE_CONTEXT_USAGE_META]: context } : undefined
}

/** ACP context updates require a complete used/size pair. */
export function nativeContextUpdate(context: NativeContextUsage | undefined): object | undefined {
  if (context?.used === undefined || context.size === undefined) return undefined
  return {
    sessionUpdate: 'usage_update',
    used: context.used,
    size: context.size,
    ...(context.estimated === undefined
      ? {}
      : { _meta: { [NATIVE_CONTEXT_ESTIMATED_META]: context.estimated } }),
  }
}

type CodexCounters = {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

function codexCounters(value: unknown): CodexCounters | undefined {
  const source = object(value)
  const keys = {
    totalTokens: 'totalTokens',
    inputTokens: 'inputTokens',
    cachedInputTokens: 'cachedInputTokens',
    cacheWriteInputTokens: 'cacheWriteInputTokens',
    outputTokens: 'outputTokens',
    reasoningOutputTokens: 'reasoningOutputTokens',
  } as const
  const counters = {} as CodexCounters
  for (const [target, key] of Object.entries(keys)) {
    const next = integer(source[key])
    if (next === undefined) return undefined
    counters[target as keyof CodexCounters] = next
  }
  const prompt = sum([counters.inputTokens, counters.outputTokens])
  if (prompt === undefined || counters.totalTokens !== prompt) return undefined
  if (counters.cachedInputTokens + counters.cacheWriteInputTokens > counters.inputTokens)
    return undefined
  if (counters.reasoningOutputTokens > counters.outputTokens) return undefined
  return counters
}

/**
 * Differences Codex's cumulative thread counters against an observed idle baseline.
 * Restored threads without a baseline omit usage until a later complete turn.
 */
export class CodexTurnUsageTracker {
  private activeTurnId: string | undefined
  private active = false
  private previousTotal: CodexCounters | undefined
  private baseline: CodexCounters | undefined
  private usage: NativeTokenUsage | undefined
  private invalid = false
  private newThread = false
  private pending: unknown[] = []

  /** Start accounting before turn/start; bind its returned id without clearing usage. */
  beginTurn(): void {
    this.active = true
    this.activeTurnId = undefined
    this.baseline = this.previousTotal
    this.usage = undefined
    this.invalid = false
    this.pending = []
  }

  /** Bind the live turn and accept usage notifications that preceded the start reply. */
  bindTurn(turnId: string): { usage?: NativeTokenUsage; context?: NativeContextUsage } | undefined {
    this.activeTurnId = turnId
    let latest: { usage?: NativeTokenUsage; context?: NativeContextUsage } | undefined
    for (const notification of this.pending.splice(0))
      if (object(notification).turnId === turnId) latest = this.accept(notification) ?? latest
    return latest
  }

  /** Forget the cumulative baseline after a thread rewind or session switch. */
  reset(newThread = false): void {
    this.active = false
    this.activeTurnId = undefined
    this.previousTotal = undefined
    this.baseline = undefined
    this.usage = undefined
    this.invalid = false
    this.newThread = newThread
    this.pending = []
  }

  /** Record an idle resume snapshot or a notification attributed to the current turn. */
  accept(value: unknown): { usage?: NativeTokenUsage; context?: NativeContextUsage } | undefined {
    const notification = object(value)
    const tokenUsage = object(notification.tokenUsage)
    const total = codexCounters(tokenUsage.total)
    const last = codexCounters(tokenUsage.last)
    if (this.active && !this.activeTurnId) {
      if (this.pending.length < 16) this.pending.push(value)
      return undefined
    }
    if (this.active && notification.turnId !== this.activeTurnId) {
      return undefined
    }
    const context = normalizeNativeContextUsage({
      ...(last ? { used: last.totalTokens } : {}),
      ...(integer(tokenUsage.modelContextWindow) ? { size: tokenUsage.modelContextWindow } : {}),
      estimated: true,
    })
    if (!total || !last) {
      if (this.active && notification.turnId === this.activeTurnId) {
        this.invalid = true
        this.previousTotal = undefined
      }
      return context ? { context } : undefined
    }
    if (this.active) {
      if (!this.baseline && this.newThread && equalCodexCounters(total, last))
        this.baseline = emptyCodexCounters()
      if (!this.baseline) this.invalid = true
      if (
        this.previousTotal &&
        (Object.keys(total) as (keyof CodexCounters)[]).some(
          (key) => total[key] < this.previousTotal![key],
        )
      )
        this.invalid = true
      if (!this.invalid && this.baseline) {
        const delta = {} as CodexCounters
        for (const key of Object.keys(total) as (keyof CodexCounters)[])
          delta[key] = total[key] - this.baseline[key]
        this.usage = equalCodexCounters(delta, emptyCodexCounters())
          ? undefined
          : normalizeCodexUsage(delta)
        if (!this.usage && delta.totalTokens !== 0) this.invalid = true
      } else if (this.invalid) {
        this.usage = undefined
      }
    }
    this.previousTotal = total
    return {
      ...(this.current() ? { usage: this.current()! } : {}),
      ...(context ? { context } : {}),
    }
  }

  /** Return the accumulated usage for the active turn. */
  current(): NativeTokenUsage | undefined {
    return this.invalid ? undefined : this.usage
  }

  /** Preserve the latest observed cumulative baseline when a turn settles. */
  endTurn(): void {
    this.active = false
    this.activeTurnId = undefined
    this.newThread = false
  }
}

function emptyCodexCounters(): CodexCounters {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  }
}

function equalCodexCounters(left: CodexCounters, right: CodexCounters): boolean {
  return (Object.keys(left) as (keyof CodexCounters)[]).every((key) => left[key] === right[key])
}

/** Codex input includes cache buckets and its output already includes reasoning. */
export function normalizeCodexUsage(value: unknown): NativeTokenUsage | undefined {
  return normalizeNativeUsage(value, 'input-inclusive-cache', {
    cacheRead: 'cachedInputTokens',
    cacheWrite: 'cacheWriteInputTokens',
    reasoning: 'reasoningOutputTokens',
  })
}

/** Claude result.usage is per-turn main-loop usage; modelUsage is session cumulative. */
export function normalizeClaudeTurnUsage(value: unknown): NativeTokenUsage | undefined {
  return normalizeNativeUsage(object(value).usage, 'input-disjoint-cache', {
    input: 'input_tokens',
    output: 'output_tokens',
    cacheRead: 'cache_read_input_tokens',
    cacheWrite: 'cache_creation_input_tokens',
    reasoning: 'thinking_tokens',
  })
}

/** Read only the selected main model's advertised capacity from Claude cumulative records. */
export function claudeContextCapacity(
  value: unknown,
  model: string,
): NativeContextUsage | undefined {
  const models = object(object(value).modelUsage)
  const capacity = object(models[model]).contextWindow
  return normalizeNativeContextUsage({ ...(capacity === undefined ? {} : { size: capacity }) })
}

/** ZCode turn.completed.payload.usage is a full turn aggregate with inclusive input. */
export function normalizeZcodeTurnUsage(value: unknown): NativeTokenUsage | undefined {
  const usage = object(object(value).payload).usage
  const normalized = normalizeNativeUsage(usage, 'input-inclusive-cache')
  if (!normalized) return undefined
  const summary = object(usage)
  const summaryFields = [
    ['totalTokens', summary.totalTokens],
    ['cacheReadTokens', summary.cacheReadTokens],
    ['cacheWriteTokens', summary.cacheWriteTokens],
    ['reasoningTokens', summary.reasoningTokens],
  ] as const
  for (const [key, raw] of summaryFields) {
    if (raw === undefined) continue
    const count = integer(raw)
    if (count === undefined) return undefined
    if (key === 'totalTokens' && count !== normalized.totalTokens) return undefined
    if (key === 'cacheReadTokens' && count !== normalized.cacheReadTokens) return undefined
    if (key === 'cacheWriteTokens' && count !== normalized.cacheWriteTokens) return undefined
    if (key === 'reasoningTokens' && count !== normalized.reasoningTokens) return undefined
  }
  return normalized
}

/** ZCode snapshots carry active context independently of cumulative projection tokenCount. */
export function zcodeSnapshotContext(value: unknown): NativeContextUsage | undefined {
  const context = object(object(value).runtime).contextUsage
  return normalizeNativeContextUsage(context)
}
