import { describe, expect, it } from 'vitest'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import type { ExternalEditContext } from '../../src/execution/host/message-edit-driver.ts'
import type { AdapterLaunch } from '../../src/execution/host/adapters/types.ts'
import {
  ExternalMessageEditError,
  type VendorControl,
  type VendorMessage,
} from '../../src/execution/host/message-edit-opencode-common.ts'
import { createOpenCodeMessageEditDriver } from '../../src/execution/host/message-edit-opencode.ts'
import { createKiloMessageEditDriver } from '../../src/execution/host/message-edit-kilo.ts'

type Kind = 'opencode' | 'kilo'

interface FakeState {
  readonly sessions: Map<string, VendorMessage[]>
  current: string
  nextFork: number
  readonly calls: string[]
  readError?: ExternalMessageEditError
  forkError?: ExternalMessageEditError
  forkTransform?: (fork: VendorMessage[]) => VendorMessage[]
  forkGate?: Promise<void>
  mutateSourceOnFork?: (source: VendorMessage[]) => void
}

let sequence = 1
const next = (prefix: string) => `${prefix}_${sequence++}`

function part(type: string, fields: Record<string, unknown> = {}): Record<string, any> {
  return { type, id: next('prt'), messageID: '', sessionID: 'ses_current', ...fields }
}

function text(value: string, extra: Record<string, unknown> = {}): Record<string, any> {
  return part('text', { text: value, ...extra })
}

function user(
  id: string,
  parts: Record<string, any>[],
  extra: Record<string, unknown> = {},
): VendorMessage {
  return {
    info: { id, role: 'user', sessionID: 'ses_current', time: { created: sequence++ }, ...extra },
    parts: parts.map((item) => ({ ...item, messageID: id, sessionID: 'ses_current' })),
  }
}

function assistant(
  id: string,
  parentID: string,
  parts: Record<string, any>[],
  extra: Record<string, unknown> = {},
): VendorMessage {
  const created = sequence++
  return {
    info: {
      id,
      role: 'assistant',
      parentID,
      sessionID: 'ses_current',
      time: { created, completed: created + 1 },
      finish: 'stop',
      ...extra,
    },
    parts: parts.map((item) => ({ ...item, messageID: id, sessionID: 'ses_current' })),
  }
}

