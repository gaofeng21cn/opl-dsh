/**
 * 停止后编辑的核心行为：目标解析、精确边界、真正静止、幂等、意图持久化与不确定状态。
 *
 * 只依赖注入的接入面，不启动官方应用、不发送模型请求，也不触碰真实会话或凭据。
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { HarnessSession, HarnessTurn } from '../../src/execution/contracts/sessions.ts'
import type {
  StopEditBoundary,
  StopEditIntent,
  StopEditResult,
} from '../../src/execution/contracts/stop-edit.ts'
import {
  planProjectionCut,
  StopEditError,
  StopEditService,
  contentHead,
  type StopEditHost,
  type StopEditRewindOutcome,
  type StopEditRuntime,
  type StopEditTail,
  type StopEditTarget,
} from '../../src/execution/host/stop-edit.ts'
import {
  nativeStopEditRuntime,
  readNativeUserMessages,
  type NativeSessionSource,
} from '../../src/execution/host/stop-edit-native.ts'

const events = (...items: unknown[]) => items as unknown as readonly SessionEvent[]
const userMessage = (seq: number, text: string, rpcId?: string) => ({
  seq,
  type: 'user/message',
  data: {
    role: 'user',
    source: { kind: 'user', ...(rpcId ? { rpcId } : {}) },
    content: [{ type: 'text', text }],
  },
})
const assistantMessage = (seq: number, text: string) => ({
  seq,
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
})
const turn = (operationId: string, extra: Partial<HarnessTurn> = {}): HarnessTurn => ({
  operationId,
  fingerprint: 'fp',
  prompt: `prompt-${operationId}`,
  text: '',
  state: 'completed',
  tools: [],
  ...extra,
})
const record = (extra: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 'harness-1',
  combination: 'dsh/deepseek-flash',
  harnessRef: 'dsh',
  modelRef: { provider: 'deepseek', model: 'deepseek-flash' },
  cwd: 'C:/work',
  acpSessionId: 'session-1',
  title: '组合',
  sandbox: 'workspace',
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  turns: [],
  ...extra,
})

interface Fakes {
  intents: Map<string, StopEditIntent>
  forks: { sessionId: string; atSeq: number }[]
  created: { sessionId: string; cwd: string }[]
  log: Record<string, readonly SessionEvent[]>
  busy: Set<string>
  stops: string[]
  commits: number
  rebinds: { sessionId: string; previousSessionId: string; editedHead: string }[]
  failRewind?: () => void
  /** 模拟 Runtime 已经改成功、但投影或落盘失败。 */
  failCommit?: () => void
}

function fakeSource(state: Fakes): NativeSessionSource {
  return {
    events: (sessionId) => state.log[sessionId],
    running: (sessionId) => state.busy.has(sessionId),
    whenIdle: async () => {},
    cwd: () => 'C:/work',
    fork: async (sessionId, atSeq) => {
      state.forks.push({ sessionId, atSeq })
      const forked = `${sessionId}-fork${state.forks.length}`
      state.log[forked] = events()
      return forked
    },
    create: async (sessionId, cwd) => {
      state.created.push({ sessionId, cwd })
      const created = `${sessionId}-empty${state.created.length}`
      state.log[created] = events()
      return created
    },
    rebind: async (sessionId, previousSessionId, editedHead) => {
      state.rebinds.push({ sessionId, previousSessionId, editedHead })
      return {
        model: 'deepseek-flash',
        effort: 'high',
        permissions: 'workspace-write',
        cwd: 'C:/work',
        workspaceId: 'ws-1',
        project: 'C:/work',
        title: `${editedHead} · 编辑分支`,
      }
    },
  }
}

