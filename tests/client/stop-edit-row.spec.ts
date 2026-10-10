import './dom.ts'
import { createTestDom } from './dom.ts'
import { afterEach, expect, it, vi } from 'vitest'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { StopEditControl } from '../../src/execution/client/StopEditControl.tsx'
import type {
  StopEditBoundary,
  StopEditResult,
  StopEditState,
} from '../../src/execution/contracts/stop-edit.ts'

type ShimNode = {
  nodeType: number
  childNodes?: ShimNode[]
  parentNode?: ShimNode | null
  nodeName?: string
  textContent?: string | null
  click?(): boolean
}

/** Give the shim a real bubbling `click`, so React's delegated listener runs the handler. */
function enableClick(dom: { document: { createElement(name: string): object } }) {
  const proto = Object.getPrototypeOf(dom.document.createElement('div')) as Record<string, unknown>
  const listeners = new WeakMap<object, Map<string, Set<(event: unknown) => void>>>()
  proto['addEventListener'] = function (type: string, listener: (event: unknown) => void) {
    let byType = listeners.get(this as object)
    if (!byType) listeners.set(this as object, (byType = new Map()))
    const set = byType.get(type) ?? new Set()
    set.add(listener)
    byType.set(type, set)
  }
  proto['removeEventListener'] = function (type: string, listener: (event: unknown) => void) {
    listeners
      .get(this as object)
      ?.get(type)
      ?.delete(listener)
  }
  const dispatch = (type: string, target: object) => {
    const event = { type, target, bubbles: true, cancelable: true }
    let node = target as { parentNode?: ShimNode | null } | null
    while (node) {
      for (const listener of listeners.get(node)?.get(type) ?? []) listener(event)
      node = node.parentNode
    }
    return true
  }
  proto['dispatchEvent'] = function (type: string) {
    return dispatch(type, this)
  }
  proto['click'] = function () {
    return dispatch('click', this)
  }
}

const dom = createTestDom()
enableClick(dom)
let root: ReturnType<typeof createRoot>
afterEach(async () => {
  await React.act(async () => root?.unmount())
})

function walk(node: ShimNode, visit: (node: ShimNode) => void) {
  visit(node)
  for (const child of node.childNodes ?? []) walk(child, visit)
}
const buttonsOf = (scope: ShimNode) => {
  const found: ShimNode[] = []
  walk(scope, (node) => {
    if (node.nodeName === 'BUTTON') found.push(node)
  })
  return found
}

const boundary = (id: string, extra: Partial<StopEditBoundary> = {}): StopEditBoundary => ({
  id,
  contentHead: `内容-${id}`,
  attachmentCount: 0,
  first: false,
  ...extra,
})

const state = (overrides: Partial<StopEditState> = {}): StopEditState => ({
  sessionId: 'session-1',
  harness: 'dsh',
  supported: true,
  busy: false,
  pending: false,
  boundaries: [
    boundary('u1', { contentHead: '第一条消息', first: true }),
    boundary('u2', { contentHead: '第二条消息' }),
  ],
  filesRestored: false,
  version: 1,
  ...overrides,
})

/** 范围外的 Harness：Host 连 `harness` 字段都不设置，客户端因此没有任何解释可写。 */
const outOfScope = (overrides: Partial<StopEditState> = {}): StopEditState =>
  ({ ...state(overrides), harness: undefined }) as StopEditState

const outcome = (overrides: Partial<StopEditResult> = {}): StopEditResult =>
  ({
    sessionId: 'session-1',
    clientRequestId: 'r1',
    preservedSessionId: 'session-1',
    branchTitle: '第二条消息 · 编辑分支',
    moved: true,
    boundary: boundary('u2', { contentHead: '第二条消息' }),
    draft: '第二条原文',
    unrestored: [],
    removedTurns: 1,
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
    ...overrides,
  }) as StopEditResult

