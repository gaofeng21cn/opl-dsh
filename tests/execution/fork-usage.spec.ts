import { describe, expect, it } from 'vitest'
import type { VendorMessage } from '../../src/execution/host/message-edit-opencode-common.ts'
import { summarizeOpenCodeKiloUsage } from '../../src/execution/host/usage-opencode-kilo.ts'
import {
  PiTurnUsage,
  piContextUsage,
  piSessionStatsUsage,
} from '../../src/execution/host/adapters/pi/pi-usage.ts'

const sessionId = 'ses_usage'
const model = 'oplopencode/oplsample'

function message(
  id: string,
  role: string,
  parentID: string | null,
  parts: Record<string, any>[],
  extra: Record<string, any> = {},
): VendorMessage {
  return {
    info: { id, role, sessionID: sessionId, parentID, ...extra },
    parts: parts.map((part) => ({ sessionID: sessionId, messageID: id, ...part })),
  }
}

function user(id: string, parentID: string | null = null): VendorMessage {
  return message(id, 'user', parentID, [{ id: `${id}_text`, type: 'text', text: id }])
}

function assistant(
  id: string,
  parentID: string,
  usages: {
    id: string
    input: number
    output: number
    reasoning?: number
    read?: number
    write?: number
  }[],
  extra: Record<string, any> = {},
): VendorMessage {
  return message(
    id,
    'assistant',
    parentID,
    usages.map((usage) => ({
      id: usage.id,
      type: 'step-finish',
      tokens: {
        input: usage.input,
        output: usage.output,
        reasoning: usage.reasoning ?? 0,
        cache: { read: usage.read ?? 0, write: usage.write ?? 0 },
        total:
          usage.input +
          usage.output +
          (usage.reasoning ?? 0) +
          (usage.read ?? 0) +
          (usage.write ?? 0),
      },
    })),
    { providerID: 'oplopencode', modelID: 'oplsample', ...extra },
  )
}

const providers = {
  all: [
    {
      id: 'oplopencode',
      models: {
        oplsample: {
          id: 'oplsample',
          providerID: 'oplopencode',
          limit: { context: 128_000 },
        },
      },
    },
  ],
}

describe('OpenCode/Kilo exact user-boundary usage', () => {
  it('sums every step under one parent-id boundary and keeps cache buckets disjoint', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'u1', [
        { id: 'step-1', input: 10, output: 3, reasoning: 2, read: 7 },
        { id: 'step-2', input: 20, output: 4, reasoning: 1, write: 5 },
      ]),
      assistant('a2', 'a1', [{ id: 'step-3', input: 30, output: 6, read: 9 }], {
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      user('u2', 'a2'),
      assistant('a3', 'u2', [{ id: 'step-4', input: 100, output: 1 }]),
    ]
    const result = summarizeOpenCodeKiloUsage(messages, sessionId, model, providers)
    expect(result.get('u1')).toEqual({
      usage: {
        inputTokens: 60,
        outputTokens: 16,
        totalTokens: 97,
        cacheReadTokens: 16,
        cacheWriteTokens: 5,
        reasoningTokens: 3,
      },
      contextUsage: { used: 39, size: 128_000 },
    })
    expect(result.get('u2')).toEqual({
      usage: {
        inputTokens: 100,
        outputTokens: 1,
        totalTokens: 101,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      contextUsage: { used: 100, size: 128_000 },
    })
    expect(summarizeOpenCodeKiloUsage(messages, sessionId, model, providers)).toEqual(result)
  })

  it('does not guess when a message graph, model, or usage bucket is malformed', () => {
    const duplicatePart = [
      user('u1'),
      assistant('a1', 'u1', [
        { id: 'same', input: 2, output: 1 },
        { id: 'same', input: 3, output: 1 },
      ]),
    ]
    expect(summarizeOpenCodeKiloUsage(duplicatePart, sessionId, model, providers)).toEqual(
      new Map(),
    )

    const wrongModel = [
      user('u1'),
      assistant('a1', 'u1', [{ id: 'step-1', input: 2, output: 1 }], {
        modelID: 'another-model',
      }),
    ]
    expect(summarizeOpenCodeKiloUsage(wrongModel, sessionId, model, providers)).toEqual(new Map())

    const wrongSession = [
      user('u1'),
      assistant('a1', 'u1', [{ id: 'step-1', input: 2, output: 1 }]),
    ].map((item) => ({ ...item, info: { ...item.info, sessionID: 'other' } }))
    expect(summarizeOpenCodeKiloUsage(wrongSession, sessionId, model, providers)).toEqual(new Map())
  })

  it('accepts Kilo thoughtTokens while preserving the OpenCode reasoning spelling', () => {
    const messages = [
      user('kilo-user'),
      message(
        'kilo-assistant',
        'assistant',
        'kilo-user',
        [
          {
            id: 'kilo-step',
            type: 'step-finish',
            tokens: {
              input: 95,
              output: 7,
              thoughtTokens: 20,
              cache: { read: 11_776, write: 0 },
              total: 11_898,
            },
          },
        ],
        { providerID: 'oplopencode', modelID: 'oplsample' },
      ),
    ]
    const result = summarizeOpenCodeKiloUsage(messages, sessionId, model, providers)
    expect(result.get('kilo-user')).toEqual({
      usage: {
        inputTokens: 95,
        outputTokens: 27,
        totalTokens: 11_898,
        cacheReadTokens: 11_776,
        cacheWriteTokens: 0,
        reasoningTokens: 20,
      },
      contextUsage: { used: 11_871, size: 128_000 },
    })
  })
})

