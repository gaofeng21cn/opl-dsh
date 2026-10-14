import { createTestDom } from './dom.ts'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'
import { MessageEditControl } from '../../src/execution/client/MessageEditControl.tsx'
import type { MessageEditSend } from '../../src/execution/contracts/message-edit.ts'

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

/**
 * Give the shim a real bubbling `click`, so React's delegated listener runs the
 * component's own handler instead of the test reaching into it.
 */
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
      stopPropagation() {
        stopped = true
      },
      stopImmediatePropagation() {
        stopped = true
      },
    }
    let stopped = false
    let node = target as { parentNode?: ShimNode | null } | null
    while (node) {
      for (const listener of listeners.get(node)?.get(type) ?? []) listener(event)
      node = node.parentNode
      if (stopped) break
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
it('offers explicit recovery when replaced history has no edit choices, without automatically sending', async () => {
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
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  await act(async () =>
    root.render(
      createElement(MessageEditControl, {
        sessionId: 'failed-prepare',
        call: call as ExecutionCall,
        inputActions: { setDraft: vi.fn() },
        useInput: ((selector: (state: InputState) => unknown) =>
          selector({ draft: '' } as InputState)) as SnapshotSelectorHook<InputState>,
        bindPrompt: () => () => {},
      }),
    ),
  )
  expect(call).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('编辑消息')
  await act(async () => buttons(container)[0]!.click!())
  const retry = buttons(container).find((button) => button.textContent === '重试未确认的编辑')
  expect(retry).toBeDefined()
  expect(call).toHaveBeenCalledTimes(1)
  await act(async () => retry!.click!())
  expect(call).toHaveBeenNthCalledWith(2, 'message-edit-send', recovery)
  expect(container.textContent).not.toContain('重试未确认的编辑')
})

it('keeps the edit button when the parent recreates callback props', async () => {
  const state = {
    sessionId: 'rerender-edit',
    supported: true,
    busy: false,
    pending: false,
    head: 4,
    choices: [{ seq: 3, text: '可编辑消息' }],
  }
  const container = dom.container()
  root = createRoot(container as unknown as HTMLElement)
  const render = () =>
    root.render(
      createElement(MessageEditControl, {
        sessionId: state.sessionId,
        call: vi.fn(async (method: string) =>
          method === 'message-edit-state' ? state : { accepted: true },
        ) as ExecutionCall,
        inputActions: { setDraft: vi.fn() },
        useInput: ((selector: (value: InputState) => unknown) =>
          selector({ draft: '' } as InputState)) as SnapshotSelectorHook<InputState>,
        bindPrompt: () => () => {},
      }),
    )
  await act(async () => render())
  expect(container.textContent).toContain('编辑消息')
  await act(async () => render())
  expect(container.textContent).toContain('编辑消息')
})