async function render(options: {
  answer?: Partial<StopEditState>
  rewound?: StopEditResult
  fail?: string
  draftText?: string
  /** 让确认草稿失败；用于验证失败不会被空函数吞掉。 */
  ackFail?: string
  /** 这次会话所属的 Harness 不在首批范围内。 */
  outsideScope?: boolean
}) {
  const drafts: string[] = []
  const openSession = vi.fn()
  const run = vi.fn(async () => {
    if (options.fail) throw new Error(options.fail)
    return options.rewound ?? outcome()
  })
  const answer = () => (options.outsideScope ? outOfScope(options.answer) : state(options.answer))
  const call = vi.fn(async (method: string) => {
    if (method === 'stop-edit-state') return answer()
    if (method === 'stop-edit') return run()
    if (method === 'stop-edit-acknowledge' && options.ackFail) throw new Error(options.ackFail)
    return { acknowledged: true }
  }) as unknown as (method: string, request?: unknown) => Promise<unknown>
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  root = createRoot(container as unknown as HTMLElement)
  await React.act(async () =>
    root.render(
      React.createElement(StopEditControl, {
        sessionId: 'session-1',
        inputActions: { setDraft: (text: string) => drafts.push(text) },
        useInput: ((selector: (value: { draft: string }) => unknown) =>
          selector({ draft: options.draftText ?? '' })) as never,
        subscribeSession: () => () => {},
        openSession,
        call,
      } as never),
    ),
  )
  await React.act(async () => {})
  return { container: container as unknown as ShimNode, drafts, call, run, openSession }
}

it('范围外的 Harness 不渲染任何入口，也不写任何解释', async () => {
  const { container } = await render({
    outsideScope: true,
    answer: { supported: false, reason: '该 Harness 尚未提供停止后编辑', boundaries: [] },
  })
  expect(container.textContent).toBe('')
  expect(buttonsOf(container)).toHaveLength(0)
})

it('首批 Harness 能力未就绪时给出 Host 的原因，而不是无解释消失', async () => {
  const reason = '当前 MiniMax Runtime 未安装会话历史扩展，已拒绝开放停止后编辑'
  const { container, run } = await render({
    outsideScope: false,
    answer: { harness: 'minimax-code', supported: false, boundaries: [], reason },
  })
  expect(container.textContent).toContain(reason)
  // 未就绪不是“可以点一下试试”：没有任何按钮，也不会发出回退请求。
  expect(buttonsOf(container)).toHaveLength(0)
  expect(run).not.toHaveBeenCalled()
})

it('支持的首批 Harness 首轮没有消息时显示暂无消息状态，而不是无解释消失', async () => {
  const { container, run } = await render({
    answer: { supported: true, boundaries: [] },
  })
  expect(container.textContent).toContain('暂无可编辑的消息')
  // 还没有可回退消息，就没有空入口可点，也不会自动发出任何请求。
  expect(buttonsOf(container)).toHaveLength(0)
  expect(run).not.toHaveBeenCalled()
})

it('支持的首批 Harness 仍在运行时按 Host 的 busy 说清楚，而不是伪造停止进度', async () => {
  const { container, run } = await render({
    answer: { supported: true, boundaries: [], busy: true },
  })
  expect(container.textContent).toContain('正在运行')
  expect(container.textContent).not.toContain('正在回退')
  expect(container.textContent).not.toContain('暂无')
  expect(run).not.toHaveBeenCalled()
})

it('入口展开后列出已发送的消息，并标明首条与附件不可编辑', async () => {
  const { container } = await render({
    answer: {
      boundaries: [
        boundary('u1', { contentHead: '第一条消息', first: true }),
        boundary('u2', { contentHead: '第二条消息', attachmentCount: 2 }),
      ],
    },
  })
  await React.act(async () => buttonsOf(container)[0]!.click!())
  const text = container.textContent ?? ''
  expect(text).toContain('第一条消息')
  expect(text).toContain('首条消息')
  expect(text).toContain('2 个附件（无法还原，不能编辑）')
  expect(text).toContain('磁盘上的文件保持原样')
})

