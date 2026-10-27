import { describe, expect, it } from 'vitest'
import {
  CodexTurnUsageTracker,
  nativeContextUpdate,
  normalizeClaudeTurnUsage,
  normalizeNativeUsage,
  normalizeZcodeTurnUsage,
  zcodeSnapshotContext,
} from '../../src/execution/host/adapters/native-usage.ts'

const codex = (
  totalTokens: number,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reasoningOutputTokens = Math.min(2, outputTokens),
) => ({
  totalTokens,
  inputTokens,
  cachedInputTokens,
  cacheWriteInputTokens: 0,
  outputTokens,
  reasoningOutputTokens,
})

describe('native usage normalization', () => {
  it('normalizes inclusive cache input into disjoint DSH buckets', () => {
    expect(
      normalizeNativeUsage(
        { inputTokens: 100, outputTokens: 10, cachedInputTokens: 25, totalTokens: 110 },
        'input-inclusive-cache',
        { cacheRead: 'cachedInputTokens' },
      ),
    ).toEqual({ inputTokens: 75, outputTokens: 10, totalTokens: 110, cacheReadTokens: 25 })
  })

  it('keeps Claude uncached input separate from cache buckets', () => {
    expect(
      normalizeClaudeTurnUsage({
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
          provider_extension: 99,
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 135,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
    })
  })

  it('does not accept impossible reasoning or cache counts', () => {
    expect(
      normalizeNativeUsage(
        { inputTokens: 10, outputTokens: 2, cachedInputTokens: 11, reasoningTokens: 3 },
        'input-inclusive-cache',
        { cacheRead: 'cachedInputTokens' },
      ),
    ).toBeUndefined()
    expect(
      normalizeNativeUsage(
        { inputTokens: 10, outputTokens: 2, reasoningTokens: 3 },
        'input-disjoint-cache',
      ),
    ).toBeUndefined()
  })

  it('normalizes ZCode aggregate usage and keeps context separate', () => {
    expect(
      normalizeZcodeTurnUsage({
        payload: {
          usage: {
            inputTokens: 100,
            outputTokens: 10,
            totalTokens: 110,
            cacheReadTokens: 25,
            cacheWriteTokens: 0,
            reasoningTokens: 8,
          },
        },
      }),
    ).toEqual({
      inputTokens: 75,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 25,
      cacheWriteTokens: 0,
      reasoningTokens: 8,
    })
    expect(zcodeSnapshotContext({ runtime: { contextUsage: { used: 110, size: 200 } } })).toEqual({
      used: 110,
      size: 200,
    })
    expect(nativeContextUpdate({ used: 110, size: 200, estimated: true })).toEqual({
      sessionUpdate: 'usage_update',
      used: 110,
      size: 200,
      _meta: { 'opl/contextEstimated': true },
    })
  })
})

describe('Codex cumulative usage tracker', () => {
  it('differences multiple requests in one tool turn without summing repeated notifications', () => {
    const tracker = new CodexTurnUsageTracker()
    tracker.reset(true)
    tracker.beginTurn()
    tracker.bindTurn('turn-1')
    const first = tracker.accept({
      turnId: 'turn-1',
      tokenUsage: {
        total: codex(110, 100, 20, 10),
        last: codex(110, 100, 20, 10),
        modelContextWindow: 200,
      },
    })
    expect(first?.usage).toEqual({
      inputTokens: 80,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      reasoningTokens: 2,
    })
    const second = tracker.accept({
      turnId: 'turn-1',
      tokenUsage: {
        total: codex(230, 210, 40, 20, 4),
        last: codex(120, 110, 20, 10),
        modelContextWindow: 200,
      },
    })
    expect(second?.usage).toEqual({
      inputTokens: 170,
      outputTokens: 20,
      totalTokens: 230,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      reasoningTokens: 4,
    })
    expect(second?.context).toEqual({ used: 120, size: 200, estimated: true })
    expect(
      tracker.accept({
        turnId: 'turn-1',
        tokenUsage: {
          total: codex(230, 210, 40, 20, 4),
          last: codex(120, 110, 20, 10),
          modelContextWindow: 200,
        },
      })?.usage,
    ).toEqual(second?.usage)
  })

  it('uses an observed restore baseline and suppresses restarted cumulative totals', () => {
    const tracker = new CodexTurnUsageTracker()
    tracker.reset()
    tracker.accept({
      turnId: 'old-turn',
      tokenUsage: {
        total: codex(500, 480, 100, 20),
        last: codex(20, 18, 0, 2),
        modelContextWindow: 200,
      },
    })
    tracker.beginTurn()
    tracker.bindTurn('new-turn')
    expect(
      tracker.accept({
        turnId: 'new-turn',
        tokenUsage: {
          total: codex(540, 518, 110, 22, 4),
          last: codex(40, 38, 10, 2),
          modelContextWindow: 200,
        },
      })?.usage,
    ).toEqual({
      inputTokens: 28,
      outputTokens: 2,
      totalTokens: 40,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      reasoningTokens: 2,
    })
    expect(
      tracker.accept({
        turnId: 'new-turn',
        tokenUsage: {
          total: codex(50, 40, 5, 10),
          last: codex(50, 40, 5, 10),
          modelContextWindow: 200,
        },
      })?.usage,
    ).toBeUndefined()
  })

  it('does not reuse a pre-edit baseline after reset on a restored thread', () => {
    const tracker = new CodexTurnUsageTracker()
    tracker.accept({
      turnId: 'old-turn',
      tokenUsage: {
        total: codex(500, 480, 100, 20),
        last: codex(20, 18, 0, 2),
        modelContextWindow: 200,
      },
    })
    tracker.reset()
    tracker.beginTurn()
    tracker.bindTurn('edited-turn')
    expect(
      tracker.accept({
        turnId: 'edited-turn',
        tokenUsage: {
          total: codex(540, 518, 110, 22, 4),
          last: codex(40, 38, 10, 2),
          modelContextWindow: 200,
        },
      })?.usage,
    ).toBeUndefined()
  })
})
