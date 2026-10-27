import { describe, expect, it, vi } from 'vitest'
import type {
  AcpRequestSurface,
  AcpSessionSnapshot,
  AdapterLaunch,
} from '../../src/execution/host/adapters/types.ts'
import type {
  ExternalEditContext,
  ExternalEditHistory,
} from '../../src/execution/host/message-edit-driver.ts'
import {
  codexMessageEditDriver,
  OPL_EDIT_META,
  OPL_EDIT_READ,
  OPL_EDIT_REWIND,
} from '../../src/execution/host/message-edit-codex.ts'
import { claudeMessageEditDriver } from '../../src/execution/host/message-edit-claude.ts'
import { grokMessageEditDriver } from '../../src/execution/host/message-edit-grok.ts'

const meta = {
  [OPL_EDIT_META]: { version: 1, methods: [OPL_EDIT_READ, OPL_EDIT_REWIND] },
}

function context(
  request: (method: string, params: object) => Promise<unknown>,
  options: { turns?: { prompt: string }[]; aborted?: boolean; meta?: unknown } = {},
) {
  const calls: { method: string; params: any }[] = []
  const transport: AcpRequestSurface = {
    request: vi.fn(async (method, params) => {
      calls.push({ method, params })
      return request(method, params)
    }),
  }
  const disconnect = vi.fn(async () => {})
  const reconnect = vi.fn(async () => {})
  const controller = new AbortController()
  if (options.aborted) controller.abort()
  const ctx: ExternalEditContext = {
    record: {
      acpSessionId: 'vendor-1',
      nativeSessionId: 'dsh-1',
      turns: options.turns ?? [],
    } as any,
    launch: {} as AdapterLaunch,
    signal: controller.signal,
    transport: () => transport,
    snapshot: () =>
      ({
        agent: { agentCapabilities: { _meta: options.meta ?? meta } },
        session: {},
        configOptions: [],
      }) as AcpSessionSnapshot,
    disconnect,
    reconnect,
  }
  return { ctx, calls, disconnect, reconnect }
}

const history = (overrides: Partial<ExternalEditHistory> = {}): ExternalEditHistory => ({
  sessionId: 'vendor-1',
  token: 'token-1',
  boundaries: [
    { id: 't1', text: 'same text' },
    { id: 't2', text: 'same text' },
  ],
  ...overrides,
})

