import { createTestDom } from './dom.ts'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'
import { MessageEditSession } from '../../src/execution/client/message-edit-session.ts'
import { MessageEditAction } from '../../src/execution/client/MessageEditAction.tsx'
import type { MessageEditState } from '../../src/execution/contracts/message-edit.ts'
import {
  MessageEditUserRow,
  type MessageEditUserRowProps,
} from '../../src/execution/client/MessageEditUserRow.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCopyOutlineRegular: () => null,
  IconEditOutlineRegular: () => null,
  Tooltip: ({ children }: { children: unknown }) => children,
}))

type ShimNode = {
  nodeName?: string
  childNodes?: ShimNode[]
  parentNode?: ShimNode | null
  getAttribute?(name: string): string | null
  click?(): boolean
}

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
    const event = {
      type,
      target,
      bubbles: true,
      cancelable: true,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    }
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
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
})
let root: Root
afterEach(async () => {
  await act(async () => root?.unmount())
})

function buttons(scope: ShimNode): ShimNode[] {
  return [
    ...(scope.nodeName === 'BUTTON' ? [scope] : []),
    ...(scope.childNodes ?? []).flatMap(buttons),
  ]
}

it('renders edit beside copy and fills the exact selected message', async () => {
  const call = vi.fn(async (method: string) =>
    method === 'message-edit-state'
      ? {
          sessionId: 'row-session',
          supported: true,
          busy: false,
          pending: false,
          head: 9,
          choices: [{ seq: 3, text: '第一条可编辑消息' }],
        }
      : { accepted: true },
  )
  const session = new MessageEditSession('row-session', call as ExecutionCall)
  await session.load()
  const setDraft = vi.fn()
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(
      createElement(MessageEditUserRow, {
        node: {
          kind: 'user',
          data: {
            kind: 'user',
            seq: 3,
            time: Date.now(),
            content: [{ type: 'text', text: '第一条可编辑消息' }],
            source: { kind: 'user' },
          },
        },
        loadImage: vi.fn(),
        renderFactorySlot: vi.fn((_name, props) => createElement('span', null, props.content.text)),
        edit: session,
        useInput: ((selector: (state: { draft: string }) => unknown) =>
          selector({ draft: '' })) as ChatNodeViewProps<'user'>['useInput'],
        inputActions: { setDraft },
        t: (key: string) =>
          ({
            copy: '复制',
            copied: '已复制',
            'clock.md': '{m}月{d}日',
            'clock.ymd': '{y}年{m}月{d}日',
          })[key] ?? key,
      } as unknown as MessageEditUserRowProps),
    ),
  )
  const actions = buttons(container)
  expect(actions.map((button) => button.getAttribute?.('aria-label'))).toEqual(['复制', '编辑消息'])
  expect(container.textContent).toContain('第一条可编辑消息')
  expect(container.textContent).not.toContain('取消编辑')
  await act(async () => actions[1]!.click!())
  expect(setDraft).toHaveBeenCalledWith('第一条可编辑消息')
})

function actionState(sessionId = 'action-session'): MessageEditState {
  return {
    sessionId,
    supported: true,
    busy: false,
    pending: false,
    head: 9,
    choices: [{ seq: 3, text: '消息原文' }],
  }
}

it('keeps a supported edit action reachable while initial history is unavailable and retries only the read', async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce({
      ...actionState(),
      choices: [],
      unavailable: { reason: 'history-unavailable', retryable: true },
    })
    .mockResolvedValueOnce(actionState())
  const session = new MessageEditSession('action-session', call as ExecutionCall)
  await session.load()
  const onDraft = vi.fn()
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(createElement(MessageEditAction, { session, seq: 3, draft: '', onDraft })),
  )
  expect(buttons(container).map((button) => button.getAttribute?.('aria-label'))).toEqual([
    '重试编辑',
  ])
  await act(async () => buttons(container)[0]!.click!())
  expect(call).toHaveBeenCalledTimes(2)
  expect(call).toHaveBeenLastCalledWith('message-edit-state', { sessionId: 'action-session' })
  expect(onDraft).not.toHaveBeenCalled()
  expect(session.getSnapshot().selection).toBeUndefined()
  expect(buttons(container)[0]?.getAttribute?.('aria-label')).toBe('编辑消息')
})

it.each([
  { supported: false, choices: [] },
  { supported: true, choices: [] },
])('omits an action without supported editable history: %j', async (fields) => {
  const call = vi.fn().mockResolvedValue({ ...actionState(), ...fields })
  const session = new MessageEditSession('action-session', call as ExecutionCall)
  await session.load()
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(createElement(MessageEditAction, { session, seq: 3, draft: '', onDraft: vi.fn() })),
  )
  expect(buttons(container)).toHaveLength(0)
})

it('retains a known row action and selected draft during a temporary empty history result', async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce(actionState())
    .mockResolvedValueOnce({
      ...actionState(),
      choices: [],
      unavailable: { reason: 'mapping-unavailable', retryable: false },
    })
  const session = new MessageEditSession('action-session', call as ExecutionCall)
  await session.load()
  await session.select(3, '')
  const selected = session.getSnapshot().selection
  const onDraft = vi.fn()
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(createElement(MessageEditAction, { session, seq: 3, draft: '编辑草稿', onDraft })),
  )
  await act(async () => session.load())
  const action = buttons(container)[0]!
  expect(action.getAttribute?.('aria-label')).toBe('编辑消息')
  expect(action.getAttribute?.('aria-disabled')).toBe('true')
  await act(async () => action.click!())
  expect(call).toHaveBeenCalledTimes(2)
  expect(session.getSnapshot().selection).toBe(selected)
  expect(onDraft).not.toHaveBeenCalled()
})

it('offers a read retry after transport failure when engine support was already observed', async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce({ ...actionState(), choices: [] })
    .mockRejectedValueOnce(Error('offline'))
  const session = new MessageEditSession('action-session', call as ExecutionCall)
  await session.load()
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(createElement(MessageEditAction, { session, seq: 3, draft: '', onDraft: vi.fn() })),
  )
  expect(buttons(container)).toHaveLength(0)
  await act(async () => session.load())
  expect(buttons(container)[0]?.getAttribute?.('aria-label')).toBe('重试编辑')
  expect(session.getSnapshot().selection).toBeUndefined()
})

it.each(['session', 'draft', 'unmount'] as const)(
  'does not fill an old edit after a %s change while selection completes',
  async (change) => {
    const call = vi.fn().mockResolvedValue(actionState())
    const session = new MessageEditSession('action-session', call as ExecutionCall)
    await session.load()
    const nextCall = vi.fn().mockResolvedValue(actionState('next-session'))
    const nextSession = new MessageEditSession('next-session', nextCall as ExecutionCall)
    await nextSession.load()
    const onDraft = vi.fn()
    const container = dom.container()
    root = createRoot(container as unknown as HTMLElement)
    const render = (active: MessageEditSession, draft = '') =>
      root.render(createElement(MessageEditAction, { session: active, seq: 3, draft, onDraft }))
    await act(async () => render(session))
    const select = session.select.bind(session)
    vi.spyOn(session, 'select').mockImplementation((seq, draft) => {
      const result = select(seq, draft)
      flushSync(() => {
        if (change === 'unmount') root.unmount()
        else
          render(change === 'session' ? nextSession : session, change === 'draft' ? '新草稿' : '')
      })
      return result
    })
    await act(async () => buttons(container)[0]!.click!())
    expect(onDraft).not.toHaveBeenCalled()
    expect(session.getSnapshot().selection).toBeUndefined()
    expect(nextSession.getSnapshot().selection).toBeUndefined()
  },
)