function harness(
  options: { record?: HarnessSession | null; log?: Record<string, readonly SessionEvent[]> } = {},
) {
  const session =
    options.record === null
      ? undefined
      : (options.record ?? record({ turns: [turn('op-1'), turn('op-2'), turn('op-3')] }))
  const state: Fakes = {
    intents: new Map(),
    forks: [],
    created: [],
    log: {
      'session-1':
        options.log?.['session-1'] ??
        events(userMessage(1, '第一条'), assistantMessage(2, '回答一'), userMessage(3, '第二条')),
    },
    busy: new Set(),
    stops: [],
    commits: 0,
    rebinds: [],
  }
  const native = nativeStopEditRuntime(fakeSource(state))
  let operations = 0
  const runtime: StopEditRuntime = {
    ...native,
    rewind: async (request) => {
      state.failRewind?.()
      return native.rewind(request)
    },
  }
  const resolve = (sessionId: string): StopEditTarget | undefined =>
    session && (session.acpSessionId === sessionId || session.nativeSessionId === sessionId)
      ? {
          sessionId,
          harness: session.harnessRef === 'dsh' ? 'dsh' : 'minimax-code',
          record: session,
        }
      : sessionId === 'session-1'
        ? { sessionId, harness: 'dsh' }
        : undefined
  const commit = async (input: {
    target: StopEditTarget
    outcome: StopEditRewindOutcome
    boundary: StopEditBoundary
    clientRequestId: string
    operationId: string
    keep: number
  }): Promise<StopEditResult> => {
    state.commits += 1
    state.failCommit?.()
    const previous = input.target.sessionId
    const removed = session ? session.turns.length - input.keep : 0
    if (session) {
      session.turns = session.turns.slice(0, input.keep)
      if (session.harnessRef === 'dsh') session.acpSessionId = input.outcome.sessionId
      else session.nativeSessionId = input.outcome.sessionId
    }
    const result: StopEditResult = {
      sessionId: input.outcome.sessionId,
      clientRequestId: input.clientRequestId,
      preservedSessionId: input.outcome.preservedSessionId,
      branchTitle: input.outcome.review.title,
      moved: input.outcome.sessionId !== previous,
      boundary: input.boundary,
      draft: input.outcome.draft,
      unrestored: input.outcome.unrestored,
      removedTurns: removed,
      review: {
        ...input.outcome.review,
        feedback: { pendingDeliveries: 0, operationId: input.operationId },
      },
      version: 1,
    }
    // 与真实台账一致：落两份——新目标会话带待填原文，旧页面只留结果不带原文。
    const intent = state.intents.get(previous)!
    state.intents.set(input.outcome.sessionId, {
      ...intent,
      sessionId: input.outcome.sessionId,
      phase: 'committed',
      result,
    })
    if (input.outcome.sessionId !== input.outcome.preservedSessionId)
      state.intents.set(input.outcome.preservedSessionId, {
        ...intent,
        sessionId: input.outcome.preservedSessionId,
        phase: 'committed',
        result,
        pendingDraft: '',
      })
    return result
  }
  const blocked = (sessionId: string): string | undefined => {
    const intent = state.intents.get(sessionId)
    if (!intent) return undefined
    if (intent.phase === 'uncertain') return intent.reason
    if (intent.phase === 'rewinding')
      return '上一次停止后编辑在改动途中中断，请先核对会话历史后再发送'
    return undefined
  }
  const host: StopEditHost = {
    resolve,
    addressedSession: (target) => target.record?.acpSessionId ?? target.sessionId,
    runtime: (target) => (target.harness === 'dsh' ? runtime : undefined),
    busy: (target) => state.busy.has(target.record?.acpSessionId ?? target.sessionId),
    stopAndWait: async (target) => {
      state.stops.push(target.record?.acpSessionId ?? target.sessionId)
      state.busy.clear()
    },
    nextOperationId: () => `op-new-${++operations}`,
    intent: (sessionId) => state.intents.get(sessionId),
    plan: async (input) => {
      state.intents.set(input.target.sessionId, {
        sessionId: input.target.sessionId,
        clientRequestId: input.clientRequestId,
        boundaryId: input.boundaryId,
        preservedSessionId: input.preservedSessionId,
        pendingOperationId: input.pendingOperationId,
        pendingDraft: input.pendingDraft,
        phase: 'planned',
        at: '2026-10-10T00:00:00.000Z',
        updatedAt: '2026-10-10T00:00:00.000Z',
      })
    },
    markRewinding: async (sessionId) => {
      const intent = state.intents.get(sessionId)!
      state.intents.set(sessionId, { ...intent, phase: 'rewinding' })
    },
    commit,
    blocked,
    markUncertain: async (sessionId, reason) => {
      const intent = state.intents.get(sessionId)!
      state.intents.set(sessionId, { ...intent, phase: 'uncertain', reason })
    },
    acknowledgeDraft: async (sessionId, clientRequestId) => {
      const intent = state.intents.get(sessionId)
      if (intent?.clientRequestId === clientRequestId)
        state.intents.set(sessionId, { ...intent, pendingDraft: '' })
    },
  }
  const service = new StopEditService(host)
  return { service, state, session, runtime, native }
}

