/**
 * 停止后编辑入口的纯逻辑：可见性、幂等身份、结果播报与跨会话结果隔离。
 *
 * 不渲染任何组件，只固定“允许显示什么”“同一意图只发一次”“结果怎么讲”“迟到结果能不能
 * 落地”四条规则。
 */
import { describe, expect, it, vi } from 'vitest'
import type {
  StopEditBoundary,
  StopEditResult,
  StopEditState,
} from '../../src/execution/contracts/stop-edit.ts'
import {
  describeOutcome,
  entryVisible,
  INITIAL_STOP_EDIT,
  mintClientRequestId,
  StopEditStateStore,
  unavailableReason,
  unrestoredNotice,
  recoveryReadVisible,
  waitingStatus,
  type StopEditView,
} from '../../src/execution/client/stop-edit.ts'

const boundary = (id: string, extra: Partial<StopEditBoundary> = {}): StopEditBoundary => ({
  id,
  contentHead: `内容-${id}`,
  attachmentCount: 0,
  first: false,
  ...extra,
})

const outcome = (extra: Partial<StopEditResult> = {}): StopEditResult => ({
  sessionId: 'session-1',
  clientRequestId: 'r1',
  preservedSessionId: 'session-1',
  branchTitle: '第一条 · 编辑分支',
  moved: true,
  boundary: boundary('u1'),
  draft: '原文',
  unrestored: [],
  removedTurns: 0,
  review: {
    model: 'deepseek-flash',
    effort: 'high',
    permissions: 'workspace-write',
    cwd: 'C:/work',
    workspaceId: 'ws-1',
    project: 'C:/work',
    feedback: { pendingDeliveries: 0, operationId: 'op-new' },
  },
  version: 1,
  ...extra,
})

const state = (extra: Partial<StopEditState> = {}): StopEditState => ({
  sessionId: 'session-1',
  harness: 'dsh',
  supported: true,
  busy: false,
  pending: false,
  boundaries: [boundary('u1'), boundary('u2')],
  filesRestored: false,
  version: 1,
  ...extra,
})

const view = (extra: Partial<StopEditView> = {}): StopEditView => ({
  ...INITIAL_STOP_EDIT,
  ...extra,
})

function store(overrides: Partial<Parameters<typeof makeStore>[0]> = {}) {
  return makeStore(overrides)
}

function makeStore(overrides: {
  load?: (sessionId: string) => Promise<StopEditState>
  run?: (request: {
    clientRequestId: string
    sessionId: string
    boundaryId: string
  }) => Promise<StopEditResult>
  acknowledge?: (request: {
    sessionId: string
    clientRequestId: string
  }) => Promise<{ acknowledged: boolean }>
  onError?: (message: string, sessionId: string) => void
}) {
  const acknowledged: string[] = []
  const errors: { message: string; sessionId: string }[] = []
  const instance = new StopEditStateStore({
    load: async (sessionId) => state({ sessionId }),
    run: async () => outcome(),
    acknowledge: async ({ clientRequestId }) => {
      acknowledged.push(clientRequestId)
      return { acknowledged: true }
    },
    onError: (message, sessionId) => errors.push({ message, sessionId }),
    ...overrides,
  } as never)
  return { instance, acknowledged, errors }
}

describe('入口可见性', () => {
  it('不在首批范围内的 Harness 不显示任何入口', () => {
    expect(entryVisible(view())).toBe(false)
    expect(entryVisible(view({ supported: false, reason: '该 Harness 尚未提供停止后编辑' }))).toBe(
      false,
    )
  })

  it('支持但没有任何可回退消息时不显示空入口', () => {
    expect(entryVisible(view({ supported: true, boundaries: [] }))).toBe(false)
  })

  it('有可选消息时入口可见', () => {
    expect(entryVisible(view({ supported: true, boundaries: [boundary('u1')] }))).toBe(true)
  })

  it('每次意图得到一个不同的身份，同一次重试复用它', () => {
    expect(mintClientRequestId()).not.toBe(mintClientRequestId())
  })
})