it('没有精确映射的消息被禁用，并把原因显示出来', async () => {
  const { container } = await render({
    answer: {
      boundaries: [
        boundary('u1', {
          contentHead: '旧消息',
          blocked: true,
          blockedReason: '这条消息缺少精确映射',
        }),
      ],
    },
  })
  await React.act(async () => buttonsOf(container)[0]!.click!())
  expect(container.textContent).toContain('这条消息缺少精确映射')
  const rows = buttonsOf(container).slice(1)
  await React.act(async () => rows[0]!.click!())
  expect(container.textContent).toContain('这条消息缺少精确映射')
})

it('分支回退不直接改写输入框，而是给出可读的分支标题', async () => {
  const { container, drafts, run, openSession } = await render({
    rewound: outcome({ sessionId: 'empty-branch' }),
  })
  await React.act(async () => buttonsOf(container)[0]!.click!())
  await React.act(async () => buttonsOf(container)[1]!.click!())
  expect(run).toHaveBeenCalledTimes(1)
  expect(drafts).toEqual([])
  const text = container.textContent ?? ''
  expect(text).toContain('第二条消息 · 编辑分支')
  expect(text).toContain('原会话已保留')
  expect(openSession).not.toHaveBeenCalled()
  await React.act(async () =>
    buttonsOf(container).find((button) => button.textContent === '打开编辑分支')!.click!(),
  )
  expect(openSession).toHaveBeenCalledExactlyOnceWith('empty-branch')
  expect(run).toHaveBeenCalledTimes(1)
  expect(drafts).toEqual([])
})

it('原会话重载后仍能通过持久入口打开空分支，不调用回退或发送', async () => {
  const { container, run, openSession, drafts } = await render({
    answer: {
      supported: false,
      boundaries: [],
      editBranch: { sessionId: 'blank-branch', title: '首条 · 编辑分支' },
    },
  })
  expect(buttonsOf(container)).toHaveLength(1)
  await React.act(async () => buttonsOf(container)[0]!.click!())
  expect(openSession).toHaveBeenCalledExactlyOnceWith('blank-branch')
  expect(run).not.toHaveBeenCalled()
  expect(drafts).toEqual([])
})

it('原地回退才把原文放回官方输入框', async () => {
  const { container, drafts } = await render({
    rewound: outcome({ moved: false, sessionId: 'session-1', preservedSessionId: 'session-1' }),
  })
  await React.act(async () => buttonsOf(container)[0]!.click!())
  await React.act(async () => buttonsOf(container)[1]!.click!())
  expect(drafts).toEqual(['第二条原文'])
  expect(container.textContent).toContain('原文已放回输入框')
})

it('输入框里已经有内容时不覆盖用户自己的草稿', async () => {
  const { container, drafts } = await render({
    answer: { pendingDraft: { text: '恢复前的原文', clientRequestId: 'r9' } },
    draftText: '我正在写的东西',
  })
  // 入口照常显示，但恢复出来的旧草稿不能盖掉用户正在写的内容。
  expect(drafts).toEqual([])
  expect(container.textContent).toContain('编辑消息')
})

it('恢复出来的待填草稿只在输入框为空时落进去', async () => {
  const { drafts } = await render({
    answer: { pendingDraft: { text: '恢复前的原文', clientRequestId: 'r9' } },
  })
  expect(drafts).toEqual(['恢复前的原文'])
})

it('回退失败时只显示固定诊断，不改动输入框，也不泄漏底层路径', async () => {
  const { container, drafts } = await render({
    fail: 'C:\\Users\\root\\.mcode\\runtime.log ENOENT token=abc',
  })
  await React.act(async () => buttonsOf(container)[0]!.click!())
  await React.act(async () => buttonsOf(container)[1]!.click!())
  const text = container.textContent ?? ''
  expect(text).toContain('回退未完成')
  expect(text).not.toContain('C:\\')
  expect(text).not.toContain('abc')
  expect(drafts).toEqual([])
})

