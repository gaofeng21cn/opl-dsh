import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  JevDecisionAdapter,
  JEV_DECISION_MODEL,
  JEV_TYPESAFE_MODEL,
  JEV_TYPESAFE_ENDPOINT,
} from '../../src/execution/host/adapters/jev.ts'
import { readDecision } from '../../src/auto-review/host/policy.ts'
import {
  listAdvertisedRoutes,
  resolveExternalReviewerRoute,
} from '../../src/auto-review/host/routes.ts'
import { ExecutionModelResolver } from '../../src/execution/host/execution-models.ts'
import { defaultExecutionCatalog } from '../../src/execution/host/catalog.ts'

const options: GenerateOptions = {
  ...JEV_DECISION_MODEL,
  system: 'REVIEW_POLICY synthetic policy',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'PENDING_ACTION synthetic local read' }] },
  ],
}
const choices = ['low_allow', 'medium_allow', 'medium_deny', 'high_deny', 'uncertain']
const answer = (choice = 'low_allow') => ({
  model: JEV_DECISION_MODEL.model,
  answers: {
    'review-decision': {
      type: 'choice',
      choice,
      confidence: 1,
      probabilities: Object.fromEntries(choices.map((key) => [key, key === choice ? 1 : 0])),
    },
  },
})
const run = (adapter = new JevDecisionAdapter(), request = options) =>
  readDecision(adapter.stream(request)[Symbol.asyncIterator]())
afterEach(() => vi.restoreAllMocks())

describe('Jev decision adapter', () => {
  it.each([
    ['low_allow', 'low', 'allow'],
    ['medium_allow', 'medium', 'allow'],
    ['medium_deny', 'medium', 'deny'],
    ['high_deny', 'high', 'deny'],
    ['uncertain', 'high', 'deny'],
  ])('maps %s through the native review parser', async (choice, risk, decision) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(answer(choice)))
    expect(await run()).toEqual({ risk, decision })
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({
      model: JEV_DECISION_MODEL.model,
      state: expect.stringContaining('PENDING_ACTION'),
      questions: { 'review-decision': { type: 'choice' } },
    })
    expect(fetch.mock.calls[0]?.[0]).toBe('https://opencode.ai/inference/systemone/v1/systemone')
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer public' })
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('messages')
  })

  it('denies uncertain probabilities even if the chosen label says allow', async () => {
    const body = answer()
    body.answers['review-decision'].confidence = 0.4
    body.answers['review-decision'].probabilities = {
      low_allow: 0.6,
      medium_allow: 0.1,
      medium_deny: 0.1,
      high_deny: 0.1,
      uncertain: 0.1,
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body))
    expect(await run()).toMatchObject({ risk: 'high', decision: 'deny' })
  })

  it.each([
    null,
    {},
    { ...answer(), model: 'another-model' },
    { answers: { 'review-decision': { choice: 'low_allow' } }, model: JEV_DECISION_MODEL.model },
    {
      ...answer(),
      answers: {
        'review-decision': { ...answer().answers['review-decision'], choice: '__proto__' },
      },
    },
    {
      ...answer(),
      answers: { 'review-decision': { ...answer().answers['review-decision'], confidence: 2 } },
    },
    {
      ...answer(),
      answers: {
        'review-decision': {
          ...answer().answers['review-decision'],
          probabilities: { low_allow: 1 },
        },
      },
    },
    {
      ...answer(),
      answers: {
        'review-decision': {
          ...answer().answers['review-decision'],
          probabilities: {
            low_allow: 0,
            medium_allow: 0,
            medium_deny: 0,
            high_deny: 1,
            uncertain: 0,
          },
        },
      },
    },
  ])('refuses malformed or contradictory response %#', async (body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body))
    await expect(run()).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
  })

  it.each([403, 429, 500])('does not leak upstream text or retry HTTP %s', async (status) => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('secret-provider-response', { status }))
    await expect(run()).rejects.toThrow('Jev 审查接口请求失败')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    { sessionId: 'not-a-review' },
    { reasoningEffort: 'high' },
    { tools: [{ name: 'Bash', description: '', parameters: {} }] },
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: 'https://example.invalid/image.png' } },
          ],
        },
      ],
    },
  ])('refuses unsupported review input before sending %#', async (patch) => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(
      run(new JevDecisionAdapter(), { ...options, ...patch } as GenerateOptions),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_REQUEST' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a late successful response after cancellation', async () => {
    const controller = new AbortController()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort()
      return Response.json(answer())
    })
    const adapter = new JevDecisionAdapter()
    const prepared = await adapter.prepareCall(
      JEV_DECISION_MODEL.provider,
      JEV_DECISION_MODEL.model,
      controller.signal,
    )
    await expect(readDecision(prepared.stream(options)[Symbol.asyncIterator]())).rejects.toThrow()
  })

  it('lists only the specialized decision route and excludes both Jev routes from chat', async () => {
    const adapter = new JevDecisionAdapter()
    const ctx = {
      get: () => undefined,
      llm: {
        listProviders: () => [
          { id: JEV_DECISION_MODEL.provider, name: 'OpenCode · Jev' },
          { id: 'our-free-model', name: 'OFM' },
        ],
        listConfigurableProviders: () => [],
        listModels: (provider: string) => adapter.listModels(provider),
        resolveModelInfo: (provider: string, model: string) =>
          adapter.resolveModel(provider, model),
      },
    }
    const routes = await listAdvertisedRoutes(ctx as never)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ ...JEV_DECISION_MODEL, kind: 'decision', efforts: [] })
    expect(
      resolveExternalReviewerRoute({
        selection: { mode: 'decision', route: JEV_DECISION_MODEL },
        routes,
      }),
    ).toMatchObject({ ...JEV_DECISION_MODEL, source: 'decision-model' })
    expect(() =>
      resolveExternalReviewerRoute({
        selection: { mode: 'fixed', route: JEV_DECISION_MODEL },
        routes,
      }),
    ).toThrow()
    const catalog = await new ExecutionModelResolver(
      ctx as never,
      { get: async () => defaultExecutionCatalog() } as never,
    ).resolve()
    expect(catalog.models.some((model) => model.ref.model === JEV_DECISION_MODEL.model)).toBe(false)
    expect(
      catalog.combinations.some((item) => item.modelRef.model === JEV_DECISION_MODEL.model),
    ).toBe(false)
  })
})

