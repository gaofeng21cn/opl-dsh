/**
 * Focused behaviour tests for the read-only context-budget Host.
 *
 * Everything below drives real official code: real `Session` event logs, the
 * real `SessionProjectionRegistry` drive, and the real Remote service class.
 * Only two seams are substituted, because neither is reachable here:
 *
 *  - `ctx.sessions` / `ctx.llm` are the official service keys, filled with the
 *    smallest public face this view reads. No model is called and no provider
 *    metadata is invented by the service.
 *  - the `contextPressure` and `modelSelection` units are reproduced from the
 *    verified official rc.2 definitions, because `@deepseek-ai/dsh-token-meter`
 *    ships inside the desktop application and is not a repository dependency.
 *    They exercise the real registry registration/absence/fold path; they are
 *    NOT evidence about the official units themselves.
 */
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import ContextBudgetService from '../../src/context-budget/host/service.ts'
import {
  buildBudgetSnapshot,
  type BudgetSnapshotInput,
} from '../../src/context-budget/host/observe.ts'
import type { ContextBudgetSnapshot } from '../../src/context-budget/contracts/budget.ts'

const cleanups: (() => unknown)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

/** The official `contextPressure` wire view shape (`pressureSchema`), reproduced. */
const pressureViewSchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  pressureTokens: z.number().int().nonnegative().optional(),
  projectedTokens: z.number().int().nonnegative().optional(),
})
const pressureStateSchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  pressureTokens: z.number().int().nonnegative().optional(),
  surfaceTokens: z.number().int().nonnegative(),
  sampledSurfaceTokens: z.number().int().nonnegative().optional(),
})

/** Register the reproduced `contextPressure` unit on a real registry. */
function registerPressure(registry: SessionProjectionRegistry): void {
  registry.register({
    key: 'contextPressure',
    stateVersion: 5,
    stateSchema: pressureStateSchema,
    init: () => ({ surfaceTokens: 0 }),
    apply: (state, event) => {
      if (event.type === 'request/context') {
        const contextWindow = event.data.contextWindow
        return contextWindow === undefined ? state : { ...state, contextWindow }
      }
      if (event.type !== 'assistant/message') return state
      const usage = event.data.usage
      if (usage === undefined) return state
      const pressureTokens =
        usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      return { ...state, pressureTokens, sampledSurfaceTokens: state.surfaceTokens }
    },
    wire: {
      viewSchema: pressureViewSchema,
      view: ({ contextWindow, pressureTokens, surfaceTokens, sampledSurfaceTokens }) => ({
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(pressureTokens === undefined ? {} : { pressureTokens }),
        ...(pressureTokens === undefined || sampledSurfaceTokens === undefined
          ? {}
          : {
              projectedTokens: Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens),
            }),
      }),
    },
  })
}

/** Register the official selection fold shape (`lastUsed` / `pending`), reproduced. */
const routeSchema = z.object({ provider: z.string(), model: z.string() })
function registerSelection(registry: SessionProjectionRegistry): void {
  registry.register({
    key: 'modelSelection',
    stateVersion: 2,
    stateSchema: z.object({ lastUsed: routeSchema.nullable(), pending: routeSchema.nullable() }),
    init: () => ({ lastUsed: null, pending: null }),
    apply: (state, event) =>
      event.type === 'model/selection' ? { lastUsed: state.lastUsed, pending: event.data } : state,
    wire: {
      viewSchema: z.object({ lastUsed: routeSchema.nullable(), next: routeSchema.nullable() }),
      view: (state) => ({ lastUsed: state.lastUsed, next: state.pending ?? state.lastUsed }),
    },
  })
}

interface LlmStub {
  listProviders(): { id: string; name: string }[]
  resolveModelInfo(
    provider: string,
    model: string,
  ): Promise<{ context?: { contextWindow: number }; defaultMaxTokens?: number }>
}

interface MountOptions {
  session?: Session
  llm?: LlmStub
  withPressure?: boolean
  withSelection?: boolean
}