it('回退成功后立即按新会话刷新边界，不等下一次挂载', async () => {
  const { container, call } = await render({})
  await React.act(async () => buttonsOf(container)[0]!.click!())
  const before = call.mock ? 0 : 0
  await React.act(async () => buttonsOf(container)[1]!.click!())
  const stateCalls = (call as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
    (entry) => entry[0] === 'stop-edit-state',
  )
  expect(stateCalls.length).toBeGreaterThan(before + 1)
})

it('会话控制流推送后入口会重新读取，新会话首轮之后按钮不再是旧的', async () => {
  const drafts: string[] = []
  let first = state({ boundaries: [] })
  let push: (() => void) | undefined
  const call = vi.fn(async (method: string) => {
    if (method === 'stop-edit-state') return { ...first, sessionId: 'session-1' }
    return { acknowledged: true }
  }) as unknown as (method: string, request?: unknown) => Promise<unknown>
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  root = createRoot(container as unknown as HTMLElement)
  await React.act(async () =>
    root.render(
      React.createElement(StopEditControl, {
        sessionId: 'session-1',
        inputActions: { setDraft: (text: string) => drafts.push(text) },
        useInput: ((selector: (value: { draft: string }) => unknown) =>
          selector({ draft: '' })) as never,
        subscribeSession: (_id: string, listener: () => void) => {
          push = listener
          return () => {}
        },
        call,
      } as never),
    ),
  )
  await React.act(async () => {})
  // 首轮之前没有可回退消息：入口按钮不出现，但状态必须说明为什么。
  expect(container.textContent).toContain('暂无可编辑的消息')
  expect(buttonsOf(container as unknown as ShimNode)).toHaveLength(0)
  first = state({
    boundaries: [boundary('u1', { contentHead: '首轮之后的消息' })],
  })
  await React.act(async () => push?.())
  await React.act(async () => {})
  expect(container.textContent).toContain('编辑消息')
  expect(container.textContent).not.toContain('暂无可编辑的消息')
  await React.act(async () => buttonsOf(container as unknown as ShimNode)[0]!.click!())
  expect(container.textContent).toContain('首轮之后的消息')
})

/** 一个由测试掌握节奏的 RPC：只有 resolve 之后 Host 才会回答。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

interface MountProps {
  sessionId: string
  draftText?: string
  call: (method: string, request?: unknown) => Promise<unknown>
  onDraft?: (text: string) => void
  subscribeSession?: (sessionId: string, listener: () => void) => () => void
  openSession?: (sessionId: string) => void
}

/** 真实挂载一次，之后可以带着新属性反复重渲染同一个 root。 */
async function mount(initial: MountProps) {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  root = createRoot(container as unknown as HTMLElement)
  const render = async (next: Partial<MountProps> = {}) => {
    const merged = { ...initial, ...next }
    await React.act(async () =>
      root.render(
        React.createElement(StopEditControl, {
          sessionId: merged.sessionId,
          inputActions: { setDraft: (text: string) => merged.onDraft?.(text) },
          useInput: ((selector: (value: { draft: string }) => unknown) =>
            selector({ draft: merged.draftText ?? '' })) as never,
          subscribeSession: merged.subscribeSession,
          openSession: merged.openSession ?? (() => {}),
          call: merged.call as never,
        } as never),
      ),
    )
  }
  await render()
  await React.act(async () => {})
  return { container: container as unknown as ShimNode, render }
}

const callCount = (call: unknown, method: string) =>
  (call as { mock: { calls: unknown[][] } }).mock.calls.filter((entry) => entry[0] === method)
    .length