describe('等待与不可用状态', () => {
  it('首批 Harness 还没有可回退消息时给出准确状态，而不是无解释消失', () => {
    // 入口按钮本身仍然不出现：没有可选消息的空入口点了没有用。
    expect(entryVisible(view({ supported: true, boundaries: [] }))).toBe(false)
    // 但必须有一句与真实事实对应的话：空闲时说暂无消息，运行中说仍在运行。
    expect(waitingStatus(view({ supported: true, boundaries: [], busy: false }))).toContain(
      '暂无可编辑的消息',
    )
    expect(waitingStatus(view({ supported: true, boundaries: [], busy: true }))).toContain(
      '正在运行',
    )
    // 有可选消息、或根本不在首批范围内时不使用这套措辞。
    expect(waitingStatus(view({ supported: true, boundaries: [boundary('u1')] }))).toBeUndefined()
    expect(waitingStatus(view({ supported: false, boundaries: [] }))).toBeUndefined()
  })

  it('范围外的 Harness 不写任何解释，首批 Harness 未就绪时必须给出 Host 的原因', () => {
    // 没有 harness 字段就是“不在范围内”，客户端连一句话都不该写。
    expect(unavailableReason(view({ supported: false }))).toBeUndefined()
    expect(
      unavailableReason(
        view({ supported: false, harness: 'minimax-code', reason: '会话历史扩展未安装' }),
      ),
    ).toBe('会话历史扩展未安装')
    // 能力可用时不是“不可用”，不借用这套措辞。
    expect(unavailableReason(view({ supported: true, harness: 'dsh' }))).toBeUndefined()
  })

  it('只读的重新读取只在读取失败或编辑未落定时提供', () => {
    expect(recoveryReadVisible(view({ supported: true, harness: 'dsh' }))).toBe(false)
    // 未就绪的能力不是点一下就能变好的，不给按钮。
    expect(
      recoveryReadVisible(
        view({ supported: false, harness: 'minimax-code', reason: '未安装扩展' }),
      ),
    ).toBe(false)
    // 范围外的 Harness 完全不渲染，更不会有恢复入口。
    expect(recoveryReadVisible(view({ supported: false, pending: true }))).toBe(false)
    // 结果不确定（Host 报告 pending）时必须能重新核对持久状态。
    expect(
      recoveryReadVisible(
        view({ supported: false, harness: 'dsh', pending: true, reason: '结果不确定' }),
      ),
    ).toBe(true)
    // 读取失败同样是可安全重试的只读动作。
    expect(
      recoveryReadVisible(view({ phase: 'error', error: '无法读取会话历史，请稍后重试' })),
    ).toBe(true)
  })
})

describe('结果播报', () => {
  it('分支回退给出可读的分支标题，而不是让用户按 opaque id 去找', () => {
    const text = describeOutcome(outcome())
    expect(text).toContain('第一条 · 编辑分支')
    expect(text).toContain('原会话已保留')
    expect(text).toContain('磁盘上的文件保持原样')
  })

  it('原地回退说明原文已放回输入框，并逐项复核模型与权限', () => {
    const text = describeOutcome(outcome({ moved: false }))
    expect(text).toContain('原文已放回输入框')
    expect(text).toContain('模型 deepseek-flash')
    expect(text).toContain('权限 workspace-write')
  })

  it('输入框已有草稿时不声称已放回，而是说明原文没有覆盖也没有丢失', () => {
    const text = describeOutcome(outcome({ moved: false }), 'kept')
    expect(text).not.toContain('原文已放回输入框')
    expect(text).toContain('输入框里已有你的草稿')
    expect(text).toContain('仍保留为待填原文')
    expect(text).toContain('磁盘上的文件保持原样')
  })

  it('移除的轮次数量如实展示', () => {
    expect(describeOutcome(outcome({ removedTurns: 3 }))).toContain('已移除 3 轮对话记录')
  })

  it('无法恢复的内容逐条说明，既不谎称已放回也不静默丢弃', () => {
    expect(
      unrestoredNotice([{ name: 'shot.png', reason: '无法放回' }, { reason: '其他' }]),
    ).toContain('2 项内容无法自动放回输入框')
    expect(unrestoredNotice([])).toBe('')
  })
})

