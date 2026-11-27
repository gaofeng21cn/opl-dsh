import { describe, expect, it } from 'vitest'
import {
  parseGrokTurnUsage,
  parseKimiContextUsage,
  parseKimiTranscriptUsage,
  parseMiniMaxContextUsage,
  parseMiniMaxTurnUsage,
  parseOpenCodeKiloTurnUsage,
  readKimiTranscriptUsages,
} from '../../src/execution/host/usage-account.ts'

describe('external Harness usage parsers', () => {
  const miniMaxRow = (extra: Record<string, unknown> = {}) => ({
    id: 8306,
    turnId: 'native-turn',
    model: 'minimax/MiniMax-M3.1-Flash',
    inputTokens: 1_150,
    outputTokens: 96,
    cacheReadTokens: 19_873,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...extra,
  })

  it('sums only MiniMax requests from the selected native turn with disjoint cache buckets', () => {
    expect(
      parseMiniMaxTurnUsage(
        [
          miniMaxRow({ turnId: 'previous-turn', inputTokens: 999_999 }),
          miniMaxRow(),
          miniMaxRow({
            id: 8307,
            inputTokens: 144,
            outputTokens: 9,
            cacheReadTokens: 21_023,
          }),
        ],
        'native-turn',
        'MiniMax-M3.1-Flash',
      ),
    ).toEqual({
      inputTokens: 1_294,
      outputTokens: 105,
      cacheReadTokens: 40_896,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 42_295,
    })
  })

  it.each([
    { id: '' },
    { model: 'minimax/MiniMax-M3' },
    { model: 'other/MiniMax-M3.1-Flash' },
    { inputTokens: -1 },
    { outputTokens: 0.5 },
    { cacheReadTokens: undefined },
    { cacheWriteTokens: undefined },
    { reasoningTokens: 97 },
    { inputTokens: Number.MAX_SAFE_INTEGER },
  ])('withholds incomplete or inconsistent MiniMax usage (%j)', (extra) => {
    expect(
      parseMiniMaxTurnUsage([miniMaxRow(extra)], 'native-turn', 'MiniMax-M3.1-Flash'),
    ).toBeUndefined()
  })

  it('rejects duplicate MiniMax request ids and incomplete reasoning breakdowns', () => {
    for (const rows of [
      [miniMaxRow(), miniMaxRow()],
      [miniMaxRow(), miniMaxRow({ id: 8307, reasoningTokens: undefined })],
      [miniMaxRow({ inputTokens: Number.MAX_SAFE_INTEGER - 19_969 }), miniMaxRow({ id: 8308 })],
    ])
      expect(parseMiniMaxTurnUsage(rows, 'native-turn', 'MiniMax-M3.1-Flash')).toBeUndefined()
    expect(parseMiniMaxTurnUsage([], 'native-turn', 'MiniMax-M3.1-Flash')).toBeUndefined()
    expect(
      parseMiniMaxTurnUsage([miniMaxRow()], 'other-turn', 'MiniMax-M3.1-Flash'),
    ).toBeUndefined()
    expect(parseMiniMaxTurnUsage({}, 'native-turn', 'MiniMax-M3.1-Flash')).toBeUndefined()
  })

  it('converts Grok full prompt buckets into disjoint DSH counters', () => {
    expect(
      parseGrokTurnUsage({
        _meta: {
          usage: {
            inputTokens: 100,
            cachedReadTokens: 20,
            cacheCreationTokens: 5,
            outputTokens: 10,
            reasoningTokens: 4,
            totalTokens: 110,
          },
        },
      }),
    ).toEqual({
      usage: {
        inputTokens: 75,
        outputTokens: 10,
        totalTokens: 110,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        reasoningTokens: 4,
      },
    })
  })

  it('does not treat Grok outer live context total as billing usage', () => {
    expect(
      parseGrokTurnUsage({
        _meta: {
          totalTokens: 124,
          modelId: 'grok-4.7',
          modelState: { availableModels: [{ id: 'grok-4.7', _meta: { totalContextTokens: 500 } }] },
          usage: { inputTokens: 100, cachedReadTokens: 20, outputTokens: 4, totalTokens: 104 },
        },
      }),
    ).toEqual({
      usage: { inputTokens: 80, outputTokens: 4, totalTokens: 104, cacheReadTokens: 20 },
      contextUsage: { used: 124, size: 500, estimated: true },
    })
  })

  it('parses OpenCode and Kilo ACP result buckets as one completed prompt', () => {
    expect(
      parseOpenCodeKiloTurnUsage({
        usage: { inputTokens: 9_122, outputTokens: 125, totalTokens: 9_247 },
      }),
    ).toEqual({ usage: { inputTokens: 9_122, outputTokens: 125, totalTokens: 9_247 } })
    expect(
      parseOpenCodeKiloTurnUsage({
        usage: {
          inputTokens: 95,
          outputTokens: 7,
          thoughtTokens: 20,
          cachedReadTokens: 11_776,
          totalTokens: 11_898,
        },
      }),
    ).toEqual({
      usage: {
        inputTokens: 95,
        outputTokens: 27,
        totalTokens: 11_898,
        cacheReadTokens: 11_776,
        reasoningTokens: 20,
      },
    })
  })

  it('parses context occupancy separately, including estimated used-only updates', () => {
    expect(parseMiniMaxContextUsage({ update: { used: 13_765, size: 512_000 } })).toEqual({
      contextUsage: { used: 13_765, size: 512_000 },
    })
    expect(parseMiniMaxContextUsage({ used: 42 })).toEqual({
      contextUsage: { used: 42 },
    })
  })

  it('fails closed for malformed, negative, overflowing, and contradictory buckets', () => {
    expect(parseGrokTurnUsage({ _meta: { usage: { inputTokens: -1, outputTokens: 1 } } })).toEqual(
      {},
    )
    expect(
      parseGrokTurnUsage({
        _meta: { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 5 } },
      }),
    ).toEqual({})
  })

  it('converts Kimi native transcript buckets and step fallback into disjoint counters', () => {
    // The documented aggregate folds cache creation into inputTokens. Without the
    // native steps there is no safe way to split uncached input from cache writes.
    expect(
      parseKimiTranscriptUsage({
        usage: { inputTokens: 75, cachedTokens: 20, outputTokens: 10 },
      }),
    ).toBeUndefined()
    expect(
      parseKimiTranscriptUsage({
        steps: [
          { usage: { inputOther: 75, inputCacheRead: 20, inputCacheCreation: 5, output: 10 } },
        ],
      }),
    ).toEqual({
      inputTokens: 75,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
    })
  })

  it('pages Kimi transcript from newest to oldest and rejects a stuck cursor', async () => {
    const calls: (string | undefined)[] = []
    const turn = (turnId: string, inputOther: number, output: number) => ({
      kind: 'turn',
      turnId,
      steps: [{ usage: { inputOther, output, inputCacheRead: 0, inputCacheCreation: 0 } }],
    })
    const result = await readKimiTranscriptUsages(async (beforeTurn) => {
      calls.push(beforeTurn)
      if (!beforeTurn)
        return {
          code: 0,
          data: {
            has_more: true,
            items: [turn('t3', 30, 3), turn('t2', 20, 2)],
          },
        }
      return {
        code: 0,
        data: {
          has_more: false,
          items: [turn('t1', 10, 1)],
        },
      }
    })
    expect(calls).toEqual([undefined, 't3'])
    expect([...result.keys()]).toEqual(['t3', 't2', 't1'])

    await expect(
      readKimiTranscriptUsages(async () => ({
        code: 0,
        data: { has_more: true, items: [] },
      })),
    ).rejects.toThrow('cursor did not advance')
  })

  it('reads Kimi context status without inventing a token usage record', () => {
    expect(
      parseKimiContextUsage({
        code: 0,
        data: { context_tokens: 19_333, max_context_tokens: 262_144 },
      }),
    ).toEqual({ used: 19_333, size: 262_144 })
    expect(parseKimiContextUsage({ code: 0, data: { context_tokens: -1 } })).toBeUndefined()
  })
})