describe('普通原生 DSH 对话：没有委派记录也能编辑', () => {
  it('没有 HarnessSession 时依然列出边界并完成回退', async () => {
    const h = harness({ record: null })
    const state = await h.service.state({ sessionId: 'session-1' })
    expect(state.supported).toBe(true)
    expect(state.harness).toBe('dsh')
    expect(state.boundaries.map((item) => item.id)).toEqual(['dsh:1', 'dsh:3'])
    const result = await h.service.rewind({
      clientRequestId: 'r1',
      sessionId: 'session-1',
      boundaryId: 'dsh:3',
    })
    expect(h.state.forks).toEqual([{ sessionId: 'session-1', atSeq: 2 }])
    expect(result.draft).toBe('第二条')
    // 没有投影可裁剪，也不能凭空捏造一个被删除的轮次。
    expect(result.removedTurns).toBe(0)
    expect(h.state.commits).toBe(1)
  })

  it('回退后逐项复核模型、权限、cwd 与分支标题，标题可用于会话列表查找', async () => {
    const h = harness({ record: null })
    const result = await h.service.rewind({
      clientRequestId: 'r1',
      sessionId: 'session-1',
      boundaryId: 'dsh:1',
    })
    expect(result.review.model).toBe('deepseek-flash')
    expect(result.review.effort).toBe('high')
    expect(result.review.permissions).toBe('workspace-write')
    expect(result.review.cwd).toBe('C:/work')
    expect(result.review.workspaceId).toBe('ws-1')
    expect(result.branchTitle).toContain('编辑分支')
    expect(result.moved).toBe(true)
    // 新分支必须重写模型、权限与标题，而不是沿用或留默认。
    expect(h.state.rebinds).toHaveLength(1)
    expect(h.state.rebinds[0]!.editedHead).toBe('第一条')
  })
})

describe('原生 DSH 的精确边界', () => {
  it('回退到所选消息之前使用紧邻它之前的事件 seq', async () => {
    const h = harness({
      log: {
        'session-1': events(
          userMessage(1, '第一条', 'r1'),
          assistantMessage(2, '回答一'),
          userMessage(3, '第二条', 'r2'),
          assistantMessage(4, '回答二'),
          userMessage(5, '第三条', 'r3'),
        ),
      },
    })
    const state = await h.service.state({ sessionId: 'session-1' })
    expect(state.boundaries[0]!.first).toBe(true)
    expect(state.boundaries[1]!.first).toBe(false)
    const result = await h.service.rewind({
      clientRequestId: 'r1',
      sessionId: 'session-1',
      boundaryId: 'dsh:3',
    })
    expect(h.state.forks).toEqual([{ sessionId: 'session-1', atSeq: 2 }])
    expect(result.draft).toBe('第二条')
  })

  it.each([false, true])(
    '首条用户消息进入空分支，并清空整段投影（之前存在轮次事件：%s）',
    async (prefix) => {
      const h = harness(
        prefix
          ? {
              log: {
                'session-1': events(
                  { seq: 1, type: 'turn/start', data: {} },
                  userMessage(2, '第一条', 'r1'),
                  assistantMessage(3, '回答一'),
                  userMessage(4, '第二条', 'r2'),
                  assistantMessage(5, '回答二'),
                  userMessage(6, '第三条', 'r3'),
                ),
              },
            }
          : {},
      )
      const result = await h.service.rewind({
        clientRequestId: 'r1',
        sessionId: 'session-1',
        boundaryId: prefix ? 'dsh:2' : 'dsh:1',
      })
      expect(h.state.forks).toEqual([])
      expect(h.state.created).toEqual([{ sessionId: 'session-1', cwd: 'C:/work' }])
      expect(result.removedTurns).toBe(3)
      expect(h.session!.turns).toEqual([])
    },
  )

  it('注入的续轮消息不成为可回退边界，切点取日志里紧邻它之前的事件', () => {
    const messages = readNativeUserMessages(
      events(
        userMessage(1, '用户输入', 'r1'),
        userMessage(2, '系统注入', 'task-feedback-resume:abc'),
        userMessage(3, '第二条', 'r2'),
      ),
    )
    expect(messages.map((item) => item.text)).toEqual(['用户输入', '第二条'])
    expect(messages[1]!.prevSeq).toBe(2)
  })

  it('带附件的消息在改动会话之前就被拒绝，并且不会 fork', async () => {
    const h = harness({
      log: {
        'session-1': events(userMessage(1, '第一条', 'r1'), {
          seq: 2,
          type: 'user/message',
          data: {
            role: 'user',
            source: { kind: 'user', rpcId: 'r2' },
            content: [
              { type: 'text', text: '看看这个' },
              {
                type: 'image',
                attachment: {
                  attachmentId: 'a1',
                  mediaType: 'image/png',
                  bytes: 1,
                  width: 2,
                  height: 2,
                  name: 'shot.png',
                },
              },
            ],
          },
        }),
      },
    })
    await expect(
      h.service.rewind({ clientRequestId: 'r1', sessionId: 'session-1', boundaryId: 'dsh:2' }),
    ).rejects.toMatchObject({ reason: 'attachments-unrestorable' })
    expect(h.state.forks).toEqual([])
    expect(h.state.created).toEqual([])
    expect(h.state.intents.size).toBe(0)
  })

  it('附件数量在边界上如实可见，并在点击之前就标成禁用', async () => {
    const h = harness({
      log: {
        'session-1': events({
          seq: 1,
          type: 'user/message',
          data: {
            role: 'user',
            source: { kind: 'user', rpcId: 'r1' },
            content: [
              { type: 'text', text: '带附件' },
              { type: 'file', attachment: { attachmentId: 'a2', name: 'report.md', bytes: 3 } },
            ],
          },
        }),
      },
    })
    const state = await h.service.state({ sessionId: 'session-1' })
    expect(state.boundaries[0]!.attachmentCount).toBe(1)
    // 官方没有附件回填接口：用户必须在点击之前就看到禁用原因，而不是点完才被拒绝。
    expect(state.boundaries[0]!.blocked).toBe(true)
    expect(state.boundaries[0]!.blockedReason).toContain('附件')
  })
})

