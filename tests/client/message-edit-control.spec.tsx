import { createTestDom } from './dom.ts'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'
import { MessageEditControl } from '../../src/execution/client/MessageEditControl.tsx'
import { MessageEditSession } from '../../src/execution/client/message-edit-session.ts'
import type { MessageEditSend } from '../../src/execution/contracts/message-edit.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCloseOutlineRegular: () => null,
  Tooltip: ({ children }: { children: unknown }) => children,
}))

type ShimNode = {
  nodeType: number
  childNodes?: ShimNode[]
  parentNode?: ShimNode | null
  tagName?: string
  nodeName?: string
  textContent?: string | null
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
      defaultPrevented: false,
      timeStamp: 0,
      eventPhase: 2,
      preventDefault() {
        event.defaultPrevented = true
      },
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

it('keeps unconfirmed edit recovery reachable without offering a normal composer trigger', async () => {
  const recovery: MessageEditSend = {
    prompt: {
      sessionId: 'failed-prepare' as MessageEditSend['prompt']['sessionId'],
      requestId: 'original-request' as MessageEditSend['prompt']['requestId'],
      mode: 'queue',
      content: [{ type: 'text', text: 'original edited text' }],
    },
    targetSeq: 3,
    head: 8,
  }
  const call = vi.fn(async (method: string) =>
    method === 'message-edit-state'
      ? {
          sessionId: 'failed-prepare',
          supported: true,
          busy: false,
          pending: true,
          choices: [],
          head: 12,
          recovery,
        }
      : { accepted: true },
  )
  const session = new MessageEditSession('failed-prepare', call as ExecutionCall)
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(
      createElement(MessageEditControl, {
        session,
        inputActions: { setDraft: vi.fn() },
      }),
    ),
  )
  expect(container.textContent).not.toContain('编辑消息')
  expect(container.textContent).toContain('重试未确认的编辑')
  await act(async () => buttons(container)[0]!.click!())
  expect(call).toHaveBeenNthCalledWith(2, 'message-edit-send', recovery)
})

it('selects one message in shared state without opening a second message list', async () => {
  const call = vi.fn(async (method: string) =>
    method === 'message-edit-state'
      ? {
          sessionId: 'one-message',
          supported: true,
          busy: false,
          pending: false,
          head: 4,
          choices: [{ seq: 3, text: '可编辑消息' }],
        }
      : { accepted: true },
  )
  const session = new MessageEditSession('one-message', call as ExecutionCall)
  await session.load()
  expect(await session.select(3, '')).toBe(true)
  expect(session.getSnapshot().selection).toEqual({
    seq: 3,
    head: 4,
    previousDraft: '',
  })
  expect(await session.select(3, '已有草稿')).toBe(false)
  expect(session.getSnapshot().error).toContain('草稿')
})