describe('personal TypeSafe Jev route', () => {
  it('sends the personal key only to TypeSafe and validates its pinned response model', async () => {
    const body = { ...answer(), model: JEV_TYPESAFE_MODEL.model }
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body))
    const adapter = new JevDecisionAdapter(
      JEV_TYPESAFE_ENDPOINT,
      async () => 'synthetic-personal-key',
    )
    expect(await run(adapter, { ...options, ...JEV_TYPESAFE_MODEL })).toEqual({
      risk: 'low',
      decision: 'allow',
    })
    expect(fetch.mock.calls[0]?.[0]).toBe(JEV_TYPESAFE_ENDPOINT)
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer synthetic-personal-key',
    })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).model).toBe('jev-1.13.0')
    expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain('synthetic-personal-key')
    fetch.mockResolvedValue(Response.json(answer()))
    await expect(run(adapter, { ...options, ...JEV_TYPESAFE_MODEL })).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
    })
  })

  it('does not fall back to the public route after key removal', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const adapter = new JevDecisionAdapter(JEV_TYPESAFE_ENDPOINT, async () => undefined)
    const prepared = await adapter.prepareCall(
      JEV_TYPESAFE_MODEL.provider,
      JEV_TYPESAFE_MODEL.model,
    )
    await expect(
      readDecision(prepared.stream({ ...options, ...JEV_TYPESAFE_MODEL })[Symbol.asyncIterator]()),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not send after cancellation while reading the key', async () => {
    const controller = new AbortController()
    const fetch = vi.spyOn(globalThis, 'fetch')
    const adapter = new JevDecisionAdapter(JEV_TYPESAFE_ENDPOINT, async () => {
      controller.abort()
      return 'synthetic-key'
    })
    await expect(
      run(adapter, { ...options, ...JEV_TYPESAFE_MODEL, signal: controller.signal }),
    ).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})
