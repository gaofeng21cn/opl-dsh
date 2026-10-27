/** Exact per-user-turn usage read from OpenCode/Kilo's persisted message graph. */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { VendorMessage } from './message-edit-opencode-common.ts'

/** Usage and context facts attached to the exact user message that owns them. */
export interface ExternalUsageStatistics {
  usage?: TokenUsage
  contextUsage?: { used?: number; size?: number; estimated?: boolean }
}

type RequestUsage = TokenUsage

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

function add(values: readonly number[]): number | undefined {
  const total = values.reduce((sum, value) => sum + value, 0)
  return Number.isSafeInteger(total) ? total : undefined
}

function requestUsage(value: unknown): RequestUsage | undefined {
  const tokens = object(value)
  const inputTokens = integer(tokens.input)
  const rawOutput = integer(tokens.output)
  const cache = object(tokens.cache)
  const rawReasoning = tokens.reasoning ?? tokens.thoughtTokens
  const reasoningTokens = integer(rawReasoning)
  const cacheReadTokens = integer(cache.read)
  const cacheWriteTokens = integer(cache.write)
  if (
    inputTokens === undefined ||
    rawOutput === undefined ||
    (rawReasoning !== undefined && reasoningTokens === undefined) ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  )
    return undefined
  const outputTokens = add([rawOutput, reasoningTokens ?? 0])
  if (outputTokens === undefined) return undefined
  const known = add([inputTokens, outputTokens, cacheReadTokens ?? 0, cacheWriteTokens ?? 0])
  if (known === undefined) return undefined
  const sourceTotal = integer(tokens.total)
  return {
    inputTokens,
    outputTokens,
    ...(sourceTotal === known ? { totalTokens: sourceTotal } : {}),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

function sumRequests(requests: readonly RequestUsage[]): TokenUsage | undefined {
  if (requests.length === 0) return undefined
  const inputTokens = add(requests.map((usage) => usage.inputTokens))
  const outputTokens = add(requests.map((usage) => usage.outputTokens))
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const result: TokenUsage = { inputTokens, outputTokens }
  const keys = ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const
  for (const key of keys) {
    if (requests.some((usage) => usage[key] === undefined)) continue
    const total = add(requests.map((usage) => usage[key]!))
    if (total !== undefined) result[key] = total
  }
  const totalTokens = add([
    inputTokens,
    outputTokens,
    ...(result.cacheReadTokens === undefined ? [] : [result.cacheReadTokens]),
    ...(result.cacheWriteTokens === undefined ? [] : [result.cacheWriteTokens]),
  ])
  if (
    totalTokens !== undefined &&
    result.cacheReadTokens !== undefined &&
    result.cacheWriteTokens !== undefined &&
    requests.every((usage) => usage.totalTokens !== undefined)
  )
    result.totalTokens = totalTokens
  return result
}

function infoId(message: VendorMessage): string | undefined {
  const id = message.info.id
  return typeof id === 'string' && id ? id : undefined
}

function sourceModel(message: VendorMessage): string | undefined {
  const provider = message.info.providerID
  const model = message.info.modelID
  return typeof provider === 'string' && provider && typeof model === 'string' && model
    ? `${provider}/${model}`
    : undefined
}

function parentId(message: VendorMessage): string | undefined {
  const value = message.info.parentID
  return value === undefined || value === null
    ? undefined
    : typeof value === 'string' && value
      ? value
      : ''
}

function usageRequests(message: VendorMessage): RequestUsage[] | undefined {
  const parts = message.parts.filter((part) => part.type === 'step-finish')
  if (parts.length === 0) {
    const latest = requestUsage(message.info.tokens)
    const values = object(message.info.tokens)
    const nonzero = [
      values.input,
      values.output,
      object(values.cache).read,
      object(values.cache).write,
    ].some((value) => (integer(value) ?? 0) > 0)
    return latest && !nonzero ? [] : undefined
  }
  const ids = new Set<string>()
  const result: RequestUsage[] = []
  for (const part of parts) {
    const id = part.id
    if (typeof id !== 'string' || !id || ids.has(id)) return undefined
    ids.add(id)
    const usage = requestUsage(part.tokens)
    if (!usage) return undefined
    result.push(usage)
  }
  return result
}

function contextCapacity(providerValue: unknown, expectedModel: string): number | undefined {
  const providers = object(providerValue)
  if (!Array.isArray(providers.all)) return undefined
  const slash = expectedModel.indexOf('/')
  if (slash <= 0 || slash === expectedModel.length - 1) return undefined
  const expectedProvider = expectedModel.slice(0, slash)
  const expectedId = expectedModel.slice(slash + 1)
  for (const rawProvider of providers.all) {
    const provider = object(rawProvider)
    if (provider.id !== expectedProvider || !provider.models || typeof provider.models !== 'object')
      continue
    const model = object(object(provider.models)[expectedId])
    const limit = object(model.limit)
    if (model.id !== expectedId || model.providerID !== expectedProvider) return undefined
    const size = integer(limit.context)
    return size !== undefined && size > 0 ? size : undefined
  }
  return undefined
}

/**
 * Aggregate model requests under exact parent-ID user boundaries from one session read.
 * Assistant `info.tokens` is only the latest request; `step-finish` parts retain all calls.
 *
 * @param messages - public messages returned for the exact session.
 * @param sessionId - session identity returned by the control server.
 * @param expectedModel - exact ACP model value selected by the adapter.
 * @param providerListing - body of the official `GET /provider` response.
 * @returns statistics keyed by their exact vendor user message ids.
 */
export function summarizeOpenCodeKiloUsage(
  messages: readonly VendorMessage[],
  sessionId: string,
  expectedModel: string,
  providerListing: unknown,
): Map<string, ExternalUsageStatistics> {
  const result = new Map<string, ExternalUsageStatistics>()
  if (!sessionId || !expectedModel) return result
  const byId = new Map<string, VendorMessage>()
  for (const message of messages) {
    const id = infoId(message)
    if (
      !id ||
      byId.has(id) ||
      message.info.sessionID !== sessionId ||
      message.parts.some((part) => part.sessionID !== sessionId || part.messageID !== id)
    )
      return result
    byId.set(id, message)
  }

  const users = new Set(
    messages.filter((message) => message.info.role === 'user').map((message) => infoId(message)!),
  )
  const ownerOf = (message: VendorMessage): string | undefined => {
    let parent = parentId(message)
    const visited = new Set<string>()
    while (parent) {
      if (visited.has(parent)) return undefined
      visited.add(parent)
      if (users.has(parent)) return parent
      const previous = byId.get(parent)
      if (!previous) return undefined
      parent = parentId(previous)
    }
    return undefined
  }

  const requestsByUser = new Map<string, RequestUsage[]>()
  const contextsByUser = new Map<
    string,
    { messageId: string; model: string; used: number | undefined }[]
  >()
  const invalidUsers = new Set<string>()
  for (const message of messages) {
    if (message.info.role !== 'assistant') continue
    const owner = ownerOf(message)
    if (!owner) continue
    const model = sourceModel(message)
    if (model !== expectedModel) {
      invalidUsers.add(owner)
      continue
    }
    const requests = usageRequests(message)
    if (!requests) {
      invalidUsers.add(owner)
      continue
    }
    requestsByUser.set(owner, [...(requestsByUser.get(owner) ?? []), ...requests])
    const latest = requests.at(-1)
    if (!latest) continue
    const used =
      latest.cacheReadTokens === undefined || latest.cacheWriteTokens === undefined
        ? undefined
        : add([latest.inputTokens, latest.cacheReadTokens, latest.cacheWriteTokens])
    contextsByUser.set(owner, [
      ...(contextsByUser.get(owner) ?? []),
      { messageId: infoId(message)!, model, used },
    ])
  }

  const size = contextCapacity(providerListing, expectedModel)
  for (const userId of users) {
    if (invalidUsers.has(userId)) continue
    const usage = sumRequests(requestsByUser.get(userId) ?? [])
    const contexts = contextsByUser.get(userId) ?? []
    if (!usage && (!size || contexts.length === 0)) continue
    const statistics: ExternalUsageStatistics = {}
    if (usage) statistics.usage = usage
    if (size) {
      const descendsFrom = (message: VendorMessage, ancestorId: string): boolean => {
        let parent = parentId(message)
        const visited = new Set<string>()
        while (parent) {
          if (parent === ancestorId) return true
          if (visited.has(parent)) return false
          visited.add(parent)
          const previous = byId.get(parent)
          if (!previous) return false
          parent = parentId(previous)
        }
        return false
      }
      const leaves = contexts.filter(
        (candidate) =>
          !contexts.some(
            (other) =>
              other.messageId !== candidate.messageId &&
              descendsFrom(byId.get(other.messageId)!, candidate.messageId),
          ),
      )
      const latest = leaves.length === 1 ? leaves[0] : undefined
      const context =
        latest && latest.model === expectedModel
          ? { ...(latest.used === undefined ? {} : { used: latest.used }), size }
          : { size }
      statistics.contextUsage = context
    }
    result.set(userId, statistics)
  }
  return result
}