it('MiniMax 回退后原会话入口消失，编辑分支提示与原因仍保留', async () => {
  let moved = false
  const call = vi.fn(async (method: string) => {
    if (method === 'stop-edit-state')
      // 真实 Host 在原会话上留下的是“这是编辑前保留的会话”这条阻断原因。
      return state(
        moved
          ? {
              supported: false,
              boundaries: [],
              reason: '这是编辑前保留的会话，请打开编辑分支后继续',
            }
          : {},
      )
    if (method === 'stop-edit') {
      moved = true
      return outcome({ moved: true, branchTitle: '测试 · 编辑分支' })
    }
    return { acknowledged: true }
  })
  const { container } = await mount({ sessionId: 'session-1', call })
  await React.act(async () => buttonsOf(container)[0]!.click!())
  await React.act(async () => buttonsOf(container)[1]!.click!())
  await React.act(async () => {})
  expect(container.textContent).toContain('测试 · 编辑分支')
  // 入口消失要有解释，而不是无解释地空掉。
  expect(container.textContent).toContain('这是编辑前保留的会话')
  expect(buttonsOf(container).map((button) => button.textContent)).toEqual(['打开编辑分支'])
})

it('等待回退期间输入框里打的字不会被旧原文盖掉', async () => {
  const drafts: string[] = []
  const gate = deferred<StopEditResult>()
  const call = vi.fn(async (method: string) => {
    if (method === 'stop-edit-state') return state()
    if (method === 'stop-edit') return gate.promise
    return { acknowledged: true }
  })
  const { container, render } = await mount({
    sessionId: 'session-1',
    call,
    onDraft: (text) => drafts.push(text),
  })
  await React.act(async () => buttonsOf(container)[0]!.click!())
  await React.act(async () => buttonsOf(container)[1]!.click!())
  expect(callCount(call, 'stop-edit')).toBe(1)
  // 请求还在飞：用户继续在输入框里写东西。
  await render({ draftText: '用户正在写的内容' })
  await React.act(async () => {
    gate.resolve(outcome({ moved: false, sessionId: 'session-1', preservedSessionId: 'session-1' }))
    await gate.promise
  })
  await React.act(async () => {})
  expect(drafts).toEqual([])
})

it('等待回退期间切到别的会话，旧结果不会写进新会话的输入框', async () => {
  const drafts: string[] = []
  const gate = deferred<StopEditResult>()
  const call = vi.fn(async (method: string, request?: unknown) => {
    if (method === 'stop-edit-state')
      return state({ sessionId: (request as { sessionId: string }).sessionId })
    if (method === 'stop-edit') return gate.promise
    return { acknowledged: true }
  })
  const { container, render } = await mount({
    sessionId: 'session-1',
    call,
    onDraft: (text) => drafts.push(text),
  })
  await React.act(async () => buttonsOf(container)[0]!.click!())
  await React.act(async () => buttonsOf(container)[1]!.click!())
  expect(callCount(call, 'stop-edit')).toBe(1)
  // React 换会话：新的 store 挂载，旧 store 的回调仍在飞行。
  await render({ sessionId: 'session-2' })
  await React.act(async () => {
    gate.resolve(outcome({ moved: false, sessionId: 'session-1', preservedSessionId: 'session-1' }))
    await gate.promise
  })
  await React.act(async () => {})
  expect(drafts).toEqual([])
  expect(callCount(call, 'stop-edit')).toBe(1)
})