/** Mount the service against a real Session log and the official registry. */
async function mount(options: MountOptions = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const session = options.session ?? emptySession('session-budget')

  ctx.provide('sessions', { get: (id: SessionId) => (id === session.id ? session : undefined) })
  const llm: LlmStub = options.llm ?? {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    resolveModelInfo: async () => ({}),
  }
  ctx.provide('llm', llm)

  const registry = new SessionProjectionRegistry(ctx)
  if (options.withPressure !== false) registerPressure(registry)
  if (options.withSelection !== false) registerSelection(registry)

  await ctx.plugin(ContextBudgetService)
  const service = (ctx as unknown as { oplContextBudget: ContextBudgetService }).oplContextBudget
  return { ctx, service, session, registry }
}

function emptySession(id: string): Session {
  return Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: Date.now(),
    isSeeded: false,
  })
}

/** Append one durable route context for turn 1, without any request header. */
function recordRouteContext(
  session: Session,
  input: { provider: string; model: string; contextWindow?: number },
): void {
  session.append('turn/start', { turn: 1 })
  session.append('request/context', {
    provider: input.provider,
    model: input.model,
    ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
  })
}

/** Append one durable request header (and optional route context) for turn 1. */
function recordRequest(
  session: Session,
  input: {
    provider: string
    model: string
    maxTokens?: number
    contextWindow?: number
    reason?: 'initial' | 'change' | 'series'
  },
): void {
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: {
      config: {
        provider: input.provider,
        model: input.model,
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      },
    },
    reason: input.reason ?? 'initial',
  })
  if (input.contextWindow !== undefined) {
    session.append('request/context', {
      provider: input.provider,
      model: input.model,
      contextWindow: input.contextWindow,
    })
  }
}

/** Append one settled assistant message carrying provider usage. */
function recordUsage(session: Session, inputTokens: number): void {
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'ok' }] }),
      stream: [],
      usage: { inputTokens, outputTokens: 4 },
    },
    { surfaceOp: 'append' },
  )
}

function metricOf(snapshot: ContextBudgetSnapshot, key: string) {
  return snapshot.metrics.find((metric) => metric.key === key)!
}

const KEYS = [
  'context-window',
  'request-output-limit',
  'declared-output-limit',
  'projected-input',
  'pressure',
  'compaction-threshold',
  'compaction-retain',
]