describe('Codex external edit driver', () => {
  it('reads exact active boundaries and the opaque history token', async () => {
    const { ctx, calls } = context(async () => history())
    const value = await codexMessageEditDriver.read(ctx)
    expect(value.boundaries.map((item) => item.id)).toEqual(['t1', 't2'])
    expect(calls).toEqual([{ method: OPL_EDIT_READ, params: { sessionId: 'vendor-1' } }])
    expect(calls.some((call) => call.method === 'session/prompt')).toBe(false)
  })

  it('rewinds the exact duplicate-text target and returns retained mapping', async () => {
    const { ctx, calls, disconnect, reconnect } = context(async () => ({
      sessionId: 'vendor-1',
      retained: [{ previousId: 't1', nextId: 't1' }],
    }))
    const result = await codexMessageEditDriver.rewind(ctx, {
      operationId: 'op-1',
      targetId: 't2',
      expected: history(),
    })
    expect(result.retained).toEqual([{ previousId: 't1', nextId: 't1' }])
    expect(calls[0]).toMatchObject({
      method: OPL_EDIT_REWIND,
      params: { targetId: 't2', expectedToken: 'token-1' },
    })
    expect(disconnect).not.toHaveBeenCalled()
    expect(reconnect).not.toHaveBeenCalled()
    expect(calls.some((call) => call.method === 'session/prompt')).toBe(false)
  })

  it('keeps tool-output history out of user boundaries and revalidates the opaque token', async () => {
    const { ctx, calls } = context(async () => ({
      sessionId: 'vendor-1',
      retained: [{ previousId: 't1', nextId: 't1' }],
    }))
    await codexMessageEditDriver.rewind(ctx, {
      operationId: 'op-tool',
      targetId: 't2',
      expected: history({
        token: 'token-with-tool-output',
        boundaries: [
          { id: 't1', text: 'first' },
          { id: 't2', text: 'second' },
        ],
      }),
    })
    expect(calls[0]?.params.expectedToken).toBe('token-with-tool-output')
    expect(calls.some((call) => call.method === 'session/prompt')).toBe(false)
  })

  it('returns a changed vendor identity without rebinding or sending a prompt', async () => {
    const { ctx, disconnect, reconnect, calls } = context(async () => ({
      sessionId: 'vendor-2',
      retained: [],
    }))
    await codexMessageEditDriver.rewind(ctx, {
      operationId: 'op-1',
      targetId: 't1',
      expected: history(),
    })
    expect(disconnect).not.toHaveBeenCalled()
    expect(reconnect).not.toHaveBeenCalled()
    expect(calls.some((call) => call.method === 'session/prompt')).toBe(false)
  })

  it('rejects a changed boundary before mutation and does not retry', async () => {
    const { ctx, calls } = context(async () => {
      throw new Error('history changed')
    })
    await expect(
      codexMessageEditDriver.rewind(ctx, {
        operationId: 'op-1',
        targetId: 't2',
        expected: history(),
      }),
    ).rejects.toMatchObject({ reason: 'rewind-failed' })
    expect(calls).toHaveLength(1)
  })

  it('rejects an aborted edit before touching the transport', async () => {
    const { ctx, calls } = context(async () => history(), { aborted: true })
    await expect(codexMessageEditDriver.read(ctx)).rejects.toMatchObject({ reason: 'aborted' })
    expect(calls).toHaveLength(0)
  })

  it('refuses a bridge that did not announce the exact capability', async () => {
    const { ctx } = context(async () => history(), { meta: {} })
    await expect(codexMessageEditDriver.read(ctx)).rejects.toMatchObject({
      reason: 'capability-missing',
    })
  })

  it('keeps the record unchanged and surfaces a fixed error when transport fails', async () => {
    const { ctx } = context(async () => {
      throw new Error('raw provider text must not leak')
    })
    await expect(codexMessageEditDriver.read(ctx)).rejects.toMatchObject({
      reason: 'history-unreadable',
    })
    expect(ctx.record.nativeSessionId).toBe('dsh-1')
    expect(ctx.record.acpSessionId).toBe('vendor-1')
  })
})