it('回退在途时收到会话推送，入口不会重新变成可点，也不会发出第二次回退', async () => {
  let push: (() => void) | undefined
  const gate = deferred<StopEditResult>()
  const call = vi.fn(async (method: string) => {
    if (method === 'stop-edit-state') return state()
    if (method === 'stop-edit') return gate.promise
    return { acknowledged: true }
  })
  const { container } = await mount({
    sessionId: 'session-1',
    call,
    subscribeSession: (_id, listener) => {
      push = listener
      return () => {}
    },
  })
  await React.act(async () => buttonsOf(container)[0]!.click!())
  await React.act(async () => buttonsOf(container)[1]!.click!())
  expect(callCount(call, 'stop-edit')).toBe(1)
  // 会话控制流推送会触发一次读取；读取完成之后入口仍然必须保持锁定。
  await React.act(async () => push?.())
  await React.act(async () => {})
  expect(callCount(call, 'stop-edit')).toBe(1)
  const trigger = buttonsOf(container)[0]! as ShimNode & {
    getAttribute(name: string): string | null
  }
  expect(trigger.getAttribute('disabled')).toBe('')
  expect(trigger.getAttribute('aria-busy')).toBe('true')
  await React.act(async () => {
    gate.resolve(outcome())
    await gate.promise
  })
  await React.act(async () => {})
  expect(callCount(call, 'stop-edit')).toBe(1)
})

it('同一条消息被重复点击只发出一次回退', async () => {
  const gate = deferred<StopEditResult>()
  const call = vi.fn(async (method: string) => {
    if (method === 'stop-edit-state') return state()
    if (method === 'stop-edit') return gate.promise
    return { acknowledged: true }
  })
  const { container } = await mount({ sessionId: 'session-1', call })
  await React.act(async () => buttonsOf(container)[0]!.click!())
  const row = buttonsOf(container)[1]!
  await React.act(async () => {
    row.click!()
    row.click!()
    row.click!()
  })
  await React.act(async () => {})
  expect(callCount(call, 'stop-edit')).toBe(1)
  await React.act(async () => {
    gate.resolve(outcome())
    await gate.promise
  })
  await React.act(async () => {})
  expect(callCount(call, 'stop-edit')).toBe(1)
})

it('缺精确映射或带附件的边界在点击之前就被禁用，并把原因显示出来', async () => {
  const { container, run } = await render({
    answer: {
      boundaries: [
        boundary('u1', {
          contentHead: '旧消息',
          blocked: true,
          blockedReason: '这条消息缺少精确映射',
        }),
        boundary('u2', {
          contentHead: '带附件',
          attachmentCount: 1,
          blocked: true,
          blockedReason: '这条消息带有无法回填的附件，不能编辑',
        }),
      ],
    },
  })
  await React.act(async () => buttonsOf(container)[0]!.click!())
  const text = container.textContent ?? ''
  expect(text).toContain('这条消息缺少精确映射')
  expect(text).toContain('这条消息带有无法回填的附件，不能编辑')
  const rows = buttonsOf(container).slice(1)
  expect(rows).toHaveLength(2)
  const disabled = (node: ShimNode) =>
    (node as ShimNode & { getAttribute(name: string): string | null }).getAttribute('disabled')
  expect(disabled(rows[0]!)).toBe('')
  expect(disabled(rows[1]!)).toBe('')
  // 点不动：禁用的边界不会发出回退请求。
  await React.act(async () => {
    rows[0]!.click!()
    rows[1]!.click!()
  })
  expect(run).not.toHaveBeenCalled()
})

it('输入框已有草稿时保留双方：不覆盖也不丢原文，清空后才填回', async () => {
  const drafts: string[] = []
  const acknowledged: string[] = []
  const call = vi.fn(async (method: string, request?: unknown) => {
    if (method === 'stop-edit-state')
      return state({ pendingDraft: { text: '恢复前的原文', clientRequestId: 'r9' } })
    if (method === 'stop-edit-acknowledge') {
      acknowledged.push((request as { clientRequestId: string }).clientRequestId)
      return { acknowledged: true }
    }
    return { acknowledged: true }
  })
  const { container, render: rerender } = await mount({
    sessionId: 'session-1',
    call,
    draftText: '我正在写的内容',
    onDraft: (text) => drafts.push(text),
  })
  // 用户正在写的东西一个字都不能被动。
  expect(drafts).toEqual([])
  const text = container.textContent ?? ''
  expect(text).toContain('待填原文')
  expect(text).toContain('恢复前的原文')
  expect(text).toContain('输入框里已有你的草稿')
  const refill = buttonsOf(container).find((button) => button.textContent === '填回输入框')!
  expect(
    (refill as ShimNode & { getAttribute(name: string): string | null }).getAttribute('disabled'),
  ).toBe('')
  await React.act(async () => refill.click!())
  expect(drafts).toEqual([])
  expect(acknowledged).toEqual([])
  // 清空输入框之后才把原文填回，并且这一次才确认草稿已经落地。
  await rerender({ draftText: '' })
  expect(drafts).toEqual(['恢复前的原文'])
  expect(acknowledged).toEqual(['r9'])
})