describe('停止、静止与失败', () => {
  it('正在运行时先停止并等真正静止，再重新定位精确边界', async () => {
    const h = harness()
    h.state.busy.add('session-1')
    const result = await h.service.rewind({
      clientRequestId: 'r1',
      sessionId: 'session-1',
      boundaryId: 'dsh:1',
    })
    expect(h.state.stops).toEqual(['session-1'])
    expect(result.draft).toBe('第一条')
  })

  it('停止受理后仍未静止时报失败，绝不宣称回退成功', async () => {
    const h = harness()
    h.state.busy.add('session-1')
    const service = new StopEditService({
      ...hostOf(h),
      busy: () => true,
      stopAndWait: async () => {},
    })
    await expect(
      service.rewind({ clientRequestId: 'r1', sessionId: 'session-1', boundaryId: 'dsh:1' }),
    ).rejects.toMatchObject({ reason: 'busy-timeout' })
    expect(h.state.forks).toEqual([])
  })

  it('变更之后失败落到不确定状态，而不是谎称会话没被改动', async () => {
    const h = harness()
    h.state.failRewind = () => {
      throw new Error('Runtime 内部：E:\\secret\\path\\runtime.log 超时')
    }
    await expect(
      h.service.rewind({ clientRequestId: 'r1', sessionId: 'session-1', boundaryId: 'dsh:3' }),
    ).rejects.toMatchObject({ reason: 'rewind-failed' })
    const intent = h.state.intents.get('session-1')!
    expect(intent.phase).toBe('uncertain')
    expect(intent.reason).toBeTruthy()
    // 不确定之后入口关闭，直到真实历史被核对。
    const state = await h.service.state({ sessionId: 'session-1' })
    expect(state.supported).toBe(false)
  })

  it('不确定状态之后的请求被拒绝，而不是再发一次', async () => {
    const h = harness()
    h.state.intents.set('session-1', {
      sessionId: 'session-1',
      clientRequestId: 'r0',
      boundaryId: 'dsh:1',
      preservedSessionId: 'session-1',
      pendingOperationId: 'op-0',
      pendingDraft: '',
      phase: 'uncertain',
      reason: '结果不确定',
      at: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-10T00:00:00.000Z',
    })
    await expect(
      h.service.rewind({ clientRequestId: 'r9', sessionId: 'session-1', boundaryId: 'dsh:3' }),
    ).rejects.toMatchObject({ reason: 'uncertain' })
    expect(h.state.forks).toEqual([])
  })
})

