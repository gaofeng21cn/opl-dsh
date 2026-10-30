/**
 * Focused unit checks for the Auto Review route policy and the external-Harness
 * permission bridge contract.
 *
 * These drive the real exported resolvers over the real shared DTOs. The LLM
 * directory is the smallest public face `listAdvertisedRoutes` reads; no model
 * is called and no provider metadata is invented by the code under test.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OPENAI_AUTO_REVIEW_ROUTE,
  ReviewerRouteError,
  isOpenAiCodexRoute,
  listAdvertisedRoutes,
  resolveExternalReviewerRoute,
  resolveReviewerRoute,
  isDecisionReviewRoute,
  reviewerRouteAvailability,
} from '../../src/auto-review/host/routes.ts'
import {
  EXTERNAL_REVIEW_BLOCK_TEXT,
  assessExternalReview,
  externalReviewUserText,
  sameExternalReviewBinding,
  type ExternalReviewBinding,
} from '../../src/auto-review/host/external-review.ts'
import type { AutoReviewRouteOption } from '../../src/auto-review/contracts/settings.ts'
import { reviewRecordSchema } from '../../src/auto-review/host/ledger.ts'

const cleanups: (() => unknown)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function option(provider: string, model: string, efforts: string[] = []): AutoReviewRouteOption {
  return {
    provider,
    providerName: provider,
    model,
    modelName: model,
    efforts,
    defaultEffort: efforts[0] ?? null,
  }
}

const GATEWAY = 'opl-gateway'
const AUTO_REVIEW = OPENAI_AUTO_REVIEW_ROUTE.model
const CHAT = 'codex::gpt-6-sol'

/** The Gateway catalog as the verified discovery publishes it. */
const ADVERTISED: AutoReviewRouteOption[] = [
  option(GATEWAY, CHAT, ['low', 'high']),
  option(GATEWAY, AUTO_REVIEW, ['medium']),
  option('deepseek', 'deepseek-flash', ['high']),
]
const DECISION = option('bamboo-startlux', 'startlux-decision-27b-autothink')
DECISION.kind = 'decision'

/** The exact diagnostic one refused resolution carries, or a failure. */
function diagnosticOf(work: () => unknown): string {
  try {
    work()
  } catch (error) {
    if (error instanceof ReviewerRouteError) return error.diagnostic
    throw error
  }
  throw new Error('expected the route policy to refuse')
}

