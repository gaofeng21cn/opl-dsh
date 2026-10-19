import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  BambooStartLuxAdapter,
  BAMBOO_STARTLUX_MODEL,
} from '../../src/execution/host/adapters/bamboo.ts'

afterEach(() => vi.restoreAllMocks())

describe('Bamboo StartLux reviewer adapter', () => {
  it('translates a decision response into the closed native review stream', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: { 'review-decision': { type: 'choice', choice: 'low_allow', confidence: 0.99 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const adapter = new BambooStartLuxAdapter(async () => 'synthetic-bamboo-key')
    const prepared = await adapter.prepareCall(
      BAMBOO_STARTLUX_MODEL.provider,
      BAMBOO_STARTLUX_MODEL.model,
    )
    const chunks = []
    for await (const chunk of prepared.stream({
      provider: BAMBOO_STARTLUX_MODEL.provider,
      model: BAMBOO_STARTLUX_MODEL.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic review facts' }] }],
      maxTokens: 4096,
    }))
      chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '{"risk":"low","decision":"allow"}' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: '{"risk":"low","decision":"allow"}' },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body.model).toBe(BAMBOO_STARTLUX_MODEL.model)
    expect(body.questions['review-decision'].criteria.uncertain).toBeTruthy()
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer synthetic-bamboo-key',
    })
  })

  it('fails closed for missing credentials, unsupported tools and unknown choices', async () => {
    const missing = new BambooStartLuxAdapter(async () => undefined)
    await expect(
      missing.prepareCall(BAMBOO_STARTLUX_MODEL.provider, BAMBOO_STARTLUX_MODEL.model),
    ).rejects.toThrow('保存 Bamboo API Key')
    const adapter = new BambooStartLuxAdapter(async () => 'synthetic-bamboo-key')
    await expect(
      adapter
        .prepareCall(BAMBOO_STARTLUX_MODEL.provider, BAMBOO_STARTLUX_MODEL.model)
        .then((call) =>
          Array.fromAsync(
            call.stream({
              provider: BAMBOO_STARTLUX_MODEL.provider,
              model: BAMBOO_STARTLUX_MODEL.model,
              messages: [],
              tools: [{ name: 'tool', description: 'tool', parameters: {} }],
            }),
          ),
        ),
    ).rejects.toThrow('不接受工具')
  })
})
