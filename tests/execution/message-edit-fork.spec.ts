/**
 * Focused driver-contract tests for the Pi/Pool/Kimi message-edit lane.
 *
 * These tests use in-memory transports and records only: no CLI, no model, no HTTP. The
 * official-CLI behaviour is exercised separately in the lane's manual probes; here the
 * assertions cover exact wire parameters, identity mapping, refusals and the guarantee that
 * a failed rewind never sends a replacement prompt.
 */
import { describe, expect, it } from 'vitest'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import type { AdapterLaunch } from '../../src/execution/host/adapters/types.ts'
import type {
  AcpRequestSurface,
  AcpSessionSnapshot,
} from '../../src/execution/host/adapters/types.ts'
import type {
  ExternalEditContext,
  ExternalEditHistory,
} from '../../src/execution/host/message-edit-driver.ts'
import { piMessageEditDriver } from '../../src/execution/host/message-edit-pi.ts'
import { poolMessageEditDriver } from '../../src/execution/host/message-edit-pool.ts'
import { kimiMessageEditDriver } from '../../src/execution/host/message-edit-kimi.ts'
import { ExternalMessageEditError } from '../../src/execution/host/message-edit-opencode-common.ts'

interface Call {
  method: string
  params: Record<string, any>
}

const launch: AdapterLaunch = { home: '', command: '', args: [], env: {} }

function turn(operationId: string, prompt: string, userMessageId?: string, state = 'completed') {
  return {
    operationId,
    fingerprint: operationId,
    prompt,
    text: '',
    state,
    tools: [],
    ...(userMessageId ? { native: { userMessageId } } : {}),
  }
}

function record(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id: 'dsh-1',
    combination: 'c',
    harnessRef: 'pool',
    modelRef: { provider: 'pool', model: 'm' },
    cwd: 'C:/work',
    acpSessionId: 'vendor-1',
    origin: { kind: 'harness' },
    title: 't',
    sandbox: 'workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    turns: [],
    ...overrides,
  } as unknown as HarnessSession
}

function context(options: {
  record: HarnessSession
  handler: (method: string, params: Record<string, any>) => unknown | Promise<unknown>
  agent?: Record<string, any>
  signal?: AbortSignal
}): { ctx: ExternalEditContext; calls: Call[] } {
  const calls: Call[] = []
  const surface: AcpRequestSurface = {
    async request(method, params) {
      calls.push({ method, params: params as Record<string, any> })
      return await options.handler(method, params as Record<string, any>)
    },
  }
  const snapshot: AcpSessionSnapshot = {
    agent: options.agent ?? {
      agentCapabilities: { _meta: { 'poolside/rewind': true } },
    },
    session: {},
    configOptions: undefined,
  }
  const controller = new AbortController()
  return {
    ctx: {
      record: options.record,
      launch,
      signal: options.signal ?? controller.signal,
      transport: () => surface,
      snapshot: () => snapshot,
      disconnect: async () => {},
      reconnect: async () => {},
      replayHistory: async () => {
        const result = (await surface.request('session/load', {
          sessionId: options.record.acpSessionId,
        })) as { boundaries?: { id: string; text: string }[] }
        return {
          sessionId: options.record.acpSessionId,
          token: 'replay',
          boundaries:
            result.boundaries ??
            options.record.turns.map((turn) => ({
              id: turn.native!.userMessageId!,
              text: turn.prompt,
            })),
        }
      },
    },
    calls,
  }
}

function codeOf(error: unknown): string {
  expect(error).toBeInstanceOf(ExternalMessageEditError)
  return (error as ExternalMessageEditError).code
}

async function expectCode(run: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  try {
    await run
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ExternalMessageEditError)
  expect((caught as ExternalMessageEditError).code).toBe(code)
}