describe('reviewer route policy', () => {
  it('marks StartLux as a decision route and keeps it separate from ordinary reviewers', () => {
    expect(isDecisionReviewRoute('bamboo-startlux', 'startlux-decision-27b-autothink')).toBe(true)
    expect(isDecisionReviewRoute('bamboo-startlux', 'other-model')).toBe(false)
    expect(
      resolveReviewerRoute({
        selection: {
          mode: 'decision',
          route: { provider: DECISION.provider, model: DECISION.model },
        },
        sessionRoute: { provider: GATEWAY, model: CHAT, reasoningEffort: null },
        routes: [...ADVERTISED, DECISION],
      }),
    ).toMatchObject({
      provider: DECISION.provider,
      model: DECISION.model,
      source: 'decision-model',
    })
  })
  it('names the verified OpenAI reviewer route and recognises the Codex family', () => {
    expect(OPENAI_AUTO_REVIEW_ROUTE).toEqual({ provider: GATEWAY, model: AUTO_REVIEW })
    expect(isOpenAiCodexRoute({ provider: GATEWAY, model: CHAT })).toBe(true)
    expect(isOpenAiCodexRoute({ provider: GATEWAY, model: AUTO_REVIEW })).toBe(true)
    expect(isOpenAiCodexRoute({ provider: 'deepseek', model: CHAT })).toBe(false)
    expect(isOpenAiCodexRoute({ provider: GATEWAY, model: 'gpt-6-sol' })).toBe(false)
  })

  it('classifies an unadvertised pair into its missing half', () => {
    expect(reviewerRouteAvailability(ADVERTISED, GATEWAY, AUTO_REVIEW)).toBe('advertised')
    expect(reviewerRouteAvailability(ADVERTISED, GATEWAY, 'codex::absent')).toBe(
      'model-not-advertised',
    )
    expect(reviewerRouteAvailability(ADVERTISED, 'minimax-official', 'MiniMax-M3')).toBe(
      'provider-not-registered',
    )
  })

  it('prefers the dedicated OpenAI reviewer for a native Codex route', () => {
    const resolved = resolveReviewerRoute({
      selection: { mode: 'current' },
      sessionRoute: { provider: GATEWAY, model: CHAT, reasoningEffort: 'high' },
      routes: ADVERTISED,
    })
    expect(resolved).toEqual({
      provider: GATEWAY,
      model: AUTO_REVIEW,
      // `high` is a fact about the chat route; this reviewer does not advertise
      // it, so no effort is claimed for it.
      reasoningEffort: null,
      source: 'native-auto-review',
    })
  })

  it('refuses instead of substituting when the dedicated reviewer is not advertised', () => {
    const routes = [option(GATEWAY, CHAT, ['high'])]
    expect(
      diagnosticOf(() =>
        resolveReviewerRoute({
          selection: { mode: 'current' },
          sessionRoute: { provider: GATEWAY, model: CHAT, reasoningEffort: 'high' },
          routes,
        }),
      ),
    ).toBe('preferred-route-unavailable')
  })

  it('refuses when the Gateway provider is not registered at all', () => {
    expect(
      diagnosticOf(() =>
        resolveReviewerRoute({
          selection: { mode: 'current' },
          sessionRoute: { provider: GATEWAY, model: CHAT, reasoningEffort: 'high' },
          routes: [option('deepseek', 'deepseek-flash', ['high'])],
        }),
      ),
    ).toBe('preferred-route-unavailable')
  })

  it('uses the dedicated reviewer for native DeepSeek without inheriting chat effort', () => {
    expect(
      resolveReviewerRoute({
        selection: { mode: 'current' },
        sessionRoute: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high' },
        routes: ADVERTISED,
      }),
    ).toEqual({
      provider: GATEWAY,
      model: AUTO_REVIEW,
      reasoningEffort: null,
      source: 'native-auto-review',
    })
  })

  it('refuses an excluded Harness route and an unadvertised Session route', () => {
    expect(
      diagnosticOf(() =>
        resolveReviewerRoute({
          selection: { mode: 'current' },
          sessionRoute: {
            provider: 'minimax-official',
            model: 'MiniMax-M3',
            reasoningEffort: null,
          },
          routes: [...ADVERTISED, option('minimax-official', 'MiniMax-M3')],
        }),
      ),
    ).toBe('route-excluded')
    expect(
      diagnosticOf(() =>
        resolveReviewerRoute({
          selection: { mode: 'current' },
          sessionRoute: { provider: '', model: '', reasoningEffort: null },
          routes: ADVERTISED,
        }),
      ),
    ).toBe('route-missing')
  })

  it('lets an explicit fixed selection win, and refuses an unadvertised effort', () => {
    expect(
      resolveReviewerRoute({
        selection: { mode: 'fixed', route: { provider: GATEWAY, model: AUTO_REVIEW } },
        sessionRoute: { provider: GATEWAY, model: CHAT, reasoningEffort: 'high' },
        routes: ADVERTISED,
      }),
    ).toEqual({
      provider: GATEWAY,
      model: AUTO_REVIEW,
      reasoningEffort: null,
      source: 'fixed',
    })
    expect(
      diagnosticOf(() =>
        resolveReviewerRoute({
          selection: {
            mode: 'fixed',
            route: { provider: GATEWAY, model: AUTO_REVIEW, reasoningEffort: 'high' },
          },
          sessionRoute: { provider: GATEWAY, model: CHAT, reasoningEffort: null },
          routes: ADVERTISED,
        }),
      ),
    ).toBe('effort-unadvertised')
    expect(
      diagnosticOf(() =>
        resolveReviewerRoute({
          selection: { mode: 'fixed', route: { provider: '', model: AUTO_REVIEW } },
          sessionRoute: { provider: GATEWAY, model: CHAT, reasoningEffort: null },
          routes: ADVERTISED,
        }),
      ),
    ).toBe('route-missing')
  })

  it('serves an external ask from the dedicated route, never from the Harness model', () => {
    expect(
      resolveExternalReviewerRoute({
        selection: { mode: 'current' },
        routes: [...ADVERTISED, option('minimax-official', 'MiniMax-M3')],
      }),
    ).toEqual({
      provider: GATEWAY,
      model: AUTO_REVIEW,
      reasoningEffort: null,
      source: 'native-auto-review',
    })
    expect(
      diagnosticOf(() =>
        resolveExternalReviewerRoute({
          selection: { mode: 'current' },
          routes: [option(GATEWAY, CHAT)],
        }),
      ),
    ).toBe('preferred-route-unavailable')
    expect(
      resolveExternalReviewerRoute({
        selection: {
          mode: 'fixed',
          route: { provider: GATEWAY, model: AUTO_REVIEW, reasoningEffort: 'medium' },
        },
        routes: ADVERTISED,
      }),
    ).toMatchObject({ source: 'fixed', reasoningEffort: 'medium' })
  })

  it('lists only registered, advertised and non-excluded routes from the live catalog', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    ctx.provide('llm', {
      listProviders: () => [
        { id: GATEWAY, name: 'OPL Gateway' },
        { id: 'bamboo-startlux', name: 'BambooNode · StartLux' },
        { id: 'minimax-official', name: 'MiniMax Code' },
      ],
      listModels: async (provider: string) =>
        provider === GATEWAY
          ? [
              { id: CHAT, name: 'GPT-6 Sol' },
              { id: AUTO_REVIEW, name: 'Codex Auto Review' },
            ]
          : provider === 'bamboo-startlux'
            ? [{ id: DECISION.model, name: 'StartLux Decision 27B AutoThink' }]
            : [{ id: 'MiniMax-M3', name: 'M3' }],
      resolveModelInfo: async (provider: string, model: string) => {
        if (provider === 'bamboo-startlux') return {}
        if (provider !== GATEWAY) throw new Error('synthetic: no metadata')
        return model === AUTO_REVIEW ? {} : { reasoning: { efforts: [{ id: 'high' }] } }
      },
    })

    const routes = await listAdvertisedRoutes(ctx)

    expect(routes.map((route) => `${route.provider}/${route.model}`)).toEqual([
      `${GATEWAY}/${CHAT}`,
      `${GATEWAY}/${AUTO_REVIEW}`,
      `bamboo-startlux/${DECISION.model}`,
    ])
    expect(routes.find((route) => route.provider === 'bamboo-startlux')?.kind).toBe('decision')
  })
})