function hostOf(h: ReturnType<typeof harness>): StopEditHost {
  return {
    resolve: (sessionId) =>
      h.session && (h.session.acpSessionId === sessionId || h.session.nativeSessionId === sessionId)
        ? {
            sessionId,
            harness: h.session.harnessRef === 'dsh' ? 'dsh' : 'minimax-code',
            record: h.session,
          }
        : sessionId === 'session-1'
          ? { sessionId, harness: 'dsh' }
          : undefined,
    addressedSession: (target) => target.record?.acpSessionId ?? target.sessionId,
    runtime: (target) => h.runtime,
    busy: (target) => h.state.busy.has(target.sessionId),
    stopAndWait: async (target) => {
      h.state.stops.push(target.sessionId)
      h.state.busy.clear()
    },
    nextOperationId: () => 'op-new',
    intent: (sessionId) => h.state.intents.get(sessionId),
    plan: async (input) => {
      h.state.intents.set(input.target.sessionId, {
        sessionId: input.target.sessionId,
        clientRequestId: input.clientRequestId,
        boundaryId: input.boundaryId,
        preservedSessionId: input.preservedSessionId,
        pendingOperationId: input.pendingOperationId,
        pendingDraft: input.pendingDraft,
        phase: 'planned',
        at: '2026-10-10T00:00:00.000Z',
        updatedAt: '2026-10-10T00:00:00.000Z',
      })
    },
    markRewinding: async (sessionId) => {
      const intent = h.state.intents.get(sessionId)!
      h.state.intents.set(sessionId, { ...intent, phase: 'rewinding' })
    },
    commit: async (input) => {
      h.state.commits += 1
      if (h.session) h.session.turns = h.session.turns.slice(0, input.keep)
      const result: StopEditResult = {
        sessionId: input.outcome.sessionId,
        clientRequestId: input.clientRequestId,
        preservedSessionId: input.outcome.preservedSessionId,
        branchTitle: input.outcome.review.title,
        moved: true,
        boundary: input.boundary,
        draft: input.outcome.draft,
        unrestored: [],
        removedTurns: 0,
        review: {
          ...input.outcome.review,
          feedback: { pendingDeliveries: 0, operationId: input.operationId },
        },
        version: 1,
      }
      const source = h.state.intents.get(input.outcome.preservedSessionId)!
      h.state.intents.set(input.outcome.sessionId, {
        ...source,
        sessionId: input.outcome.sessionId,
        phase: 'committed',
        result,
      })
      if (input.outcome.sessionId !== input.outcome.preservedSessionId)
        h.state.intents.set(input.outcome.preservedSessionId, {
          ...source,
          phase: 'committed',
          result,
          pendingDraft: '',
        })
      return result
    },
    markUncertain: async (sessionId, reason) => {
      const intent = h.state.intents.get(sessionId)!
      h.state.intents.set(sessionId, { ...intent, phase: 'uncertain', reason })
    },
    blocked: (sessionId) => {
      const intent = h.state.intents.get(sessionId)
      if (!intent) return undefined
      if (intent.phase === 'uncertain') return intent.reason
      if (intent.phase === 'rewinding')
        return '上一次停止后编辑在改动途中中断，请先核对会话历史后再发送'
      return undefined
    },
    acknowledgeDraft: async () => {},
  }
}

