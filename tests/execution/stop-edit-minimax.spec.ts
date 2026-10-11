/**
 * MiniMax 停止后编辑：能力门禁、候选 v1 形状、精确映射、真实回退与投影同步。
 *
 * 协议形状以候选补丁为准：list 返回 `{version:1, sessionId, entries:[...]}`，没有完整
 * 原文、没有 turnId 承诺，也没有 entries 的排序承诺。因此这里大量断言“不猜”。
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { HarnessSession, HarnessTurn } from '../../src/execution/contracts/sessions.ts'
import type { StopEditTarget } from '../../src/execution/host/stop-edit.ts'
import {
  HISTORY_BOUNDARY,
  HISTORY_LIST,
  HISTORY_META,
  HISTORY_REWIND,
  minimaxStopEditRuntime,
  operationByUserMessage,
  readMinimaxCapability,
  readMinimaxEntries,
  type MinimaxHistorySource,
} from '../../src/execution/host/stop-edit-minimax.ts'
import type { NativeSessionSource } from '../../src/execution/host/stop-edit-native.ts'
import { harnessRequestId } from '../../src/execution/host/native-conversations.ts'

const events = (...items: unknown[]) => items as unknown as readonly SessionEvent[]
const projectedMessage = (seq: number, text: string, rpcId: string) => ({
  seq,
  type: 'user/message',
  data: { role: 'user', source: { kind: 'user', rpcId }, content: [{ type: 'text', text }] },
})

const turn = (operationId: string, native?: { userMessageId?: string }): HarnessTurn => ({
  operationId,
  fingerprint: 'fp',
  prompt: `原文-${operationId}`,
  text: '',
  state: 'completed',
  tools: [],
  ...(native ? { native } : {}),
})

const record = (turns: HarnessTurn[]): HarnessSession => ({
  id: 'harness-mm',
  combination: 'minimax-code/MiniMax-M3.1',
  harnessRef: 'minimax-code',
  modelRef: { provider: 'minimax', model: 'MiniMax-M3.1' },
  cwd: 'C:/work',
  acpSessionId: 'acp-1',
  nativeSessionId: 'session-projection',
  title: 'MiniMax',
  sandbox: 'full-access',
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  turns,
})

const target = (session: HarnessSession): StopEditTarget => ({
  sessionId: session.nativeSessionId!,
  harness: 'minimax-code',
  record: session,
})

const announced = () => ({
  _meta: {
    [HISTORY_META]: {
      version: 1,
      methods: [HISTORY_LIST, HISTORY_REWIND],
      notifications: [HISTORY_BOUNDARY],
    },
  },
})

/** 候选实际的 list 响应形状。 */
const listResponse = (entries: unknown[]) => ({ version: 1, sessionId: 'acp-1', entries })

function projection(
  session: HarnessSession,
  calls: { forks: { sessionId: string; atSeq: number }[]; rebinds: string[] } = {
    forks: [],
    rebinds: [],
  },
): NativeSessionSource {
  return {
    events: (sessionId) =>
      sessionId === session.nativeSessionId
        ? events(
            projectedMessage(1, '第一条', String(harnessRequestId(session, session.turns[0]!))),
            projectedMessage(2, '第二条', String(harnessRequestId(session, session.turns[1]!))),
            projectedMessage(3, '第三条', String(harnessRequestId(session, session.turns[2]!))),
          )
        : events(),
    running: () => false,
    whenIdle: async () => {},
    cwd: () => 'C:/work',
    fork: async (sessionId, atSeq) => {
      calls.forks.push({ sessionId, atSeq })
      return `${sessionId}-branch`
    },
    create: async (sessionId) => `${sessionId}-empty`,
    rebind: async (sessionId, _previous, editedHead) => {
      calls.rebinds.push(`${sessionId}:${editedHead}`)
      return {
        model: 'MiniMax-M3.1',
        effort: 'high',
        permissions: 'danger-full-access',
        cwd: 'C:/work',
        workspaceId: 'ws-1',
        project: 'C:/work',
        title: `原文 · 编辑分支`,
      }
    },
  }
}

function source(
  payload: unknown,
  result: unknown,
  calls: string[] = [],
  ready = true,
): MinimaxHistorySource {
  return {
    capability: () =>
      ready ? { ready: true } : { ready: false, reason: '当前 MiniMax Runtime 未安装会话历史扩展' },
    list: async () => payload,
    rewind: async (sessionId, userMessageId, clientRequestId) => {
      calls.push(`${sessionId}|${userMessageId}|${clientRequestId}`)
      return result
    },
    deletedMessageIds: (value) =>
      Array.isArray((value as any)?.deletedMessageIds)
        ? ((value as any).deletedMessageIds as string[])
        : [],
    review: () => ({
      model: 'MiniMax-M3.1',
      effort: 'high',
      permissions: 'danger-full-access',
      cwd: 'C:/work',
      workspaceId: 'ws-1',
      title: 'MiniMax',
    }),
  }
}