describe('状态所有者', () => {
  it('读取成功后收起入口，保留可选消息', async () => {
    const { instance } = store()
    await instance.load('session-1')
    const current = instance.getSnapshot()
    expect(current.supported).toBe(true)
    expect(current.phase).toBe('idle')
    expect(current.boundaries).toHaveLength(2)
  })

  it('不支持时不进入可选状态，入口保持隐藏', async () => {
    const { instance } = store({
      load: async () =>
        state({ supported: false, reason: '该 Harness 尚未提供停止后编辑', boundaries: [] }),
    })
    await instance.load('session-1')
    expect(entryVisible(instance.getSnapshot())).toBe(false)
  })

  it('恢复出来的待填草稿交给界面，宿主确认后清除', async () => {
    const { instance, acknowledged } = store({
      load: async () => state({ pendingDraft: { text: '恢复前原文', clientRequestId: 'r9' } }),
    })
    await instance.load('session-1')
    expect(instance.getSnapshot().pendingDraft?.text).toBe('恢复前原文')
    expect(await instance.acknowledge('session-1', 'r9')).toBe(true)
    expect(acknowledged).toEqual(['r9'])
  })

  it('公开响应 acknowledged:false 按未确认处理，给出固定诊断', async () => {
    const { instance, errors } = store({
      // 宿主正常回答，只是明确没有确认这条草稿；这不是异常，但同样不能当成成功。
      acknowledge: async () => ({ acknowledged: false }),
    })
    await instance.load('session-1')
    expect(await instance.acknowledge('session-1', 'r9')).toBe(false)
    expect(errors).toEqual([
      { message: '清除待填草稿失败，重启后可能再次出现该草稿', sessionId: 'session-1' },
    ])
  })

  it('确认抛错与响应缺字段同样按未确认处理，绝不宽松断言成成功', async () => {
    const thrown = store({
      acknowledge: async () => {
        throw new Error('remote: C:\\private\\stop-edit.json')
      },
    })
    await thrown.instance.load('session-1')
    expect(await thrown.instance.acknowledge('session-1', 'r9')).toBe(false)
    expect(thrown.errors).toHaveLength(1)
    expect(thrown.errors[0]!.message).not.toContain('private')
    expect(thrown.errors[0]!.message).not.toContain('C:\\')

    // 形状不对的响应同样不是成功：只有 acknowledged === true 才算确认。
    const malformed = store({ acknowledge: async () => ({}) as { acknowledged: boolean } })
    await malformed.instance.load('session-1')
    expect(await malformed.instance.acknowledge('session-1', 'r9')).toBe(false)
    expect(malformed.errors).toHaveLength(1)
  })

  it('晚到的旧会话确认失败不写进已经切换的会话', async () => {
    let fail: (error: Error) => void = () => {}
    const { instance, errors } = store({
      acknowledge: () => new Promise((_resolve, reject) => (fail = reject)),
    })
    await instance.load('session-1')
    const pending = instance.acknowledge('session-1', 'r9')
    // 用户已经切到别的会话：这次失败不再属于当前界面。
    await instance.load('session-2')
    fail(new Error('owned late failure'))
    expect(await pending).toBe(false)
    expect(errors).toEqual([])
  })

  it('卸载之后的确认失败与迟到结果都不再交付', async () => {
    let fail: (error: Error) => void = () => {}
    const { instance, errors } = store({
      acknowledge: () => new Promise((_resolve, reject) => (fail = reject)),
    })
    await instance.load('session-1')
    const pending = instance.acknowledge('session-1', 'r9')
    instance.detach()
    fail(new Error('owned late failure'))
    expect(await pending).toBe(false)
    expect(errors).toEqual([])

    let release: (value: StopEditResult) => void = () => {}
    const detached = store({
      run: async () =>
        new Promise<StopEditResult>((resolve) => {
          release = resolve
        }),
    })
    await detached.instance.load('session-1')
    const flight = detached.instance.choose('session-1', 'u1')
    detached.instance.detach()
    release(outcome({ moved: false }))
    // 组件已经关闭：结果不交给任何调用方，原文留在 Host 等下一次恢复。
    expect(await flight).toBeUndefined()
  })

  it('主审负例：状态刷新不解除在途互斥，也不丢掉重试身份', async () => {
    let release: (value: StopEditResult) => void = () => {}
    const run = vi.fn(
      async () =>
        new Promise<StopEditResult>((resolve) => {
          release = resolve
        }),
    )
    const { instance } = store({ run })
    await instance.load('session-1')
    const first = instance.choose('session-1', 'u1')
    await Promise.resolve()
    // 会话订阅本来就会触发一次刷新，刷新不得解锁第二次回退。
    await instance.load('session-1')
    expect(await instance.choose('session-1', 'u2')).toBeUndefined()
    expect(run).toHaveBeenCalledTimes(1)
    expect(instance.getSnapshot().inFlight?.clientRequestId).toBeTruthy()
    release(outcome())
    await first
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('失败之后重试同一条消息复用同一个身份，不会变成一次新的回退', async () => {
    const ids: string[] = []
    const { instance } = store({
      run: async (request) => {
        ids.push(request.clientRequestId)
        throw new Error('回复丢失')
      },
    })
    await instance.load('session-1')
    await instance.choose('session-1', 'u1')
    await instance.load('session-1')
    await instance.choose('session-1', 'u1')
    expect(ids[0]).toBe(ids[1])
    // 换一条消息就是新意图。
    await instance.choose('session-1', 'u2')
    expect(ids[2]).not.toBe(ids[1])
  })

  it('换一个意图就是新身份，不会拿旧身份覆盖别的消息', async () => {
    const run = vi.fn(async () => outcome())
    const { instance } = store({ run })
    await instance.load('session-1')
    await instance.choose('session-1', 'u1')
    await instance.choose('session-1', 'u2')
    expect(run.mock.calls[0]![0]!.clientRequestId).not.toBe(run.mock.calls[1]![0]!.clientRequestId)
  })

  it('失败时给出固定诊断，不把底层异常文本反射到界面', async () => {
    const { instance } = store({
      run: async () => {
        throw new Error('C:\\Users\\root\\.mcode\\runtime.log ENOENT token=abc')
      },
    })
    await instance.load('session-1')
    expect(await instance.choose('session-1', 'u1')).toBeUndefined()
    expect(instance.getSnapshot().phase).toBe('error')
    expect(instance.getSnapshot().error).not.toContain('C:\\')
    expect(instance.getSnapshot().error).not.toContain('abc')
    expect(instance.getSnapshot().result).toBeUndefined()
  })

  it('读取失败同样只给固定诊断', async () => {
    const { instance } = store({
      load: async () => {
        throw new Error('remote: /home/root/private/cookie')
      },
    })
    await instance.load('session-1')
    expect(instance.getSnapshot().error).not.toContain('private')
  })

  it('读取失败会清空可回退边界，不会用一份可能过期的历史继续回退', async () => {
    const { instance } = store({
      load: async () => {
        throw new Error('remote: /home/root/private/cookie')
      },
    })
    await instance.load('session-1')
    const snapshot = instance.getSnapshot()
    expect(snapshot.supported).toBe(false)
    expect(snapshot.boundaries).toEqual([])
    expect(snapshot.error).toBe('无法读取会话历史，请稍后重试')
  })

  it('回退失败后先按持久状态重读，再给出固定诊断与阻断原因', async () => {
    let loads = 0
    const { instance } = store({
      load: async (sessionId) => {
        loads += 1
        return state({
          sessionId,
          supported: false,
          boundaries: [],
          harness: 'dsh',
          reason: '上一次停止后编辑在改动途中中断，请先核对会话历史后再发送',
        })
      },
      run: async () => {
        throw new Error('reply lost: C:\\Users\\root\\.mcode\\runtime.log')
      },
    })
    await instance.load('session-1')
    expect(loads).toBe(1)
    await instance.choose('session-1', 'u1')
    // 失败之后必须重新读取 Host 持久状态，而不是凭本地猜测继续。
    expect(loads).toBe(2)
    const snapshot = instance.getSnapshot()
    expect(snapshot.phase).toBe('error')
    expect(snapshot.error).toBe('回退未完成，请核对会话历史后再试')
    expect(snapshot.error).not.toContain('runtime.log')
    // Host 报告的阻断原因原样保留；边界被清空，不可能再点一次回退。
    expect(snapshot.reason).toContain('改动途中中断')
    expect(snapshot.supported).toBe(false)
    expect(snapshot.boundaries).toEqual([])
    expect(snapshot.result).toBeUndefined()
  })

  it('重新读取是唯一恢复动作：读取成功后回到 Host 的真实状态', async () => {
    let blocked = true
    const { instance } = store({
      load: async (sessionId) =>
        state({
          sessionId,
          supported: !blocked,
          boundaries: blocked ? [] : [boundary('u1')],
          harness: 'dsh',
          ...(blocked ? { reason: '结果不确定，请先核对会话历史' } : {}),
        }),
      run: async () => {
        throw new Error('uncertain')
      },
    })
    await instance.load('session-1')
    await instance.choose('session-1', 'u1')
    expect(instance.getSnapshot().supported).toBe(false)
    // 核对真实历史之后，Host 重新给出可回退边界；这一步只是读取，不重发回退。
    blocked = false
    await instance.load('session-1')
    expect(instance.getSnapshot().supported).toBe(true)
    expect(instance.getSnapshot().boundaries.map((item) => item.id)).toEqual(['u1'])
  })

  it('在途措辞只跟随 Host 报告的 busy，不自己编一个更细的阶段', async () => {
    const gates: ((value: StopEditResult) => void)[] = []
    const run = vi.fn(
      async () =>
        new Promise<StopEditResult>((resolve) => {
          gates.push(resolve)
        }),
    )
    const busyStore = store({ load: async (sessionId) => state({ sessionId, busy: true }), run })
    await busyStore.instance.load('session-1')
    const first = busyStore.instance.choose('session-1', 'u1')
    await Promise.resolve()
    // Host 说还有轮次在跑：这次请求会先停止并等静止。
    expect(busyStore.instance.getSnapshot().phase).toBe('stopping')
    gates[0]!(outcome())
    await first

    const idleStore = store({ load: async (sessionId) => state({ sessionId, busy: false }), run })
    await idleStore.instance.load('session-1')
    const second = idleStore.instance.choose('session-1', 'u1')
    await Promise.resolve()
    // Host 说没有轮次在跑：不说“正在停止”。
    expect(idleStore.instance.getSnapshot().phase).toBe('rewinding')
    gates[1]!(outcome())
    await second
  })

  it('请求飞行中不接受第二个意图', async () => {
    let release = () => {}
    const run = vi.fn(
      async () =>
        new Promise<StopEditResult>((resolve) => {
          release = () => resolve(outcome())
        }),
    )
    const { instance } = store({ run })
    await instance.load('session-1')
    const first = instance.choose('session-1', 'u1')
    await Promise.resolve()
    expect(await instance.choose('session-1', 'u2')).toBeUndefined()
    release()
    await first
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('主审负例：换了会话之后才到期的结果绝不写进新会话的状态', async () => {
    let resolveRun: (value: StopEditResult) => void = () => {}
    const running = new Promise<StopEditResult>((resolve) => {
      resolveRun = resolve
    })
    const { instance } = store({
      load: async (sessionId) => state({ boundaries: [], sessionId }),
      run: async () => running,
    })
    await instance.load('old')
    const pending = instance.choose('old', 'u1')
    await instance.load('new')
    resolveRun(outcome({ sessionId: 'old', draft: 'OLD SESSION DRAFT' }))
    await pending
    // 旧请求的结果只交给调用方判断，状态里不留任何痕迹。
    expect(instance.getSnapshot().sessionId).toBe('new')
    expect(instance.getSnapshot().result).toBeUndefined()
    expect(instance.getSnapshot().pendingDraft).toBeUndefined()
  })

  it('同一会话的并发读取只认最后一次，先到的旧响应不覆盖新边界', async () => {
    const gates: ((state: StopEditState) => void)[] = []
    const { instance } = store({
      load: (sessionId) =>
        new Promise<StopEditState>((resolve) => {
          gates.push((value) => resolve({ ...value, sessionId }))
        }),
    })
    const first = instance.load('session-1')
    const second = instance.load('session-1')
    // 先发起的读取更晚才回来。
    gates[1]!(state({ boundaries: [boundary('new')] }))
    await second
    gates[0]!(state({ boundaries: [boundary('old')] }))
    await first
    expect(instance.getSnapshot().boundaries.map((item) => item.id)).toEqual(['new'])
  })
})