describe('Pi message-edit driver', () => {
  it('returns the exact active boundaries, including repeated text with distinct ids', async () => {
    const { ctx } = context({
      record: record({ harnessRef: 'pi', acpSessionId: 'pi-1' }),
      handler: (method) => {
        expect(method).toBe('opl/edit/read')
        return {
          ok: true,
          sessionId: 'pi-1',
          token: 'sha256:one',
          boundaries: [
            { id: 'u1', text: 'same text' },
            { id: 'u2', text: 'same text' },
          ],
        }
      },
    })
    const history = await piMessageEditDriver().read(ctx)
    expect(history.sessionId).toBe('pi-1')
    expect(history.token).toBe('sha256:one')
    expect(history.boundaries.map((item) => item.id)).toEqual(['u1', 'u2'])
    expect(history.boundaries.map((item) => item.text)).toEqual(['same text', 'same text'])
  })

  it('rejects a boundary reply with duplicate ids', async () => {
    const { ctx } = context({
      record: record({ harnessRef: 'pi' }),
      handler: () => ({
        ok: true,
        sessionId: 'pi-1',
        token: 't',
        boundaries: [
          { id: 'u1', text: 'a' },
          { id: 'u1', text: 'b' },
        ],
      }),
    })
    await expectCode(piMessageEditDriver().read(ctx), 'protocol')
  })

  it('sends the exact rewind identity and never a prompt', async () => {
    const { ctx, calls } = context({
      record: record({ harnessRef: 'pi', acpSessionId: 'pi-1' }),
      handler: (method, params) => {
        if (method === 'opl/edit/read')
          return {
            ok: true,
            sessionId: 'pi-1',
            token: 'sha256:one',
            boundaries: [{ id: 'u1', text: 'first' }],
          }
        expect(method).toBe('opl/edit/rewind')
        expect(params).toEqual({
          sessionId: 'pi-1',
          operationId: 'op-1',
          targetId: 'u1',
          expectedToken: 'sha256:one',
        })
        return {
          ok: true,
          sessionId: 'pi-2',
          retained: [{ previousId: 'u1', nextId: 'u1' }],
          ephemeral: true,
        }
      },
    })
    const driver = piMessageEditDriver()
    const expected = await driver.read(ctx)
    const result = await driver.rewind(ctx, {
      operationId: 'op-1',
      targetId: 'u1',
      expected,
    })
    expect(result).toEqual({
      sessionId: 'pi-2',
      retained: [{ previousId: 'u1', nextId: 'u1' }],
      ephemeral: true,
    })
    expect(calls.map((call) => call.method)).toEqual(['opl/edit/read', 'opl/edit/rewind'])
    expect(calls.some((call) => call.method === 'session/prompt')).toBe(false)
  })

  it('refuses a changed history before any mutation', async () => {
    const { ctx, calls } = context({
      record: record({ harnessRef: 'pi', acpSessionId: 'pi-1' }),
      handler: (method) => {
        if (method === 'opl/edit/read')
          return {
            ok: true,
            sessionId: 'pi-1',
            token: 'sha256:new',
            boundaries: [{ id: 'u1' }],
          }
        return { ok: false, code: 'history-changed' }
      },
    })
    const expected: ExternalEditHistory = {
      sessionId: 'pi-1',
      token: 'sha256:old',
      boundaries: [{ id: 'u1' }],
    }
    await expectCode(
      piMessageEditDriver().rewind(ctx, { operationId: 'op', targetId: 'u1', expected }),
      'history-changed',
    )
    expect(calls.some((call) => call.method === 'session/prompt')).toBe(false)
  })

  it('maps a transport failure to an uncertain result, never success', async () => {
    const { ctx } = context({
      record: record({ harnessRef: 'pi', acpSessionId: 'pi-1' }),
      handler: () => {
        throw new Error('process exited')
      },
    })
    await expectCode(piMessageEditDriver().read(ctx), 'uncertain')
  })
})