describe('Claude external edit driver', () => {
  it('returns a fresh ephemeral identity for the first boundary without reconnecting', async () => {
    const { ctx, disconnect, reconnect } = context(async () => ({
      sessionId: 'fresh-uuid',
      retained: [],
      ephemeral: true,
    }))
    const result = await claudeMessageEditDriver.rewind(ctx, {
      operationId: 'op-1',
      targetId: 'u1',
      expected: history({ boundaries: [{ id: 'u1', text: 'first' }] }),
    })
    expect(result).toMatchObject({ sessionId: 'fresh-uuid', retained: [], ephemeral: true })
    expect(disconnect).not.toHaveBeenCalled()
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('returns a forked Claude identity for the owner to persist before rebinding', async () => {
    const { ctx, disconnect, reconnect } = context(async () => ({
      sessionId: 'fork-1',
      retained: [{ previousId: 'u1', nextId: 'u1-new' }],
    }))
    const result = await claudeMessageEditDriver.rewind(ctx, {
      operationId: 'op-1',
      targetId: 'u2',
      expected: history({
        boundaries: [
          { id: 'u1', text: 'first' },
          { id: 'u2', text: 'second' },
        ],
      }),
    })
    expect(result.retained).toEqual([{ previousId: 'u1', nextId: 'u1-new' }])
    expect(disconnect).not.toHaveBeenCalled()
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('does not treat an unknown target error as a successful empty edit', async () => {
    const { ctx } = context(async () => {
      throw new Error('unknown')
    })
    await expect(
      claudeMessageEditDriver.rewind(ctx, {
        operationId: 'op-1',
        targetId: 'missing',
        expected: history(),
      }),
    ).rejects.toMatchObject({ reason: 'rewind-failed' })
  })
})

describe('Grok external edit driver', () => {
  const points = (items: { index: number; preview?: string }[]) => ({
    rewind_points: items.map((item) => ({
      prompt_index: item.index,
      ...(item.preview === undefined ? {} : { prompt_preview: item.preview }),
      has_file_changes: false,
    })),
  })

  it('reads exact DSH turn text by input index and never calls prompt_history', async () => {
    const { ctx, calls } = context(
      async () =>
        points([
          { index: 0, preview: 'first' },
          { index: 1, preview: 'second' },
        ]),
      {
        turns: [
          { prompt: 'first', native: { userMessageId: '0' } },
          { prompt: 'second', native: { userMessageId: '1' } },
        ],
      },
    )
    const value = await grokMessageEditDriver.read(ctx)
    expect(value.boundaries).toEqual([
      { id: '0', text: 'first' },
      { id: '1', text: 'second' },
    ])
    expect(calls.map((call) => call.method)).toEqual(['_x.ai/rewind/points'])
  })

  it('rewinds conversation-only at the exact duplicate-text index and verifies the prefix', async () => {
    let pointReads = 0
    const { ctx, calls } = context(
      async (method) => {
        if (method === '_x.ai/rewind/points') {
          pointReads += 1
          return pointReads <= 2
            ? points([
                { index: 0, preview: 'same' },
                { index: 1, preview: 'same' },
              ])
            : points([{ index: 0, preview: 'same' }])
        }
        return {
          success: true,
          target_prompt_index: 1,
          mode: 'conversation_only',
          prompt_text: 'same',
        }
      },
      {
        turns: [
          { prompt: 'same', native: { userMessageId: '0' } },
          { prompt: 'same', native: { userMessageId: '1' } },
        ],
      },
    )
    const read = await grokMessageEditDriver.read(ctx)
    const result = await grokMessageEditDriver.rewind(ctx, {
      operationId: 'op-1',
      targetId: '1',
      expected: read,
    })
    expect(result).toMatchObject({
      sessionId: 'vendor-1',
      retained: [{ previousId: '0', nextId: '0' }],
    })
    const execute = calls.find((call) => call.method === '_x.ai/rewind/execute')
    expect(execute?.params).toMatchObject({
      targetPromptIndex: 1,
      force: true,
      mode: 'conversation_only',
    })
    expect(calls.some((call) => call.method.includes('prompt_history'))).toBe(false)
    expect(calls.some((call) => call.method === 'session/prompt')).toBe(false)
  })

  it('rejects a changed Grok history before execute', async () => {
    let reads = 0
    const { ctx, calls } = context(
      async () => {
        reads += 1
        return reads === 1
          ? points([
              { index: 0, preview: 'one' },
              { index: 1, preview: 'two' },
            ])
          : points([{ index: 0, preview: 'one' }])
      },
      {
        turns: [
          { prompt: 'one', native: { userMessageId: '0' } },
          { prompt: 'two', native: { userMessageId: '1' } },
        ],
      },
    )
    const read = await grokMessageEditDriver.read(ctx)
    await expect(
      grokMessageEditDriver.rewind(ctx, {
        operationId: 'op-1',
        targetId: '1',
        expected: read,
      }),
    ).rejects.toMatchObject({ reason: 'history-changed' })
    expect(calls.some((call) => call.method === '_x.ai/rewind/execute')).toBe(false)
  })

  it('refuses a vendor/DSH index mismatch instead of guessing', async () => {
    const { ctx } = context(async () => points([{ index: 0, preview: 'one' }]), {
      turns: [{ prompt: 'one' }, { prompt: 'two' }],
    })
    await expect(grokMessageEditDriver.read(ctx)).rejects.toMatchObject({
      reason: 'mapping-mismatch',
    })
  })

  it('throws a fixed uncertainty error when execute fails and never prompts', async () => {
    const { ctx, calls } = context(
      async (method) => {
        if (method === '_x.ai/rewind/points') return points([{ index: 0, preview: 'one' }])
        throw new Error('raw provider failure')
      },
      { turns: [{ prompt: 'one', native: { userMessageId: '0' } }] },
    )
    const read = await grokMessageEditDriver.read(ctx)
    await expect(
      grokMessageEditDriver.rewind(ctx, {
        operationId: 'op-1',
        targetId: '0',
        expected: read,
      }),
    ).rejects.toMatchObject({ reason: 'rewind-failed' })
    expect(calls.some((call) => call.method === 'session/prompt')).toBe(false)
  })
})