describe('幂等、请求身份与恢复', () => {
  it('同一个请求身份重复点击只回退一次', async () => {
    const h = harness()
    const request = { clientRequestId: 'r1', sessionId: 'session-1', boundaryId: 'dsh:1' }
    const first = await h.service.rewind(request)
    const second = await h.service.rewind(request)
    expect(first).toBe(second)
    expect(h.state.created).toHaveLength(1)
    expect(h.state.commits).toBe(1)
  })

  it('同一个请求身份换一条边界立即拒绝，不猜用户想改哪条', async () => {
    const h = harness()
    await h.service.rewind({ clientRequestId: 'r1', sessionId: 'session-1', boundaryId: 'dsh:1' })
    await expect(
      h.service.rewind({ clientRequestId: 'r1', sessionId: 'session-1', boundaryId: 'dsh:3' }),
    ).rejects.toMatchObject({ reason: 'request-conflict' })
  })

  it('另一次意图在上一条还在处理时被拒绝', async () => {
    const h = harness()
    let release = () => {}
    const service = new StopEditService({
      ...hostOf(h),
      runtime: () => ({
        ...h.runtime,
        rewind: async (request) => {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return h.native.rewind(request)
        },
      }),
    })
    const first = service.rewind({
      clientRequestId: 'r1',
      sessionId: 'session-1',
      boundaryId: 'dsh:1',
    })
    await Promise.resolve()
    expect(service.editing('session-1')).toBe(true)
    await expect(
      service.rewind({ clientRequestId: 'r2', sessionId: 'session-1', boundaryId: 'dsh:1' }),
    ).rejects.toMatchObject({ reason: 'in-flight' })
    release()
    await first
    expect(service.editing('session-1')).toBe(false)
  })

  it('会话在挑选期间被换掉后，旧选择立即作废', async () => {
    const h = harness()
    let addressed = 'session-1'
    const service = new StopEditService({ ...hostOf(h), addressedSession: () => addressed })
    addressed = 'session-1-other'
    await expect(
      service.rewind({ clientRequestId: 'r1', sessionId: 'session-1', boundaryId: 'dsh:1' }),
    ).rejects.toMatchObject({ reason: 'stale-history' })
    expect(h.state.forks).toEqual([])
  })

  it('不属于侧栏对话的会话没有入口', async () => {
    const h = harness()
    const state = await h.service.state({ sessionId: 'session-unknown' })
    expect(state.supported).toBe(false)
    expect(state.filesRestored).toBe(false)
  })

  it('首条消息空分支同样被复核，不留默认配置', async () => {
    const h = harness({ record: null })
    await h.service.rewind({ clientRequestId: 'r1', sessionId: 'session-1', boundaryId: 'dsh:1' })
    expect(h.state.created).toHaveLength(1)
    expect(h.state.rebinds[0]!.sessionId).toBe('session-1-empty1')
  })

  it('会话已关闭时明确拒绝，不假装还能回退', async () => {
    const h = harness()
    delete h.state.log['session-1']
    await expect(
      h.service.rewind({ clientRequestId: 'r1', sessionId: 'session-1', boundaryId: 'dsh:1' }),
    ).rejects.toMatchObject({ reason: 'not-bound' })
  })

  it('确认草稿后清除待填原文，重复确认幂等', async () => {
    const h = harness()
    const result = await h.service.rewind({
      clientRequestId: 'r1',
      sessionId: 'session-1',
      boundaryId: 'dsh:1',
    })
    // 草稿落在已提交的目标身份上：打开新分支才取得到原文。
    expect(result.moved).toBe(true)
    expect((await h.service.state({ sessionId: result.sessionId })).pendingDraft?.text).toBe(
      '第一条',
    )
    // 旧页面保留的是“这次已经做完”，绝不再带原文，避免把旧草稿填进仍在用的输入框。
    expect((await h.service.state({ sessionId: 'session-1' })).pendingDraft).toBeUndefined()
    expect((await h.service.state({ sessionId: 'session-1' })).editBranch).toEqual({
      sessionId: result.sessionId,
      title: result.branchTitle,
    })
    expect((await h.service.state({ sessionId: result.sessionId })).editBranch).toBeUndefined()
    expect(
      await h.service.acknowledge({
        sessionId: result.sessionId,
        clientRequestId: result.clientRequestId,
      }),
    ).toBe(true)
    expect((await h.service.state({ sessionId: result.sessionId })).pendingDraft).toBeUndefined()
    // 重复确认幂等，不报错也不改动别的身份。
    expect(
      await h.service.acknowledge({
        sessionId: result.sessionId,
        clientRequestId: result.clientRequestId,
      }),
    ).toBe(true)
  })
})