function remap(prefix: VendorMessage[], sessionId: string): VendorMessage[] {
  const ids = new Map(
    prefix.map((message, index) => [message.info.id as string, next(`msg_${sessionId}_${index}`)]),
  )
  return prefix.map((message) => {
    const info = { ...message.info, id: ids.get(message.info.id as string), sessionID: sessionId }
    if (typeof info.parentID === 'string') info.parentID = ids.get(info.parentID)
    const parts = message.parts.map((item) => {
      const copy = {
        ...item,
        id: next(`prt_${sessionId}`),
        messageID: info.id,
        sessionID: sessionId,
      }
      if (copy.type === 'compaction' && typeof copy.tail_start_id === 'string')
        copy.tail_start_id = ids.get(copy.tail_start_id)
      return copy
    })
    return { info, parts }
  })
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function fakeDriver(kind: Kind, state: FakeState) {
  const startControl = async (): Promise<VendorControl> => {
    state.calls.push('start')
    return {
      async readMessages(sessionId: string) {
        state.calls.push(`read:${sessionId}`)
        if (state.readError) throw state.readError
        const messages = state.sessions.get(sessionId)
        if (!messages) throw new ExternalMessageEditError('stale')
        return clone(messages)
      },
      async fork(sessionId: string, targetId: string) {
        state.calls.push(`fork:${sessionId}:${targetId}`)
        if (state.forkError) throw state.forkError
        if (state.forkGate) await state.forkGate
        const source = state.sessions.get(sessionId)
        if (!source) throw new ExternalMessageEditError('stale')
        const index = source.findIndex((message) => message.info.id === targetId)
        const prefix = index < 0 ? source : source.slice(0, index)
        const forkId = `ses_fork_${state.nextFork++}`
        const forked = remap(prefix, forkId)
        state.sessions.set(forkId, state.forkTransform ? state.forkTransform(forked) : forked)
        state.mutateSourceOnFork?.(source)
        return { sessionId: forkId }
      },
      async close() {
        state.calls.push('close')
      },
    }
  }
  return kind === 'opencode'
    ? createOpenCodeMessageEditDriver(startControl)
    : createKiloMessageEditDriver(startControl)
}

function contextFor(
  kind: Kind,
  state: FakeState,
  signal: AbortSignal = new AbortController().signal,
): ExternalEditContext {
  const record = {
    id: 'record-1',
    combination: 'probe',
    harnessRef: kind,
    modelRef: { provider: 'probe', model: 'probe' },
    cwd: 'C:/probe',
    acpSessionId: state.current,
    origin: { kind: 'desktop', sessionId: 'dsh-sidebar-1' },
    title: 'probe',
    sandbox: 'full-access',
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    turns: [],
  } as unknown as HarnessSession
  const launch: AdapterLaunch = {
    home: 'C:/probe',
    command: process.execPath,
    args: [],
    env: {},
  }
  return {
    record,
    launch,
    signal,
    transport: () => ({ request: async () => ({}) }),
    snapshot: () => ({ agent: {}, session: {}, configOptions: [] }),
    disconnect: async () => {},
    reconnect: async () => {},
  }
}

function fixture(kind: Kind = 'opencode'): {
  state: FakeState
  driver: ReturnType<typeof fakeDriver>
  context: ExternalEditContext
} {
  const state: FakeState = {
    sessions: new Map(),
    current: 'ses_current',
    nextFork: 1,
    calls: [],
  }
  return { state, driver: fakeDriver(kind, state), context: contextFor(kind, state) }
}

function baseHistory(kind: Kind = 'opencode'): {
  state: FakeState
  driver: ReturnType<typeof fakeDriver>
  context: ExternalEditContext
} {
  const f = fixture(kind)
  const messages = [
    user('msg_a', [text('alpha')]),
    assistant('msg_ar', 'msg_a', [text('reply')]),
    user('msg_b', [text('beta')]),
    assistant('msg_br', 'msg_b', [text('reply b')]),
  ]
  f.state.sessions.set(f.state.current, messages)
  return f
}

describe('external message-edit driver', () => {
  it('reads real active user boundaries and a history token without mutating', async () => {
    const f = baseHistory()
    const history = await f.driver.read(f.context)
    expect(history.sessionId).toBe('ses_current')
    expect(history.token).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(history.boundaries).toEqual([
      { id: 'msg_a', text: 'alpha' },
      { id: 'msg_b', text: 'beta' },
    ])
    expect(f.state.calls).toEqual(['start', 'read:ses_current', 'close'])
  })

  it('marks attachment-only edit as unavailable but still reads the boundary', async () => {
    const f = fixture()
    f.state.sessions.set(f.state.current, [
      user('msg_a', [text('alpha'), part('file', { mime: 'text/plain', url: 'file:///a.txt' })]),
    ])
    const history = await f.driver.read(f.context)
    expect(history.boundaries).toEqual([
      { id: 'msg_a', text: 'alpha', unavailableReason: '这条消息带有附件，暂不支持编辑' },
    ])
  })

  it('rejects a running tool as busy', async () => {
    const f = fixture()
    f.state.sessions.set(f.state.current, [
      user('msg_a', [text('alpha')]),
      assistant('msg_ar', 'msg_a', [
        part('tool', { tool: 'bash', callID: 'call_1', state: { status: 'running', input: {} } }),
      ]),
    ])
    await expect(f.driver.read(f.context)).rejects.toMatchObject({ code: 'busy' })
  })

  it('rejects an unknown target without calling fork', async () => {
    const f = baseHistory()
    const history = await f.driver.read(f.context)
    f.state.calls.length = 0
    await expect(
      f.driver.rewind(f.context, {
        operationId: 'op-1',
        targetId: 'msg_missing',
        expected: history,
      }),
    ).rejects.toMatchObject({ code: 'target-unknown' })
    expect(f.state.calls).not.toContainEqual(expect.stringContaining('fork:'))
  })

  it('rejects a changed history before fork', async () => {
    const f = baseHistory()
    const history = await f.driver.read(f.context)
    f.state.sessions.get(f.state.current)!.push(user('msg_late', [text('late')]))
    f.state.calls.length = 0
    await expect(
      f.driver.rewind(f.context, { operationId: 'op-1', targetId: 'msg_b', expected: history }),
    ).rejects.toMatchObject({ code: 'history-changed' })
    expect(f.state.calls).not.toContainEqual(expect.stringContaining('fork:'))
  })

  it('token covers tool output, so a changed output invalidates the expected history', async () => {
    const f = fixture()
    f.state.sessions.set(f.state.current, [
      user('msg_a', [text('alpha')]),
      assistant('msg_ar', 'msg_a', [
        part('tool', {
          tool: 'bash',
          callID: 'call_1',
          state: {
            status: 'completed',
            input: { command: 'echo' },
            output: 'one',
            metadata: { exit: 0 },
          },
        }),
      ]),
      user('msg_b', [text('beta')]),
    ])
    const first = await f.driver.read(f.context)
    const tool = f.state.sessions.get(f.state.current)![1]!.parts[0]!
    tool.state = { ...tool.state, output: 'two' }
    const second = await f.driver.read(f.context)
    expect(second.token).not.toBe(first.token)
    f.state.calls.length = 0
    await expect(
      f.driver.rewind(f.context, { operationId: 'op-1', targetId: 'msg_b', expected: first }),
    ).rejects.toMatchObject({ code: 'history-changed' })
    expect(f.state.calls).not.toContainEqual(expect.stringContaining('fork:'))
  })

  it('rejects when the source changes while the fork is being created', async () => {
    const f = baseHistory()
    const history = await f.driver.read(f.context)
    f.state.mutateSourceOnFork = (source) => source.push(user('msg_late', [text('late')]))
    f.state.calls.length = 0
    await expect(
      f.driver.rewind(f.context, { operationId: 'op-1', targetId: 'msg_b', expected: history }),
    ).rejects.toMatchObject({ code: 'uncertain' })
    expect(f.state.calls.filter((call) => call.startsWith('fork:'))).toHaveLength(1)
  })

  it('rejects an unavailable attachment target without fork', async () => {
    const f = fixture()
    f.state.sessions.set(f.state.current, [
      user('msg_a', [text('alpha'), part('file', { mime: 'text/plain', url: 'file:///a.txt' })]),
      user('msg_b', [text('beta')]),
    ])
    const history = await f.driver.read(f.context)
    f.state.calls.length = 0
    await expect(
      f.driver.rewind(f.context, { operationId: 'op-1', targetId: 'msg_a', expected: history }),
    ).rejects.toMatchObject({ code: 'target-unavailable' })
    expect(f.state.calls).not.toContainEqual(expect.stringContaining('fork:'))
  })

  it('maps repeated texts and consecutive edits one-to-one', async () => {
    const f = fixture()
    f.state.sessions.set(f.state.current, [
      user('msg_a', [text('duplicate')]),
      user('msg_b', [text('duplicate')]),
      user('msg_c', [text('duplicate')]),
      user('msg_d', [text('third')]),
    ])
    const first = await f.driver.read(f.context)
    const firstResult = await f.driver.rewind(f.context, {
      operationId: 'op-1',
      targetId: 'msg_d',
      expected: first,
    })
    expect(firstResult.retained).toHaveLength(3)
    expect(new Set(firstResult.retained.map((item) => item.nextId)).size).toBe(3)
    expect(firstResult.retained.map((item) => item.previousId)).toEqual(['msg_a', 'msg_b', 'msg_c'])

    f.state.current = firstResult.sessionId
    const secondContext = contextFor('opencode', f.state)
    const second = await f.driver.read(secondContext)
    const b1 = firstResult.retained.find((item) => item.previousId === 'msg_b')!.nextId
    const secondResult = await f.driver.rewind(secondContext, {
      operationId: 'op-2',
      targetId: b1,
      expected: second,
    })
    expect(secondResult.retained).toEqual([
      { previousId: firstResult.retained[0]!.nextId, nextId: secondResult.retained[0]!.nextId },
    ])
    expect(secondResult.retained[0]!.nextId).not.toBe(firstResult.retained[0]!.nextId)
  })

  it('creates an empty fork for the first boundary', async () => {
    const f = baseHistory()
    const history = await f.driver.read(f.context)
    const result = await f.driver.rewind(f.context, {
      operationId: 'op-1',
      targetId: 'msg_a',
      expected: history,
    })
    expect(result.retained).toEqual([])
    expect(result.sessionId).toMatch(/^ses_fork_/)
  })

  it.each([
    [
      'tool output',
      (fork: VendorMessage[]) => {
        const tool = fork.flatMap((message) => message.parts).find((item) => item.type === 'tool')!
        tool.state = { ...tool.state, output: 'changed output' }
        return fork
      },
    ],
    [
      'tool error',
      (fork: VendorMessage[]) => {
        const tool = fork.flatMap((message) => message.parts).find((item) => item.type === 'tool')!
        tool.state = { ...tool.state, error: { message: 'changed error' } }
        return fork
      },
    ],
    [
      'tool metadata',
      (fork: VendorMessage[]) => {
        const tool = fork.flatMap((message) => message.parts).find((item) => item.type === 'tool')!
        tool.state = { ...tool.state, metadata: { exit: 9 } }
        return fork
      },
    ],
    [
      'reasoning text',
      (fork: VendorMessage[]) => {
        const reasoning = fork
          .flatMap((message) => message.parts)
          .find((item) => item.type === 'reasoning')!
        reasoning.text = 'changed reasoning'
        return fork
      },
    ],
    [
      'assistant summary field',
      (fork: VendorMessage[]) => {
        const summary = fork.find((message) => message.info.summary === true)!
        summary.info.summary = false
        return fork
      },
    ],
    [
      'subtask parameters',
      (fork: VendorMessage[]) => {
        const subtask = fork
          .flatMap((message) => message.parts)
          .find((item) => item.type === 'subtask')!
        subtask.prompt = 'changed subtask'
        return fork
      },
    ],
    [
      'unknown part field',
      (fork: VendorMessage[]) => {
        const mystery = fork
          .flatMap((message) => message.parts)
          .find((item) => item.type === 'mystery')!
        mystery.payload = 'changed unknown'
        return fork
      },
    ],
    [
      'unknown message field',
      (fork: VendorMessage[]) => {
        fork[0]!.info.extra = 'changed unknown'
        return fork
      },
    ],
  ])('rejects a fork that changes %s', async (_name, mutate) => {
    const f = fixture()
    f.state.sessions.set(f.state.current, [
      user('msg_a', [text('alpha')]),
      assistant(
        'msg_ar',
        'msg_a',
        [
          part('tool', {
            tool: 'bash',
            callID: 'call_1',
            state: {
              status: 'completed',
              input: { command: 'echo' },
              output: 'ok',
              metadata: { exit: 0 },
            },
          }),
          part('reasoning', { text: 'think' }),
          part('subtask', { agent: 'a', description: 'd', prompt: 'p' }),
          part('mystery', { payload: 'original' }),
        ],
        { summary: true },
      ),
      user('msg_b', [text('beta')]),
    ])
    const history = await f.driver.read(f.context)
    f.state.forkTransform = mutate
    f.state.calls.length = 0
    await expect(
      f.driver.rewind(f.context, { operationId: 'op-1', targetId: 'msg_b', expected: history }),
    ).rejects.toMatchObject({ code: 'uncertain' })
    expect(f.state.calls.filter((call) => call.startsWith('fork:'))).toHaveLength(1)
  })

  it('remaps assistant parent and compaction tail', async () => {
    const f = fixture()
    f.state.sessions.set(f.state.current, [
      user('msg_a', [text('alpha')]),
      assistant('msg_ar', 'msg_a', [text('reply')]),
      user('msg_uc', [part('compaction', { tail_start_id: 'msg_a' })]),
      assistant('msg_summary', 'msg_uc', [text('summary')], { summary: true }),
      user('msg_b', [text('beta')]),
    ])
    const history = await f.driver.read(f.context)
    const result = await f.driver.rewind(f.context, {
      operationId: 'op-1',
      targetId: 'msg_b',
      expected: history,
    })
    expect(result.retained).toEqual([{ previousId: 'msg_a', nextId: result.retained[0]!.nextId }])
  })

  it('rejects a changed assistant parent or compaction tail', async () => {
    const parent = fixture()
    parent.state.sessions.set(parent.state.current, [
      user('msg_a', [text('alpha')]),
      assistant('msg_ar', 'msg_a', [text('reply')]),
      user('msg_b', [text('beta')]),
    ])
    const parentHistory = await parent.driver.read(parent.context)
    parent.state.forkTransform = (fork) => {
      const assistantMessage = fork.find((message) => message.info.role === 'assistant')!
      assistantMessage.info.parentID = 'msg_other'
      return fork
    }
    await expect(
      parent.driver.rewind(parent.context, {
        operationId: 'op-1',
        targetId: 'msg_b',
        expected: parentHistory,
      }),
    ).rejects.toMatchObject({ code: 'uncertain' })

    const tail = fixture()
    tail.state.sessions.set(tail.state.current, [
      user('msg_a', [text('alpha')]),
      user('msg_uc', [part('compaction', { tail_start_id: 'msg_a' })]),
      assistant('msg_summary', 'msg_uc', [text('summary')], { summary: true }),
      user('msg_b', [text('beta')]),
    ])
    const tailHistory = await tail.driver.read(tail.context)
    tail.state.forkTransform = (fork) => {
      const compactionPart = fork
        .flatMap((message) => message.parts)
        .find((item) => item.type === 'compaction')!
      compactionPart.tail_start_id = 'msg_other'
      return fork
    }
    await expect(
      tail.driver.rewind(tail.context, {
        operationId: 'op-1',
        targetId: 'msg_b',
        expected: tailHistory,
      }),
    ).rejects.toMatchObject({ code: 'uncertain' })
  })

  it('rejects before fork when the history read fails', async () => {
    const f = baseHistory()
    const history = await f.driver.read(f.context)
    f.state.readError = new ExternalMessageEditError('control-unavailable')
    f.state.calls.length = 0
    await expect(
      f.driver.rewind(f.context, { operationId: 'op-1', targetId: 'msg_b', expected: history }),
    ).rejects.toMatchObject({ code: 'control-unavailable' })
    expect(f.state.calls).not.toContainEqual(expect.stringContaining('fork:'))
  })

  it('treats a fork network/5xx failure as uncertain and does not retry', async () => {
    const f = baseHistory()
    const history = await f.driver.read(f.context)
    f.state.forkError = new ExternalMessageEditError('uncertain', 503)
    f.state.calls.length = 0
    await expect(
      f.driver.rewind(f.context, { operationId: 'op-1', targetId: 'msg_b', expected: history }),
    ).rejects.toMatchObject({ code: 'uncertain', status: 503 })
    expect(f.state.calls.filter((call) => call.startsWith('fork:'))).toHaveLength(1)
  })

  it('does not call fork when the caller is already aborted', async () => {
    const f = baseHistory()
    const history = await f.driver.read(f.context)
    const controller = new AbortController()
    controller.abort()
    const aborted = contextFor('opencode', f.state, controller.signal)
    f.state.calls.length = 0
    await expect(
      f.driver.rewind(aborted, { operationId: 'op-1', targetId: 'msg_b', expected: history }),
    ).rejects.toMatchObject({ code: 'aborted' })
    expect(f.state.calls).not.toContainEqual(expect.stringContaining('fork:'))
  })

  it('marks a fork whose verification fails as uncertain and never deletes', async () => {
    const f = baseHistory()
    const history = await f.driver.read(f.context)
    f.state.forkTransform = (fork) => fork.slice(0, -1)
    f.state.calls.length = 0
    await expect(
      f.driver.rewind(f.context, { operationId: 'op-1', targetId: 'msg_b', expected: history }),
    ).rejects.toMatchObject({ code: 'uncertain' })
    expect(f.state.calls.filter((call) => call.startsWith('fork:'))).toHaveLength(1)
    expect(f.state.calls).not.toContainEqual(expect.stringContaining('delete'))
  })

  it('uses the Kilo harness identity and rejects the wrong driver', async () => {
    const kilo = baseHistory('kilo')
    await expect(kilo.driver.read(kilo.context)).resolves.toMatchObject({
      sessionId: 'ses_current',
    })
    const wrong = contextFor('opencode', kilo.state)
    await expect(kilo.driver.read(wrong)).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('does not expose provider text in failures', async () => {
    const f = baseHistory()
    const history = await f.driver.read(f.context)
    f.state.forkError = new ExternalMessageEditError('fork-rejected', 400)
    await expect(
      f.driver.rewind(f.context, { operationId: 'op-1', targetId: 'msg_b', expected: history }),
    ).rejects.toMatchObject({
      code: 'fork-rejected',
      status: 400,
      message: '官方 CLI 拒绝了本次分支请求',
    })
  })
})