describe('context budget Host observation', () => {
  it('separates declaration, persisted request header and current projection sources', async () => {
    const session = emptySession('session-budget')
    recordRequest(session, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      maxTokens: 256000,
      contextWindow: 1000000,
    })
    recordUsage(session, 1234)

    const { service } = await mount({
      session,
      llm: {
        listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
        resolveModelInfo: async () => ({
          context: { contextWindow: 1000000 },
          defaultMaxTokens: 8192,
        }),
      },
    })

    const snapshot = await service.read({ sessionId: 'session-budget' })

    expect(snapshot.metrics.map((metric) => metric.key)).toEqual(KEYS)
    // No public execution-identity seam is verified, so it stays unknown.
    expect(snapshot.execution).toBe('unknown')
    expect(snapshot.provider).toBe('deepseek')
    expect(snapshot.model).toBe('deepseek-flash')
    expect(snapshot.sessionId).toBe('session-budget')
    expect(Date.parse(snapshot.observedAt)).not.toBeNaN()

    // The recorded route metadata still names this route, so it is the live capacity.
    expect(metricOf(snapshot, 'context-window')).toEqual({
      key: 'context-window',
      value: 1000000,
      source: 'session-projection',
    })
    expect(metricOf(snapshot, 'request-output-limit')).toEqual({
      key: 'request-output-limit',
      value: 256000,
      source: 'request-header',
    })
    expect(metricOf(snapshot, 'declared-output-limit')).toEqual({
      key: 'declared-output-limit',
      value: 8192,
      source: 'adapter-declaration',
    })
    // Token counts, never percentages.
    expect(metricOf(snapshot, 'pressure')).toEqual({
      key: 'pressure',
      value: 1234,
      source: 'session-projection',
    })
    expect(metricOf(snapshot, 'projected-input')).toEqual({
      key: 'projected-input',
      value: 1234,
      source: 'session-projection',
    })
    // No public read exposes the effective compaction policy.
    expect(metricOf(snapshot, 'compaction-threshold')).toEqual({
      key: 'compaction-threshold',
      value: null,
      source: 'unavailable',
    })
    expect(metricOf(snapshot, 'compaction-retain')).toEqual({
      key: 'compaction-retain',
      value: null,
      source: 'unavailable',
    })
    for (const metric of snapshot.metrics)
      expect(metric.value === null || Number.isSafeInteger(metric.value)).toBe(true)

    expect(snapshot.warnings).toEqual(['declaration-only', 'policy-unknown'])
  })

  it('falls back to the registered adapter declaration when no route was recorded', async () => {
    const session = emptySession('session-budget')
    recordRequest(session, { provider: 'deepseek', model: 'deepseek-flash', maxTokens: 4096 })

    const { service } = await mount({
      session,
      llm: {
        listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
        resolveModelInfo: async () => ({ context: { contextWindow: 65536 } }),
      },
    })
    const snapshot = await service.read({ sessionId: 'session-budget' })

    expect(metricOf(snapshot, 'context-window')).toEqual({
      key: 'context-window',
      value: 65536,
      source: 'adapter-declaration',
    })
    expect(metricOf(snapshot, 'declared-output-limit').value).toBeNull()
    expect(snapshot.warnings).toEqual(['declaration-only', 'policy-unknown', 'read-unavailable'])
  })

  it('never pairs a superseded request with a pending model selection', async () => {
    const session = emptySession('session-budget')
    recordRequest(session, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      maxTokens: 256000,
      contextWindow: 1000000,
    })
    recordUsage(session, 1234)
    session.append('model/selection', { provider: 'other', model: 'other-large' })

    const { service } = await mount({
      session,
      llm: {
        listProviders: () => [{ id: 'other', name: 'Other' }],
        resolveModelInfo: async () => ({ context: { contextWindow: 512000 } }),
      },
    })
    const snapshot = await service.read({ sessionId: 'session-budget' })

    expect(snapshot.provider).toBe('other')
    expect(snapshot.model).toBe('other-large')
    // The new route's declaration is used; the old request's numbers are withheld.
    expect(metricOf(snapshot, 'context-window')).toEqual({
      key: 'context-window',
      value: 512000,
      source: 'adapter-declaration',
    })
    expect(metricOf(snapshot, 'request-output-limit')).toEqual({
      key: 'request-output-limit',
      value: null,
      source: 'unavailable',
    })
    expect(metricOf(snapshot, 'pressure')).toEqual({
      key: 'pressure',
      value: null,
      source: 'unavailable',
    })
    expect(metricOf(snapshot, 'projected-input')).toEqual({
      key: 'projected-input',
      value: null,
      source: 'unavailable',
    })
    expect(snapshot.warnings).toContain('read-unavailable')
    expect(snapshot.warnings).toContain('declaration-only')
  })

  it('withholds pressure when no header exists and request/context names an older route', async () => {
    const session = emptySession('session-budget')
    recordRouteContext(session, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      contextWindow: 1000000,
    })
    recordUsage(session, 900)
    session.append('model/selection', { provider: 'other', model: 'other-large' })

    const { service } = await mount({
      session,
      llm: {
        listProviders: () => [{ id: 'other', name: 'Other' }],
        resolveModelInfo: async () => ({ context: { contextWindow: 512000 } }),
      },
    })
    const snapshot = await service.read({ sessionId: 'session-budget' })

    // A missing header alone must not make the stale projection look current.
    expect(snapshot.provider).toBe('other')
    expect(metricOf(snapshot, 'pressure').value).toBeNull()
    expect(metricOf(snapshot, 'projected-input').value).toBeNull()
    expect(metricOf(snapshot, 'context-window')).toEqual({
      key: 'context-window',
      value: 512000,
      source: 'adapter-declaration',
    })
    expect(snapshot.warnings).toEqual(['declaration-only', 'policy-unknown', 'read-unavailable'])
  })

  it('re-reads instead of publishing a cut resolved before a late model switch', async () => {
    const session = emptySession('session-budget')
    recordRequest(session, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      maxTokens: 256000,
      contextWindow: 1000000,
    })
    recordUsage(session, 1234)

    let switched = false
    const { service } = await mount({
      session,
      llm: {
        listProviders: () => [
          { id: 'deepseek', name: 'DeepSeek' },
          { id: 'other', name: 'Other' },
        ],
        resolveModelInfo: async (provider) => {
          if (!switched) {
            // A selection lands while the exact-model lookup is in flight.
            switched = true
            session.append('model/selection', { provider: 'other', model: 'other-large' })
          }
          return provider === 'other'
            ? { context: { contextWindow: 512000 } }
            : { context: { contextWindow: 1000000 }, defaultMaxTokens: 8192 }
        },
      },
    })

    const snapshot = await service.read({ sessionId: 'session-budget' })

    expect(snapshot.provider).toBe('other')
    expect(snapshot.model).toBe('other-large')
    expect(metricOf(snapshot, 'context-window')).toEqual({
      key: 'context-window',
      value: 512000,
      source: 'adapter-declaration',
    })
    // The numbers read under the superseded route are not published.
    expect(metricOf(snapshot, 'request-output-limit').value).toBeNull()
    expect(metricOf(snapshot, 'pressure').value).toBeNull()
    expect(snapshot.warnings).toContain('read-unavailable')
  })

  it('publishes unknown when the public records move on every bounded attempt', async () => {
    const session = emptySession('session-budget')
    recordRequest(session, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      maxTokens: 256000,
      contextWindow: 1000000,
    })
    recordUsage(session, 1234)

    let selection = 0
    let lookups = 0
    const { service } = await mount({
      session,
      llm: {
        listProviders: () => [
          { id: 'deepseek', name: 'DeepSeek' },
          { id: 'rotating', name: 'Rotating' },
        ],
        resolveModelInfo: async () => {
          // A fresh selection lands during every exact-model lookup.
          lookups += 1
          selection += 1
          session.append('model/selection', {
            provider: 'rotating',
            model: `model-${selection}`,
          })
          return { context: { contextWindow: 1000000 } }
        },
      },
    })

    const snapshot = await service.read({ sessionId: 'session-budget' })

    // Exactly one bounded re-read, then unknown rather than a stale pairing.
    expect(lookups).toBe(2)
    expect(snapshot.execution).toBe('unknown')
    expect(snapshot.metrics.every((metric) => metric.value === null)).toBe(true)
    expect(snapshot.warnings).toEqual(['policy-unknown', 'read-unavailable'])
  })

  it('reports a missing projection and an undeclared route budget as unknown', async () => {
    const session = emptySession('session-budget')
    recordRequest(session, { provider: 'external', model: 'external-model', maxTokens: 2048 })

    const { service } = await mount({
      session,
      withPressure: false,
      llm: {
        listProviders: () => [{ id: 'external', name: 'External' }],
        resolveModelInfo: async () => ({}),
      },
    })
    const snapshot = await service.read({ sessionId: 'session-budget' })

    // Missing metadata is missing data, not evidence of an external Harness.
    expect(snapshot.execution).toBe('unknown')
    expect(snapshot.warnings).not.toContain('harness-managed')
    expect(metricOf(snapshot, 'context-window').value).toBeNull()
    expect(metricOf(snapshot, 'declared-output-limit').value).toBeNull()
    expect(metricOf(snapshot, 'pressure').value).toBeNull()
    // The persisted header still describes the effective route.
    expect(metricOf(snapshot, 'request-output-limit').value).toBe(2048)
    expect(snapshot.warnings).toEqual(['policy-unknown', 'read-unavailable'])
  })

  it('keeps an unregistered provider unknown instead of using a catalog default', async () => {
    const session = emptySession('session-budget')
    recordRequest(session, { provider: 'acp-harness', model: 'harness-model' })

    const { service } = await mount({
      session,
      llm: { listProviders: () => [], resolveModelInfo: async () => ({}) },
    })
    const snapshot = await service.read({ sessionId: 'session-budget' })

    expect(snapshot.execution).toBe('unknown')
    expect(snapshot.provider).toBe('acp-harness')
    expect(snapshot.metrics.every((metric) => metric.value === null)).toBe(true)
    expect(snapshot.warnings).not.toContain('harness-managed')
  })

  it('keeps a Session with no recorded route unknown', async () => {
    const { service } = await mount()
    const snapshot = await service.read({ sessionId: 'session-budget' })

    expect(snapshot.execution).toBe('unknown')
    expect(snapshot.provider).toBeNull()
    expect(snapshot.model).toBeNull()
    expect(snapshot.metrics).toHaveLength(7)
    expect(snapshot.metrics.every((metric) => metric.value === null)).toBe(true)
    expect(snapshot.warnings).toEqual(['policy-unknown'])
  })

  it('turns a failed public read into unknown plus read-unavailable', async () => {
    const session = emptySession('session-budget')
    recordRequest(session, { provider: 'deepseek', model: 'deepseek-flash' })
    const { service } = await mount({
      session,
      llm: {
        listProviders: () => {
          throw new Error('provider directory unavailable')
        },
        resolveModelInfo: async () => ({ context: { contextWindow: 1 } }),
      },
    })
    const snapshot = await service.read({ sessionId: 'session-budget' })

    expect(snapshot.execution).toBe('unknown')
    expect(metricOf(snapshot, 'context-window').value).toBeNull()
    expect(snapshot.warnings).toContain('read-unavailable')
  })

  it('answers unknown Sessions, invalid requests and failures with fixed diagnostics only', async () => {
    const secret = 'sk-synthetic-must-never-appear'
    const { service } = await mount()

    await expect(service.read({ sessionId: 'missing' })).rejects.toMatchObject({
      code: 'context-budget/session-not-found',
      message: 'No live session has the requested id.',
      details: {},
    })
    await expect(service.read({} as { sessionId: string })).rejects.toMatchObject({
      code: 'gateway/bad-request',
      details: {},
    })
    await expect(service.read({ sessionId: '   ' })).rejects.toMatchObject({
      code: 'gateway/bad-request',
    })

    const broken = {
      id: SessionId('session-budget'),
      requestHeader() {
        throw new Error(`raw provider failure ${secret}`)
      },
      requestContext() {
        return undefined
      },
    } as unknown as Session
    const failing = await mount({ session: broken })
    const error = await failing.service.read({ sessionId: 'session-budget' }).then(
      () => undefined,
      (caught: unknown) =>
        caught as { code: string; message: string; details: unknown; cause?: unknown },
    )
    expect(error?.code).toBe('context-budget/read-failed')
    expect(error?.message).toBe('The context budget could not be read.')
    expect(error?.cause).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it('installs and disposes with the owning fiber without any residual registration', async () => {
    const ctx = new Context()
    const session = emptySession('session-budget')
    ctx.provide('sessions', { get: () => session })
    ctx.provide('llm', { listProviders: () => [], resolveModelInfo: async () => ({}) })
    const registry = new SessionProjectionRegistry(ctx)
    const plugin = await ctx.plugin(ContextBudgetService)

    // A disposed Cordis context refuses property reads, so read defensively.
    const installed = (): unknown => {
      try {
        return (ctx as unknown as { oplContextBudget?: unknown }).oplContextBudget
      } catch {
        return undefined
      }
    }
    expect(installed()).toBeTruthy()
    // The service registers no projection of its own and subscribes to nothing.
    expect(registry.snapshot(session, ['contextPressure']).values).toEqual({})

    // Cordis settles an unload on a later tick.
    plugin.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(installed()).toBeUndefined()
  })
})