describe('候选 v1 形状', () => {
  it('识别候选实际的 entries 响应', () => {
    expect(
      readMinimaxEntries(listResponse([{ userMessageId: 'u1', contentHead: 'FULL' }])),
    ).toHaveLength(1)
  })

  it('没有候选给出的记录一律丢弃，不构造假边界', () => {
    expect(readMinimaxEntries({ boundaries: [{ userMessageId: 'u1' }] })).toEqual([])
    expect(readMinimaxEntries({ version: 2, entries: [{ userMessageId: 'u1' }] })).toEqual([])
    expect(readMinimaxEntries(null)).toEqual([])
    expect(readMinimaxEntries(listResponse([{}, null, { userMessageId: '' }]))).toEqual([])
  })

  it('主审负例：候选 entries 必须被识别成一条边界', async () => {
    const session = record([turn('o1', { userMessageId: 'u1' })])
    const runtime = minimaxStopEditRuntime(
      source(listResponse([{ userMessageId: 'u1', contentHead: 'FULL' }]), { rewound: true }),
    )
    const boundaries = await runtime.boundaries(session, session.nativeSessionId!)
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]!.operationId).toBe('o1')
  })
})

describe('能力门禁', () => {
  it('没有公告时判为不可用', () => {
    const capability = readMinimaxCapability({ protocolVersion: 1 })
    expect(capability.ready).toBe(false)
    expect(capability.reason).toContain('未安装会话历史扩展')
  })

  it('版本不符、缺少方法或缺少通知，一律不可用', () => {
    expect(
      readMinimaxCapability({
        _meta: { [HISTORY_META]: { version: 2, methods: [], notifications: [] } },
      }).ready,
    ).toBe(false)
    expect(
      readMinimaxCapability({
        _meta: {
          [HISTORY_META]: {
            version: 1,
            methods: [HISTORY_LIST],
            notifications: [HISTORY_BOUNDARY],
          },
        },
      }).ready,
    ).toBe(false)
    expect(
      readMinimaxCapability({
        _meta: {
          [HISTORY_META]: {
            version: 1,
            methods: [HISTORY_LIST, HISTORY_REWIND],
            notifications: [],
          },
        },
      }).ready,
    ).toBe(false)
    expect(
      readMinimaxCapability({
        _meta: { [HISTORY_META]: { version: 1, methods: 'all', notifications: 'all' } },
      }).ready,
    ).toBe(false)
  })

  it('候选只公告 list 与 rewind 就已经足够', () => {
    expect(readMinimaxCapability(announced()).ready).toBe(true)
  })

  it('扩展缺席时不会发起任何历史请求', async () => {
    const session = record([turn('o1', { userMessageId: 'u1' })])
    const runtime = minimaxStopEditRuntime({
      ...source(listResponse([]), { rewound: true }, [], false),
      list: async () => {
        throw Error('不应发起历史请求')
      },
    })
    expect(runtime.capability().ready).toBe(false)
    await expect(runtime.boundaries(session, 'session-projection')).rejects.toThrow(
      '不应发起历史请求',
    )
  })
})