// ── External permission bridge contract ─────────────────────────────────────────────

/** A session-less agent stand-in: the bridge only reads `agent.session`. */
function agentOf(session: unknown): Agent {
  return { session } as unknown as Agent
}

const SESSION = {} as Session

function binding(overrides: Partial<ExternalReviewBinding> = {}): ExternalReviewBinding {
  return {
    harness: 'zcode',
    callId: 'external-call-1',
    acpSessionId: 'acp-1',
    generation: 2,
    turn: 4,
    turnId: 'turn-op-4',
    action: { name: 'bash', parameters: { command: 'rm -rf build' } },
    authorization: {
      sessionId: 'session-1',
      preset: 'auto',
      sandbox: 'full-access',
      combination: 'ofm-zcode-glm',
    },
    ...overrides,
  }
}

function portOf(value: ExternalReviewBinding | null): {
  calls: number
  bind: () => ExternalReviewBinding | null
} {
  const port = {
    calls: 0,
    bind: () => {
      port.calls += 1
      return value
    },
  }
  return port
}

describe('external permission bridge contract', () => {
  it('refuses a Harness it does not own, and one with no binding port', () => {
    expect(
      assessExternalReview(portOf(binding()), agentOf(SESSION), {
        agent: agentOf(SESSION),
        toolName: 'codex',
      }),
    ).toEqual({ claim: false, block: 'harness-not-bridged' })
    expect(
      assessExternalReview(undefined, agentOf(SESSION), {
        agent: agentOf(SESSION),
        toolName: 'zcode',
        callId: 'external-call-1',
      }),
    ).toEqual({ claim: false, block: 'bridge-not-offered' })
    expect(EXTERNAL_REVIEW_BLOCK_TEXT['bridge-not-offered']).toContain('no binding')
  })

  it('refuses a binding that is incomplete, malformed or unavailable', () => {
    const cases: (ExternalReviewBinding | null)[] = [
      null,
      binding({ generation: -1 }),
      binding({ generation: 1.5 }),
      binding({ turn: Number.NaN }),
      binding({ turn: 0 }),
      binding({ turnId: '' }),
      binding({ acpSessionId: '' }),
      binding({ harness: '' }),
      binding({ action: { name: '', parameters: {} } }),
      binding({ action: { name: 'bash', parameters: (() => 1n) as unknown as unknown } }),
      binding({
        authorization: { sessionId: '', preset: 'auto', sandbox: 'full-access', combination: 'c' },
      }),
      binding({
        authorization: { sessionId: 's', preset: '', sandbox: 'full-access', combination: 'c' },
      }),
      binding({
        authorization: { sessionId: 's', preset: 'auto', sandbox: '', combination: 'c' },
      }),
      binding({
        authorization: { sessionId: 's', preset: 'auto', sandbox: 'full-access', combination: '' },
      }),
    ]
    for (const value of cases) {
      expect(
        assessExternalReview(portOf(value), agentOf(SESSION), {
          agent: agentOf(SESSION),
          toolName: 'zcode',
          callId: 'external-call-1',
        }),
      ).toEqual({ claim: false, block: 'binding-refused' })
    }
    // A throwing port is a refusal, never an allow.
    const throwing = {
      bind: () => {
        throw new Error('synthetic: connection gone')
      },
    }
    expect(
      assessExternalReview(throwing, agentOf(SESSION), {
        agent: agentOf(SESSION),
        toolName: 'zcode',
        callId: 'external-call-1',
      }),
    ).toEqual({ claim: false, block: 'binding-refused' })
  })

  it('claims only a complete binding and compares identity field by field', () => {
    const complete = binding()
    expect(
      assessExternalReview(portOf(complete), agentOf(SESSION), {
        agent: agentOf(SESSION),
        toolName: 'zcode',
        callId: 'external-call-1',
      }),
    ).toEqual({ claim: true, binding: complete })
    expect(sameExternalReviewBinding(complete, binding())).toBe(true)
    for (const changed of [
      binding({ generation: 3 }),
      binding({ turn: 5 }),
      binding({ turnId: 'turn-op-5' }),
      binding({ acpSessionId: 'acp-2' }),
      binding({ harness: 'other' }),
      binding({ action: { name: 'bash', parameters: { command: 'rm -rf /' } } }),
      binding({
        authorization: {
          sessionId: 'session-2',
          preset: 'auto',
          sandbox: 'full-access',
          combination: 'c',
        },
      }),
      binding({
        authorization: {
          sessionId: 's',
          preset: 'danger-full-access',
          sandbox: 'full-access',
          combination: 'c',
        },
      }),
      binding({
        authorization: { sessionId: 's', preset: 'auto', sandbox: 'workspace', combination: 'c' },
      }),
      binding({
        authorization: {
          sessionId: 's',
          preset: 'auto',
          sandbox: 'full-access',
          combination: 'other',
        },
      }),
    ])
      expect(sameExternalReviewBinding(complete, changed)).toBe(false)
  })

  it('renders the exact action, connection generation, turn and authorization as facts', () => {
    const text = externalReviewUserText(binding(), {
      agent: agentOf(SESSION),
      toolName: 'zcode',
      callId: 'external-call-1',
      reason: 'ZCode · bash',
    })
    expect(text).toContain('EXTERNAL_PERMISSION_REQUEST')
    expect(text).toContain('"generation": 2')
    expect(text).toContain('"turn": 4')
    expect(text).toContain('turn-op-4')
    expect(text).toContain('"combination": "ofm-zcode-glm"')
    expect(text).toContain('rm -rf build')
    expect(text).toContain('harnessReportedReason')
  })
})