/** A fully coherent read, as it would look if every record agreed. */
function coherentInput(): BudgetSnapshotInput {
  const route = { provider: 'registered', model: 'current-model' }
  return {
    sessionId: 'session-budget',
    observedAt: '2026-10-10T18:33:40.908Z',
    selection: { lastUsed: route, pending: null },
    requestHeader: { ...route, maxTokens: 200 },
    requestContext: { ...route, contextWindow: 1000 },
    pressure: { contextWindow: 1000, pressureTokens: 350, projectedTokens: 400 },
    pressureStatus: 'read',
    route: { adapter: { contextWindow: 1000, defaultMaxTokens: 64 }, failed: false },
  }
}

describe('context budget incoherent-observation contract', () => {
  it('publishes no number at all once the read has moved', () => {
    // Control: the same input without drift does publish numbers.
    expect(buildBudgetSnapshot(coherentInput()).metrics.some((m) => m.value !== null)).toBe(true)

    const drifted = buildBudgetSnapshot({ ...coherentInput(), drifted: true })
    expect(drifted.metrics.every((metric) => metric.value === null)).toBe(true)
    expect(drifted.provider).toBeNull()
    expect(drifted.model).toBeNull()
    expect(drifted.execution).toBe('unknown')
    expect(drifted.warnings).toEqual(['policy-unknown', 'read-unavailable'])
  })

  it('publishes no number when the selection fold could not be read', () => {
    const unreadable = buildBudgetSnapshot({ ...coherentInput(), selectionStatus: 'failed' })
    expect(unreadable.metrics.every((metric) => metric.value === null)).toBe(true)
    expect(unreadable.model).toBeNull()
    expect(unreadable.warnings).toContain('read-unavailable')

    // A normally absent fold is not a failure: the durable header still routes.
    const absent = buildBudgetSnapshot({ ...coherentInput(), selectionStatus: 'absent' })
    expect(absent.model).toBe('current-model')
    expect(absent.metrics.some((metric) => metric.value !== null)).toBe(true)
  })

  it('withholds numbers when both durable records keep moving, even once they match', async () => {
    const session = emptySession('session-budget')
    recordRequest(session, {
      provider: 'deepseek',
      model: 'model-0',
      maxTokens: 100,
      contextWindow: 1000,
    })
    recordUsage(session, 50)

    let lookups = 0
    const { service } = await mount({
      session,
      llm: {
        listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
        resolveModelInfo: async () => {
          lookups += 1
          // Header and context move together, so the last pair is coherent.
          session.append('request/header', {
            header: {
              config: {
                provider: 'deepseek',
                model: `model-${lookups}`,
                maxTokens: 100 + lookups,
              },
            },
            reason: 'change',
          })
          session.append('request/context', {
            provider: 'deepseek',
            model: `model-${lookups}`,
            contextWindow: 1000,
          })
          return { context: { contextWindow: 1000 } }
        },
      },
    })

    const snapshot = await service.read({ sessionId: 'session-budget' })

    expect(lookups).toBe(2)
    expect(snapshot.metrics.every((metric) => metric.value === null)).toBe(true)
    expect(snapshot.model).toBeNull()
    expect(snapshot.provider).toBeNull()
    expect(snapshot.warnings).toEqual(['policy-unknown', 'read-unavailable'])
  })

  it('keeps a selection read failure instead of promoting the last request header', async () => {
    const session = emptySession('session-budget')
    recordRequest(session, {
      provider: 'deepseek',
      model: 'old',
      maxTokens: 100,
      contextWindow: 1000,
    })
    recordUsage(session, 50)
    session.append('model/selection', { provider: 'deepseek', model: 'pending' })

    const { service, registry } = await mount({ session })
    const failing = registry as unknown as { stateOf(session: Session, key: string): never }
    failing.stateOf = () => {
      throw new Error('owned synthetic selection read failure')
    }

    const snapshot = await service.read({ sessionId: 'session-budget' })

    expect(snapshot.warnings).toContain('read-unavailable')
    expect(snapshot.metrics.every((metric) => metric.value === null)).toBe(true)
    expect(snapshot.model).toBeNull()
    expect(snapshot.provider).toBeNull()
  })

  it('still routes from the durable header when the selection fold is simply absent', async () => {
    const session = emptySession('session-budget')
    recordRequest(session, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      maxTokens: 4096,
      contextWindow: 1000,
    })
    recordUsage(session, 10)

    const { service } = await mount({
      session,
      withSelection: false,
      llm: {
        listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
        resolveModelInfo: async () => ({ context: { contextWindow: 65536 } }),
      },
    })
    const snapshot = await service.read({ sessionId: 'session-budget' })

    expect(snapshot.model).toBe('deepseek-flash')
    expect(metricOf(snapshot, 'context-window').value).toBe(1000)
    expect(metricOf(snapshot, 'pressure').value).toBe(10)
    expect(snapshot.model).not.toBeNull()
  })
})