describe('Pool message-edit driver', () => {
  const poolRecord = () =>
    record({
      harnessRef: 'pool',
      acpSessionId: 'pool-1',
      turns: [
        turn('op-1', 'same text', 'evt-1'),
        turn('op-2', 'same text', 'evt-2'),
      ] as unknown as HarnessSession['turns'],
    })

  it('uses the exact native event ids, not text or ordinal', async () => {
    const { ctx } = context({ record: poolRecord(), handler: () => ({}) })
    const history = await poolMessageEditDriver().read(ctx)
    expect(history.boundaries).toEqual([
      { id: 'evt-1', text: 'same text' },
      { id: 'evt-2', text: 'same text' },
    ])
    expect(history.token).toMatch(/^sha256:/)
  })

  it('refuses a partial history without native ids', async () => {
    const partial = record({
      harnessRef: 'pool',
      turns: [turn('op-1', 'x')] as unknown as HarnessSession['turns'],
    })
    const { ctx } = context({ record: partial, handler: () => ({}) })
    await expectCode(poolMessageEditDriver().read(ctx), 'protocol')
  })

  it('refuses while a turn is busy', async () => {
    const busy = record({
      harnessRef: 'pool',
      turns: [turn('op-1', 'x', 'evt-1', 'running')] as unknown as HarnessSession['turns'],
    })
    const { ctx } = context({ record: busy, handler: () => ({}) })
    await expectCode(poolMessageEditDriver().read(ctx), 'busy')
  })

  it('requires the advertised poolside/rewind capability', async () => {
    const { ctx } = context({
      record: poolRecord(),
      handler: () => ({}),
      agent: { agentCapabilities: { _meta: {} } },
    })
    await expectCode(poolMessageEditDriver().read(ctx), 'unsupported')
  })

  it('sends {sessionId,eventId}, forces a load replay and verifies the retained prefix', async () => {
    const live = poolRecord()
    const { ctx, calls } = context({
      record: live,
      handler: (method, params) => {
        if (method === '_poolside/session_rewind') {
          expect(params).toEqual({ sessionId: 'pool-1', eventId: 'evt-2' })
          return {}
        }
        if (method === 'session/load') {
          return {
            boundaries: [{ id: live.turns[0]!.native!.userMessageId, text: live.turns[0]!.prompt }],
          }
        }
        return {}
      },
    })
    const driver = poolMessageEditDriver()
    const expected = await driver.read(ctx)
    const result = await driver.rewind(ctx, {
      operationId: 'op-2',
      targetId: 'evt-2',
      expected,
    })
    expect(result).toEqual({
      sessionId: 'pool-1',
      retained: [{ previousId: 'evt-1', nextId: 'evt-1' }],
    })
    expect(calls.map((call) => call.method)).toEqual(['_poolside/session_rewind', 'session/load'])
    expect(calls.some((call) => call.method === 'session/prompt')).toBe(false)
  })

  it('refuses an unknown target before calling the vendor', async () => {
    const { ctx, calls } = context({ record: poolRecord(), handler: () => ({}) })
    const expected = await poolMessageEditDriver().read(ctx)
    await expectCode(
      poolMessageEditDriver().rewind(ctx, {
        operationId: 'op',
        targetId: 'evt-unknown',
        expected,
      }),
      'target-unknown',
    )
    expect(calls.some((call) => call.method === '_poolside/session_rewind')).toBe(false)
  })

  it('refuses a changed boundary token before calling the vendor', async () => {
    const live = poolRecord()
    const { ctx, calls } = context({ record: live, handler: () => ({}) })
    const expected = await poolMessageEditDriver().read(ctx)
    ;(live as any).turns = [...(live.turns as any[]), turn('op-3', 'third', 'evt-3')]
    await expectCode(
      poolMessageEditDriver().rewind(ctx, {
        operationId: 'op',
        targetId: 'evt-2',
        expected,
      }),
      'history-changed',
    )
    expect(calls.some((call) => call.method === '_poolside/session_rewind')).toBe(false)
  })

  it('treats a vendor error as uncertain, not as proof of no change', async () => {
    const { ctx } = context({
      record: poolRecord(),
      handler: (method) => {
        if (method === '_poolside/session_rewind') throw new Error('json-rpc error')
        return {}
      },
    })
    const expected = await poolMessageEditDriver().read(ctx)
    await expectCode(
      poolMessageEditDriver().rewind(ctx, {
        operationId: 'op',
        targetId: 'evt-2',
        expected,
      }),
      'uncertain',
    )
  })

  it('reports uncertain when the replay cannot verify the retained prefix', async () => {
    const live = poolRecord()
    const { ctx } = context({
      record: live,
      handler: (method) => {
        if (method === '_poolside/session_rewind') return {}
        if (method === 'session/load') throw new Error('load failed')
        return {}
      },
    })
    const expected = await poolMessageEditDriver().read(ctx)
    await expectCode(
      poolMessageEditDriver().rewind(ctx, {
        operationId: 'op',
        targetId: 'evt-2',
        expected,
      }),
      'uncertain',
    )
  })

  it('honours an already-aborted signal without touching the vendor', async () => {
    const controller = new AbortController()
    controller.abort()
    const { ctx, calls } = context({
      record: poolRecord(),
      handler: () => ({}),
      signal: controller.signal,
    })
    await expectCode(poolMessageEditDriver().read(ctx), 'aborted')
    expect(calls).toEqual([])
  })
})

describe('Kimi message-edit driver', () => {
  it('refuses a non-Kimi harness before starting any control process', async () => {
    const { ctx, calls } = context({
      record: record({ harnessRef: 'pi' }),
      handler: () => ({}),
    })
    await expectCode(kimiMessageEditDriver().read(ctx), 'unsupported')
    expect(calls).toEqual([])
  })

  it('honours an aborted signal before disconnecting', async () => {
    const controller = new AbortController()
    controller.abort()
    const { ctx, calls } = context({
      record: record({ harnessRef: 'kimi-code' }),
      handler: () => ({}),
      signal: controller.signal,
    })
    await expectCode(kimiMessageEditDriver().read(ctx), 'aborted')
    expect(calls).toEqual([])
  })

  it('refuses a busy turn before any control process', async () => {
    const busy = record({
      harnessRef: 'kimi-code',
      turns: [turn('op', 'x', 'turn-1', 'waiting_approval')] as unknown as HarnessSession['turns'],
    })
    const { ctx, calls } = context({ record: busy, handler: () => ({}) })
    await expectCode(kimiMessageEditDriver().read(ctx), 'busy')
    expect(calls).toEqual([])
  })
})