describe('review ledger schema compatibility', () => {
  /** A record exactly as the build before the route policy wrote it. */
  const legacyPending = {
    turn: 1,
    step: 2,
    callId: 'call-1',
    rootCallId: 'call-1',
    mode: 'native',
    name: 'bash',
  }
  const legacyBegin = {
    kind: 'begin',
    seq: 1,
    record: 'r1',
    at: '2026-01-01T00:00:00.000Z',
    policyVersion: 'opl-auto-review-policy-1',
    sessionId: 'session-1',
    selectionRevision: '3',
    reviewer: {
      mode: 'fixed',
      provider: 'deepseek',
      model: 'deepseek-flash',
      reasoningEffort: null,
      timeoutMs: 1000,
      maxOutputTokens: 64,
    },
    pending: legacyPending,
    authorization: {
      preset: 'auto',
      sandbox: 'danger-full-access',
      approval: 'ask',
      surfaceLength: 3,
      sessionRoute: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: null },
    },
    request: { system: 'policy', messages: 'facts' },
  }

  it('still accepts every record an earlier build stored', () => {
    expect(reviewRecordSchema.safeParse(legacyBegin).success).toBe(true)
    expect(
      reviewRecordSchema.safeParse({
        kind: 'result',
        seq: 2,
        record: 'r1',
        at: '2026-01-01T00:00:01.000Z',
        policyVersion: 'opl-auto-review-policy-1',
        sessionId: 'session-1',
        pending: legacyPending,
        reviewer: 'allow',
        status: 'allow',
      }).success,
    ).toBe(true)
  })

  it('accepts the policy source and an external ask, and still rejects a malformed one', () => {
    const external = {
      ...legacyBegin,
      reviewer: { ...legacyBegin.reviewer, source: 'native-auto-review' },
      pending: {
        turn: 1,
        callId: 'zcode:acp-1:2',
        rootCallId: 'zcode:acp-1:2',
        mode: 'external-approval',
        name: 'bash',
      },
    }
    expect(reviewRecordSchema.safeParse(external).success).toBe(true)
    expect(
      reviewRecordSchema.safeParse({ ...external, pending: { ...external.pending, mode: 'bogus' } })
        .success,
    ).toBe(false)
    expect(
      reviewRecordSchema.safeParse({ ...external, reviewer: { ...external.reviewer, source: 'x' } })
        .success,
    ).toBe(false)
  })
})