describe('投影尾部截断', () => {
  const before: StopEditTail = 'before'
  const after: StopEditTail = 'after'
  const unknown: StopEditTail = 'unknown'

  it('边界之后的轮次被移除，之前的一条原样保留', () => {
    const turns = [turn('op-1'), turn('op-2'), turn('op-3')]
    const classify = (target: HarnessTurn) => (target.operationId === 'op-3' ? after : before)
    expect(planProjectionCut(turns, classify)).toBe(2)
  })

  it('尾部之前存在位置不明的轮次时一条都不删', () => {
    const turns = [turn('op-0'), turn('op-1'), turn('op-2')]
    const classify = (target: HarnessTurn) =>
      target.operationId === 'op-0' ? unknown : target.operationId === 'op-1' ? after : after
    expect(planProjectionCut(turns, classify)).toBeUndefined()
  })

  it('尾部之后存在位置不明的轮次时整体拒绝', () => {
    const turns = [turn('op-1'), turn('op-2'), turn('op-3')]
    const classify = (target: HarnessTurn) =>
      target.operationId === 'op-1' ? after : target.operationId === 'op-2' ? unknown : unknown
    expect(planProjectionCut(turns, classify)).toBeUndefined()
  })

  it('没有任何可定位映射时保留整段历史', () => {
    expect(planProjectionCut([turn('op-1')], () => unknown)).toBe(1)
  })

  it('展示用的开头保持空白折叠并限长，不改写原文', () => {
    expect(contentHead('a\n\n  b   c ')).toBe('a b c')
    expect(contentHead('x'.repeat(200), 10)).toBe(`${'x'.repeat(10)}…`)
    expect(contentHead('   ')).toBe('')
  })

  it('StopEditError 保留机器可读原因', () => {
    expect(new StopEditError('missing-mapping', '缺少精确映射').reason).toBe('missing-mapping')
  })
})

/**
 * 跨进程的恢复分类。
 *
 * 每个用例都新建一个 `StopEditService`、复用同一份台账，等价于 Host 重启：内存里的在途
 * 表与已提交表都是空的，只有落盘的意图还在，因此返回什么完全由持久阶段决定。
 */
describe('重启后的恢复分类', () => {
  const seeded = (phase: StopEditIntent['phase'], extra: Partial<StopEditIntent> = {}) => {
    const h = harness({ record: null })
    h.state.intents.set('session-1', {
      sessionId: 'session-1',
      clientRequestId: 'r0',
      boundaryId: 'dsh:3',
      preservedSessionId: 'session-1',
      pendingOperationId: 'op-old',
      pendingDraft: '第二条',
      phase,
      at: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-10T00:00:00.000Z',
      ...extra,
    })
    return h
  }

  it('Runtime 已经改成功但提交失败：保留 uncertain，而不是谎称完成', async () => {
    const h = harness()
    h.state.failCommit = () => {
      throw Error('投影落盘失败：E:\\secret\\records\\session.json')
    }
    await expect(
      h.service.rewind({ clientRequestId: 'r1', sessionId: 'session-1', boundaryId: 'dsh:3' }),
    ).rejects.toMatchObject({ reason: 'rewind-failed' })
    // fork 已经真实发生，因此台账必须停在不确定：会话带着半个状态续发比失败更糟。
    expect(h.state.forks).toEqual([{ sessionId: 'session-1', atSeq: 2 }])
    const intent = h.state.intents.get('session-1')!
    expect(intent.phase).toBe('uncertain')
    expect(intent.reason).toBeTruthy()
    expect(intent.reason).not.toContain('secret')
    expect((await h.service.state({ sessionId: 'session-1' })).supported).toBe(false)
  })

  it('停在 rewinding 的会话重启后不被盲重放，必须先核对历史', async () => {
    const h = seeded('rewinding')
    const restarted = new StopEditService(hostOf(h))
    await expect(
      restarted.rewind({ clientRequestId: 'r9', sessionId: 'session-1', boundaryId: 'dsh:3' }),
    ).rejects.toMatchObject({ reason: 'uncertain' })
    expect(h.state.forks).toEqual([])
    expect((await restarted.state({ sessionId: 'session-1' })).supported).toBe(false)
  })

  it('停在 planned 的会话可以重新发起：Runtime 从未被调用过', async () => {
    const h = seeded('planned')
    const restarted = new StopEditService(hostOf(h))
    expect((await restarted.state({ sessionId: 'session-1' })).supported).toBe(true)
    const result = await restarted.rewind({
      clientRequestId: 'r0',
      sessionId: 'session-1',
      boundaryId: 'dsh:3',
    })
    expect(result.draft).toBe('第二条')
    expect(h.state.forks).toHaveLength(1)
  })

  it('回复丢失后同一身份返回持久结果，不会再回退一次', async () => {
    const h = harness()
    const request = { clientRequestId: 'r1', sessionId: 'session-1', boundaryId: 'dsh:3' }
    const first = await h.service.rewind(request)
    const restarted = new StopEditService(hostOf(h))
    const again = await restarted.rewind(request)
    expect(again).toEqual(first)
    expect(h.state.forks).toHaveLength(1)
    expect(h.state.commits).toBe(1)
  })

  it('中间消息的分支同样把原文落在新会话上，旧页面不误填', async () => {
    const h = harness()
    const result = await h.service.rewind({
      clientRequestId: 'r1',
      sessionId: 'session-1',
      boundaryId: 'dsh:3',
    })
    expect(result.draft).toBe('第二条')
    expect(result.moved).toBe(true)
    // 切点取所选消息紧邻之前的事件；记录随后绑定到新分支，原会话仍然可浏览。
    expect(h.state.forks).toEqual([{ sessionId: 'session-1', atSeq: 2 }])
    expect(h.session!.acpSessionId).toBe(result.sessionId)
    const branch = await h.service.state({ sessionId: result.sessionId })
    expect(branch.pendingDraft?.text).toBe('第二条')
    expect(branch.pendingDraft?.clientRequestId).toBe('r1')
    expect((await h.service.state({ sessionId: 'session-1' })).pendingDraft).toBeUndefined()
  })
})