it('清除待填草稿失败时如实提示，不静默吞掉，也不泄漏底层信息', async () => {
  const drafts: string[] = []
  const call = vi.fn(async (method: string) => {
    if (method === 'stop-edit-state')
      return state({ pendingDraft: { text: '恢复前的原文', clientRequestId: 'r9' } })
    if (method === 'stop-edit-acknowledge')
      throw new Error('remote: C:\Users\root\private\stop-edit.json')
    return { acknowledged: true }
  })
  const { container } = await mount({
    sessionId: 'session-1',
    call,
    onDraft: (text) => drafts.push(text),
  })
  await React.act(async () => {})
  await React.act(async () => {})
  expect(drafts).toEqual(['恢复前的原文'])
  const text = container.textContent ?? ''
  expect(text).toContain('清除待填草稿失败')
  expect(text).not.toContain('private')
  expect(text).not.toContain('C:\\')
})

it('回退失败后先重读 Host 持久状态：只给阻断原因与只读恢复，不重发回退', async () => {
  let blocked: string | undefined
  const call = vi.fn(async (method: string) => {
    if (method === 'stop-edit-state')
      return blocked === undefined
        ? state()
        : state({ supported: false, boundaries: [], pending: true, reason: blocked })
    if (method === 'stop-edit') {
      blocked = '结果不确定，请先核对真实历史'
      throw new Error('reply lost: E:\secret\runtime.log')
    }
    return { acknowledged: true }
  })
  const { container } = await mount({ sessionId: 'session-1', call })
  await React.act(async () => buttonsOf(container)[0]!.click!())
  await React.act(async () => buttonsOf(container)[1]!.click!())
  await React.act(async () => {})
  expect(callCount(call, 'stop-edit')).toBe(1)
  const text = container.textContent ?? ''
  expect(text).toContain('回退未完成')
  expect(text).toContain('结果不确定')
  expect(text).not.toContain('reply lost')
  expect(text).not.toContain('secret')
  // 不确定的回退绝不能被说成“没有发生过”。
  expect(text).not.toContain('会话没有被改动')
  // 入口收起，剩下的唯一动作是只读的重新读取。
  expect(buttonsOf(container).map((button) => button.textContent)).toEqual(['重新读取会话历史'])
  // 仍然被阻断时再读一次：依然不会重发回退，原因照旧显示。
  await React.act(async () => buttonsOf(container)[0]!.click!())
  await React.act(async () => {})
  expect(callCount(call, 'stop-edit')).toBe(1)
  expect(container.textContent).toContain('结果不确定')
  // 核对真实历史之后，重新读取才拿回可回退入口；整个过程没有第二次回退。
  blocked = undefined
  await React.act(async () => buttonsOf(container)[0]!.click!())
  await React.act(async () => {})
  expect(callCount(call, 'stop-edit')).toBe(1)
  expect(callCount(call, 'stop-edit-state')).toBeGreaterThanOrEqual(3)
  expect(container.textContent).toContain('编辑消息')
  expect(container.textContent).not.toContain('结果不确定')
})