describe('精确映射与不猜', () => {
  it('没有 operation 映射的记录被挡住，而不是按摘要猜配', async () => {
    const session = record([turn('o1', { userMessageId: 'u1' }), turn('o2')])
    const runtime = minimaxStopEditRuntime(
      source(
        listResponse([
          { userMessageId: 'u1', contentHead: '第一条' },
          { userMessageId: 'u2', contentHead: '第二条' },
        ]),
        { rewound: true },
      ),
    )
    const boundaries = await runtime.boundaries(session, 'session-projection')
    expect(boundaries[1]!.blocked).toBe(true)
    expect(boundaries[1]!.blockedReason).toContain('精确映射')
    // 候选没有承诺排序，因此不猜哪一条是首条。
    expect(boundaries.every((item) => item.first === false)).toBe(true)
  })

  it('没有映射的边界即使被强行提交也会在改动 Runtime 之前被拒绝', async () => {
    const session = record([turn('o1', { userMessageId: 'u1' })])
    const calls: string[] = []
    const runtime = minimaxStopEditRuntime(
      source(
        listResponse([{ userMessageId: 'u9', contentHead: '旧消息' }]),
        { rewound: true },
        calls,
      ),
    )
    await expect(
      runtime.plan({
        record: session,
        sessionId: 'session-projection',
        boundary: { id: 'u9', contentHead: '旧消息', attachmentCount: 0, first: false },
        clientRequestId: 'r1',
        operationId: 'op-new',
      }),
    ).rejects.toMatchObject({ reason: 'missing-mapping' })
    expect(calls).toEqual([])
  })

  it('投影缺少精确锚点时在 rewind 之前拒绝，不先改 Runtime 再留旧投影', async () => {
    const session = record([turn('o1', { userMessageId: 'u1' })])
    const calls: string[] = []
    // 投影日志里没有这条消息对应的稳定 requestId。
    const brokenProjection: NativeSessionSource = {
      ...projection(session),
      events: () => events(projectedMessage(1, '第一条', 'unrelated-rpc')),
    }
    const runtime = minimaxStopEditRuntime(
      source(
        listResponse([{ userMessageId: 'u1', contentHead: '第一条' }]),
        { rewound: true },
        calls,
      ),
      brokenProjection,
    )
    await expect(
      runtime.plan({
        record: session,
        sessionId: 'session-projection',
        boundary: { id: 'u1', contentHead: '第一条', attachmentCount: 0, first: false },
        clientRequestId: 'r1',
        operationId: 'op-new',
      }),
    ).rejects.toMatchObject({ reason: 'missing-mapping' })
    expect(calls).toEqual([])
  })

  it('Runtime 没有确认成功时不宣称回退', async () => {
    const session = record([turn('o1', { userMessageId: 'u1' })])
    const runtime = minimaxStopEditRuntime(
      source(listResponse([{ userMessageId: 'u1' }]), { rewound: false }),
    )
    await expect(
      runtime.rewind({
        record: session,
        sessionId: 'session-projection',
        boundary: { id: 'u1', contentHead: '', attachmentCount: 0, first: false },
        clientRequestId: 'r1',
        operationId: 'op-new',
      }),
    ).rejects.toMatchObject({ reason: 'rewind-failed' })
  })
})