/**
 * 入口状态的事实来源。
 *
 * 客户端不推断能力、也不细化 Host 没有报告过的进度，因此这里固定的是“Host 必须给出什么
 * 字段”：范围外的 Harness 一个字段都不给，范围内的 Harness 必须给出原因与阻断标志。
 */
describe('入口状态：等待、未就绪与阻断', () => {
  it('首批 Harness 还没有运行时给出未就绪原因，并保留 harness 让客户端能解释', async () => {
    const h = harness()
    h.session!.harnessRef = 'minimax-code'
    const service = new StopEditService({ ...hostOf(h), runtime: () => undefined })
    const state = await service.state({ sessionId: 'session-1' })
    expect(state.supported).toBe(false)
    expect(state.harness).toBe('minimax-code')
    expect(state.reason).toContain('尚未就绪')
    // 未就绪不是“可以点一下试试”：没有可回退边界，也没有未落定的编辑。
    expect(state.boundaries).toEqual([])
    expect(state.pending).toBe(false)
  })

  it('范围外的 Harness 一个字段都不设置，客户端因此完全不渲染', async () => {
    const h = harness()
    h.session!.harnessRef = 'codex'
    const service = new StopEditService({ ...hostOf(h), runtime: () => undefined })
    const state = await service.state({ sessionId: 'session-1' })
    expect(state.supported).toBe(false)
    expect(state.harness).toBeUndefined()
    expect(state.reason).toContain('尚未提供停止后编辑')
  })

  it('读取历史失败时保留 harness，并只给固定诊断', async () => {
    const h = harness()
    const service = new StopEditService({
      ...hostOf(h),
      runtime: () => ({
        ...h.runtime,
        boundaries: async () => {
          throw new Error('E:\secret\history.log')
        },
      }),
    })
    const state = await service.state({ sessionId: 'session-1' })
    expect(state.supported).toBe(false)
    expect(state.harness).toBe('dsh')
    expect(state.reason).toBe('无法读取会话历史，请稍后重试')
    expect(state.reason).not.toContain('secret')
  })

  it('结果不确定被阻断时给出原因与 pending，客户端据此只提供只读的重新读取', async () => {
    const h = harness()
    h.state.intents.set('session-1', {
      sessionId: 'session-1',
      clientRequestId: 'r0',
      boundaryId: 'dsh:1',
      preservedSessionId: 'session-1',
      pendingOperationId: 'op-0',
      pendingDraft: '',
      phase: 'uncertain',
      reason: 'Runtime 回退结果不确定，请先核对会话历史',
      at: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-10T00:00:00.000Z',
    })
    const state = await h.service.state({ sessionId: 'session-1' })
    expect(state.supported).toBe(false)
    expect(state.harness).toBe('dsh')
    expect(state.reason).toBe('Runtime 回退结果不确定，请先核对会话历史')
    expect(state.pending).toBe(true)
    expect(state.boundaries).toEqual([])
  })

  it('会话在读取期间被换掉时给出可读原因，而不是悄悄消失', async () => {
    const h = harness()
    const service = new StopEditService({ ...hostOf(h), addressedSession: () => 'session-other' })
    const state = await service.state({ sessionId: 'session-1' })
    expect(state.supported).toBe(false)
    expect(state.harness).toBe('dsh')
    expect(state.reason).toContain('会话已改变')
  })
})