describe('Pi request and context usage', () => {
  it('deduplicates zero stream snapshots and sums multiple completed requests', () => {
    const usage = new PiTurnUsage('provider', 'model')
    usage.accept({
      type: 'message_start',
      message: { role: 'assistant', provider: 'provider', model: 'model', timestamp: 1 },
    })
    usage.accept({
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'provider',
        model: 'model',
        timestamp: 1,
        responseId: 'zero-failed',
        stopReason: 'error',
        usage: { input: 0, output: 0, totalTokens: 0 },
      },
    })
    usage.accept({
      type: 'message_start',
      message: { role: 'assistant', provider: 'provider', model: 'model', timestamp: 2 },
    })
    const frame = {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'provider',
        model: 'model',
        timestamp: 2,
        responseId: 'response-1',
        stopReason: 'toolUse',
        usage: { input: 5, output: 3, cacheRead: 2, cacheWrite: 1, reasoning: 1, totalTokens: 11 },
      },
    }
    usage.accept(frame)
    usage.accept(frame)
    usage.accept({
      type: 'message_start',
      message: { role: 'assistant', provider: 'provider', model: 'model', timestamp: 3 },
    })
    usage.accept({
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'provider',
        model: 'model',
        timestamp: 3,
        responseId: 'response-2',
        stopReason: 'stop',
        usage: { input: 7, output: 4, cacheRead: 3, cacheWrite: 0, reasoning: 2, totalTokens: 14 },
      },
    })
    expect(usage.snapshot()).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      totalTokens: 25,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      reasoningTokens: 3,
    })
  })

  it('retains capacity after an unknown or post-compaction estimate without inventing occupancy', () => {
    expect(
      piContextUsage(
        { sessionId: 'pi-1', model: { provider: 'p', id: 'm', contextWindow: 128_000 } },
        { sessionId: 'pi-1', contextUsage: { tokens: 30_000, contextWindow: 128_000 } },
        { sessionId: 'pi-1', provider: 'p', model: 'm' },
      ),
    ).toEqual({ used: 30_000, size: 128_000, estimated: true })
    expect(
      piContextUsage(
        { sessionId: 'pi-1', model: { provider: 'p', id: 'm', contextWindow: 128_000 } },
        { sessionId: 'pi-1', contextUsage: { tokens: null, contextWindow: 128_000 } },
        { sessionId: 'pi-1', provider: 'p', model: 'm' },
      ),
    ).toEqual({ size: 128_000 })
    expect(
      piContextUsage(
        { sessionId: 'pi-1', model: { provider: 'p', id: 'm', contextWindow: 128_000 } },
        { sessionId: 'other', contextUsage: { tokens: 20, contextWindow: 128_000 } },
        { sessionId: 'pi-1', provider: 'p', model: 'm' },
      ),
    ).toBeUndefined()
    expect(
      piContextUsage(
        { sessionId: 'pi-1', model: { provider: 'p', id: 'm', contextWindow: 128_000 } },
        { sessionId: 'pi-1', contextUsage: { tokens: 20, contextWindow: 64_000 } },
        { sessionId: 'pi-1', provider: 'p', model: 'm' },
      ),
    ).toBeUndefined()
  })

  it('falls back to completed Pi session entries when stream identity is absent', () => {
    expect(
      piSessionStatsUsage(
        {
          entries: [
            {
              message: {
                role: 'assistant',
                usage: {
                  input: 1_616,
                  output: 76,
                  cacheRead: 6,
                  cacheWrite: 0,
                  totalTokens: 1_698,
                },
              },
            },
          ],
        },
        { provider: 'provider', model: 'model' },
      ),
    ).toEqual({
      inputTokens: 1_616,
      outputTokens: 76,
      totalTokens: 1_698,
      cacheReadTokens: 6,
      cacheWriteTokens: 0,
    })
  })

  it('withholds failed, cancelled, malformed, and wrong-model samples', () => {
    const cancelled = new PiTurnUsage('provider', 'model')
    cancelled.reset()
    expect(cancelled.snapshot()).toBeUndefined()

    const malformed = new PiTurnUsage('provider', 'model')
    malformed.accept({
      type: 'message_start',
      message: { role: 'assistant', provider: 'provider', model: 'model' },
    })
    malformed.accept({
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'provider',
        model: 'model',
        stopReason: 'stop',
        usage: { input: 'unknown', output: 2 },
      },
    })
    expect(malformed.snapshot()).toBeUndefined()

    const wrongModel = new PiTurnUsage('provider', 'model')
    wrongModel.accept({
      type: 'message_start',
      message: { role: 'assistant', provider: 'provider', model: 'model' },
    })
    wrongModel.accept({
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'provider',
        model: 'other',
        stopReason: 'stop',
        usage: { input: 3, output: 2 },
      },
    })
    expect(wrongModel.snapshot()).toBeUndefined()
  })
})