it('确认响应 acknowledged:false 与抛错一样给出固定诊断，不当作成功', async () => {
  const drafts: string[] = []
  const call = vi.fn(async (method: string) =>
    method === 'stop-edit-state'
      ? state({ pendingDraft: { text: '恢复前的原文', clientRequestId: 'r9' } })
      : { acknowledged: false },
  )
  const { container } = await mount({
    sessionId: 'session-1',
    call,
    onDraft: (text) => drafts.push(text),
  })
  await React.act(async () => {})
  await React.act(async () => {})
  // 原文确实放回了输入框，但 Host 明确回答“没有确认”，必须如实提示。
  expect(drafts).toEqual(['恢复前的原文'])
  expect(container.textContent).toContain('清除待填草稿失败')
})

it('旧会话晚到的确认失败不写进新会话的提示，也不影响新会话草稿', async () => {
  const gate = Promise.withResolvers<unknown>()
  const drafts: string[] = []
  const call = vi.fn(async (method: string, request?: unknown) => {
    if (method === 'stop-edit-state') {
      const id = (request as { sessionId: string }).sessionId
      return state({
        sessionId: id,
        ...(id === 'session-1'
          ? { pendingDraft: { text: '恢复前的原文', clientRequestId: 'late-ack' } }
          : {}),
      })
    }
    if (method === 'stop-edit-acknowledge') return gate.promise
    return { acknowledged: true }
  })
  const { container, render: rerender } = await mount({
    sessionId: 'session-1',
    call,
    onDraft: (text) => drafts.push(text),
  })
  await rerender({ sessionId: 'session-2', draftText: 'new draft' })
  await React.act(async () => {
    gate.reject(new Error('owned late failure'))
    await gate.promise.catch(() => {})
  })
  await React.act(async () => {})
  expect(container.textContent).not.toContain('清除待填草稿失败')
  expect(container.textContent).not.toContain('owned late failure')
  // 新会话照常显示入口，旧会话的失败没有污染它。
  expect(container.textContent).toContain('编辑消息')
})

it('回退飞行期间卸载：迟到结果不写输入框、不确认草稿、不导航', async () => {
  const drafts: string[] = []
  const gate = deferred<StopEditResult>()
  const call = vi.fn(async (method: string) => {
    if (method === 'stop-edit-state') return state()
    if (method === 'stop-edit') return gate.promise
    return { acknowledged: true }
  })
  const { container } = await mount({
    sessionId: 'session-1',
    call,
    onDraft: (text) => drafts.push(text),
  })
  await React.act(async () => buttonsOf(container)[0]!.click!())
  await React.act(async () => buttonsOf(container)[1]!.click!())
  expect(callCount(call, 'stop-edit')).toBe(1)
  // 组件在回退飞行期间卸载。
  await React.act(async () => root.unmount())
  await React.act(async () => {
    gate.resolve(outcome({ moved: false }))
    await gate.promise
  })
  await React.act(async () => {})
  // 原文留在 Host 的持久草稿里等下一次恢复：不写 composer，也不确认草稿。
  expect(drafts).toEqual([])
  expect(callCount(call, 'stop-edit-acknowledge')).toBe(0)
})

it('恢复读取还在飞时卸载：原文不写输入框，也不确认草稿', async () => {
  const drafts: string[] = []
  const gate = deferred<StopEditState>()
  const call = vi.fn(async (method: string) => {
    if (method === 'stop-edit-state') return gate.promise
    return { acknowledged: true }
  })
  const { container } = await mount({
    sessionId: 'session-1',
    call,
    onDraft: (text) => drafts.push(text),
  })
  expect(container.textContent).toBe('')
  await React.act(async () => root.unmount())
  await React.act(async () => {
    gate.resolve(state({ pendingDraft: { text: '恢复前的原文', clientRequestId: 'r9' } }))
    await gate.promise
  })
  await React.act(async () => {})
  expect(drafts).toEqual([])
  expect(callCount(call, 'stop-edit-acknowledge')).toBe(0)
})