describe('真实回退与投影同步', () => {
  it('普通对话按保存的官方 seq 回填原消息，不把 Runtime 包装上下文放回输入框', async () => {
    const session = record([
      turn('o1', { userMessageId: 'u1' }),
      turn('o2', { userMessageId: 'u2' }),
      turn('o3', { userMessageId: 'u3' }),
    ])
    session.turns[1]!.native!.officialSeq = 2
    session.turns[1]!.prompt = '运行环境与包装上下文，不是用户原文'
    const projected = projection(session)
    projected.events = () =>
      events(
        projectedMessage(1, '第一条', 'actual-rpc-1'),
        projectedMessage(2, '第二条原文', 'actual-rpc-2'),
      )
    const runtime = minimaxStopEditRuntime(
      source(listResponse([{ userMessageId: 'u2' }]), {
        rewound: true,
        deletedMessageIds: ['u2', 'u3'],
      }),
      projected,
    )
    const input = {
      record: session,
      sessionId: 'session-projection',
      boundary: { id: 'u2', contentHead: '摘要', attachmentCount: 0, first: false },
      clientRequestId: 'r1',
      operationId: 'new',
    }
    expect((await runtime.plan(input)).draft).toBe('第二条原文')
    expect((await runtime.rewind(input)).draft).toBe('第二条原文')
    session.turns[1]!.native!.officialSeq = 99
    await expect(runtime.plan(input)).rejects.toThrow('精确落点')
  })

  it('首条之前的轮次事件不进入 MiniMax 编辑后的空分支', async () => {
    const session = record([turn('o1', { userMessageId: 'u1', officialSeq: 2 })])
    const calls = { forks: [] as { sessionId: string; atSeq: number }[], rebinds: [] as string[] }
    const projected = projection(session, calls)
    projected.events = () =>
      events(
        { seq: 1, type: 'turn/start', data: {} },
        projectedMessage(2, '第一条原文', 'actual-rpc'),
      )
    const runtime = minimaxStopEditRuntime(
      source(listResponse([{ userMessageId: 'u1' }]), { rewound: true, deletedMessageIds: ['u1'] }),
      projected,
    )
    const outcome = await runtime.rewind({
      record: session,
      sessionId: 'session-projection',
      boundary: { id: 'u1', contentHead: '摘要', attachmentCount: 0, first: true },
      clientRequestId: 'r1',
      operationId: 'new',
    })
    expect(outcome.sessionId).toBe('session-projection-empty')
    expect(calls.forks).toEqual([])
    expect(outcome.draft).toBe('第一条原文')
    expect(outcome.classify(session.turns[0]!)).toBe('after')
  })

  it('普通对话带附件时，在调用 Runtime 回退之前拒绝', async () => {
    const session = record([
      turn('o1', { userMessageId: 'u1' }),
      turn('o2', { userMessageId: 'u2' }),
      turn('o3', { userMessageId: 'u3' }),
    ])
    session.turns[0]!.native!.officialSeq = 1
    const projected = projection(session)
    projected.events = () =>
      events({
        ...projectedMessage(1, '附件消息', 'actual-rpc'),
        data: {
          role: 'user',
          source: { kind: 'user', rpcId: 'actual-rpc' },
          content: [{ type: 'file', attachment: { name: 'note.txt' } }],
        },
      })
    const calls: string[] = []
    const runtime = minimaxStopEditRuntime(
      source(listResponse([{ userMessageId: 'u1' }]), { rewound: true }, calls),
      projected,
    )
    await expect(
      runtime.plan({
        record: session,
        sessionId: 'session-projection',
        boundary: { id: 'u1', contentHead: '摘要', attachmentCount: 0, first: false },
        clientRequestId: 'r1',
        operationId: 'new',
      }),
    ).rejects.toThrow('附件')
    expect(calls).toEqual([])
  })

  it('原文取自 OPL 自己的轮次，绝不把 Runtime 摘要当成原文', async () => {
    const session = record([turn('o1', { userMessageId: 'u1' })])
    const runtime = minimaxStopEditRuntime(
      source(listResponse([{ userMessageId: 'u1', contentHead: '前 80 个字符…' }]), {
        rewound: true,
      }),
    )
    const plan = await runtime.plan({
      record: session,
      sessionId: 'session-projection',
      boundary: { id: 'u1', contentHead: '前 80 个字符…', attachmentCount: 0, first: false },
      clientRequestId: 'r1',
      operationId: 'op-new',
    })
    expect(plan.draft).toBe('原文-o1')
    expect(plan.draft).not.toContain('…')
  })

  it('Runtime 原地回退后，官方投影被切在同一条边界之前', async () => {
    const session = record([
      turn('o1', { userMessageId: 'u1' }),
      turn('o2', { userMessageId: 'u2' }),
      turn('o3', { userMessageId: 'u3' }),
    ])
    const calls = { forks: [] as { sessionId: string; atSeq: number }[], rebinds: [] as string[] }
    const runtime = minimaxStopEditRuntime(
      source(
        listResponse([{ userMessageId: 'u1' }, { userMessageId: 'u2' }, { userMessageId: 'u3' }]),
        { rewound: true, deletedMessageIds: ['u2', 'u3'] },
        [],
      ),
      projection(session, calls),
    )
    const outcome = await runtime.rewind({
      record: session,
      sessionId: 'session-projection',
      boundary: { id: 'u2', contentHead: '第二条', attachmentCount: 0, first: false },
      clientRequestId: 'r1',
      operationId: 'op-new',
    })
    expect(calls.forks).toEqual([{ sessionId: 'session-projection', atSeq: 1 }])
    expect(outcome.draft).toBe('原文-o2')
    // 归属依据 Runtime 实际删除的标识，与 entries 的返回顺序无关。
    expect(outcome.classify(session.turns[0]!)).toBe('before')
    expect(outcome.classify(session.turns[1]!)).toBe('after')
    expect(outcome.classify(session.turns[2]!)).toBe('after')
    // 被删掉的尾部是用户自己的选择，不作为无法恢复项报错。
    expect(outcome.unrestored).toEqual([])
  })

  it('entries 顺序被刻意打乱时，归属仍然只依据删除结果', async () => {
    const session = record([
      turn('o1', { userMessageId: 'u1' }),
      turn('o2', { userMessageId: 'u2' }),
      turn('o3', { userMessageId: 'u3' }),
    ])
    const calls = { forks: [] as { sessionId: string; atSeq: number }[], rebinds: [] as string[] }
    const runtime = minimaxStopEditRuntime(
      source(
        // 返回顺序与真实时间顺序相反。
        listResponse([{ userMessageId: 'u3' }, { userMessageId: 'u1' }, { userMessageId: 'u2' }]),
        { rewound: true, deletedMessageIds: ['u1'] },
        [],
      ),
      projection(session, calls),
    )
    const outcome = await runtime.rewind({
      record: session,
      sessionId: 'session-projection',
      boundary: { id: 'u1', contentHead: '第一条', attachmentCount: 0, first: false },
      clientRequestId: 'r1',
      operationId: 'op-new',
    })
    expect(outcome.classify(session.turns[0]!)).toBe('after')
    expect(outcome.classify(session.turns[1]!)).toBe('before')
    expect(outcome.classify(session.turns[2]!)).toBe('before')
  })

  it('重新列出失败时不会伪造边界', async () => {
    const session = record([turn('o1', { userMessageId: 'u1' })])
    const runtime = minimaxStopEditRuntime(source({ unexpected: true }, { rewound: true }))
    expect(await runtime.boundaries(session, 'session-projection')).toEqual([])
  })

  it('operation 与原生用户消息的映射只来自持久事实', () => {
    const session = record([
      turn('o1', { userMessageId: 'u1' }),
      turn('o2'),
      turn('o3', { userMessageId: 'u3' }),
    ])
    const mapping = operationByUserMessage(session)
    expect([...mapping.keys()]).toEqual(['u1', 'u3'])
  })
})
