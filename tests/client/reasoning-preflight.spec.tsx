/** Real composer lifecycle coverage for advertised external reasoning controls. */
import { createTestDom } from './dom.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import type { ReactNode } from 'react'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { HarnessReasoningPreflight } from '../../src/contracts/types.ts'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCheckOutlineRegular: () => null,
  IconChevronDownOutlineRegular: () => null,
  IconChevronRightOutlineRegular: () => null,
  StateDot: () => null,
  MenuSurface: React.forwardRef(function MenuSurface(
    props: { children?: ReactNode },
    ref: React.ForwardedRef<HTMLDivElement>,
  ) {
    return React.createElement('div', { ...props, ref })
  }),
}))

const dom = createTestDom()
const { act } = React
const { CombinationSelect } = await import('../../src/execution/client/CombinationSelect.tsx')
const { createRoot } = await import('react-dom/client')
const efforts = [
  { id: 'low', name: '低' },
  { id: 'medium', name: '中' },
  { id: 'high', name: '高' },
]
const known = (currentEffort: string): HarnessReasoningPreflight => ({
  status: 'known',
  efforts,
  currentEffort,
})
const unavailable: HarnessReasoningPreflight = { status: 'unavailable', efforts: [] }
const combination = {
  id: 'gemini-antigravity',
  name: 'Gemini Flash + Antigravity',
  enabled: true,
  isDefault: true,
  modelRef: { provider: 'opl-gateway', model: 'gemini-flash' },
  harnessRef: 'antigravity',
  permissionPolicy: 'full-access',
}
const second = {
  ...combination,
  id: 'other',
  modelRef: { ...combination.modelRef, model: 'other' },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => (resolve = settle))
  return { promise, resolve }
}

function fixture(
  probe: (attempt: number) => Promise<HarnessReasoningPreflight> | HarnessReasoningPreflight,
) {
  let current: { provider: string; model: string; reasoningEffort?: string } = combination.modelRef
  let explicit = false
  let attempt = 0
  let frame: ModelSelectionProjection = { next: current, lastUsed: null }
  const listeners = new Set<() => void>()
  const face = {
    getSnapshot: () => frame,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const calls: string[] = []
  const call = (async (method: string, args?: unknown) => {
    calls.push(method)
    if (method === 'catalog')
      return {
        models: [combination, second].map((item) => ({
          ref: item.modelRef,
          name: item.modelRef.model,
          source: 'OPL Gateway',
          available: true,
        })),
        harnesses: [{ id: 'antigravity', name: 'Antigravity', available: true }],
        combinations: [combination, second],
      }
    if (method === 'combinations')
      return [combination, second].map((item) => ({ id: item.id, available: true }))
    if (method === 'model-selection')
      return {
        current,
        combination: current.model === second.modelRef.model ? second.id : combination.id,
        ...(explicit ? { effortSource: 'harness' } : {}),
        groups: [
          {
            id: 'opl-gateway',
            name: 'OPL Gateway',
            models: [combination, second].map((item) => ({
              id: item.modelRef.model,
              name: item.modelRef.model,
              reasoning: { defaultEffort: 'medium', efforts },
            })),
          },
        ],
      }
    if (method === 'reasoning-preflight') return probe(++attempt)
    if (method === 'select-effort') {
      const input = args as { reasoningEffort?: string }
      current = {
        ...combination.modelRef,
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      }
      explicit = true
      return undefined
    }
    throw new Error(`Unexpected method ${method}`)
  }) as unknown as ExecutionCall
  return {
    call,
    source: () => face,
    probes: () => calls.filter((method) => method === 'reasoning-preflight').length,
    switchModel() {
      current = second.modelRef
      frame = { next: current, lastUsed: null }
      for (const listener of listeners) listener()
    },
  }
}

const mounted: Array<() => Promise<void>> = []
afterEach(async () => {
  while (mounted.length) await mounted.pop()!()
  vi.useRealTimers()
})

async function mount(f: ReturnType<typeof fixture>, locked = false) {
  const container = dom.container()
  const root = createRoot(container as unknown as Element)
  const render = (sessionId: string, locked: boolean) =>
    act(async () => {
      root.render(
        React.createElement(CombinationSelect, {
          call: f.call,
          sessionId,
          locked,
          available: true,
          selectionSource: f.source,
          loadingLabel: '正在加载模型…',
        }),
      )
    })
  const unmount = () => act(async () => root.unmount())
  mounted.push(unmount)
  await render('session-a', locked)
  const body = globalThis.document.body as unknown as ShimNode
  return {
    text: () => container.textContent,
    update: (locked: boolean, sessionId = 'session-a') => render(sessionId, locked),
    open: () =>
      act(async () => (container.childNodes[0]?.childNodes[0] as unknown as ShimNode).click()),
    click: (label: string) =>
      act(async () => {
        const button = collect(body).find(
          (node) => node.nodeName === 'BUTTON' && node.textContent === label,
        )
        expect(button, `Missing button ${label}`).toBeDefined()
        button!.click()
      }),
  }
}

type ShimNode = {
  nodeName: string
  textContent: string
  childNodes: ShimNode[]
  parentNode: ShimNode | null
  click: () => void
}
function collect(node: ShimNode): ShimNode[] {
  return [node, ...node.childNodes.flatMap(collect)]
}

// The process DOM supplies layout; this small event shim drives React's public click handlers.
const elementPrototype = Object.getPrototypeOf(dom.document.createElement('div')) as Record<
  string,
  unknown
>
const listeners = new WeakMap<object, Map<string, Set<(event: unknown) => void>>>()
elementPrototype['addEventListener'] = function (type: string, listener: (event: unknown) => void) {
  const byType = listeners.get(this as object) ?? new Map()
  const set = byType.get(type) ?? new Set()
  set.add(listener)
  byType.set(type, set)
  listeners.set(this as object, byType)
}
elementPrototype['removeEventListener'] = function (
  type: string,
  listener: (event: unknown) => void,
) {
  listeners
    .get(this as object)
    ?.get(type)
    ?.delete(listener)
}
elementPrototype['click'] = function () {
  let stopped = false
  const event = {
    type: 'click',
    target: this,
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
  let node = this as ShimNode | null
  while (node) {
    for (const listener of listeners.get(node)?.get('click') ?? []) listener(event)
    node = stopped ? null : node.parentNode
  }
}

describe('external reasoning preflight lifecycle', () => {
  it('shows the CLI-confirmed current effort without opening the model menu', async () => {
    const f = fixture(() => known('high'))
    const view = await mount(f)
    expect(view.text()).toContain('高')
    expect(view.text()).not.toContain('默认')
    expect(f.probes()).toBe(1)
    await view.open()
    expect(f.probes()).toBe(1)
  })

  it('does not invent a default when the CLI did not report one', async () => {
    const f = fixture(() => ({ status: 'known', efforts }))
    const view = await mount(f)
    expect(view.text()).not.toContain('中')
    expect(view.text()).not.toContain('高')
  })

  it('recovers from the first unavailable read without opening the menu', async () => {
    vi.useFakeTimers()
    const f = fixture((attempt) => (attempt === 1 ? unavailable : known('high')))
    const view = await mount(f)
    expect(f.probes()).toBe(1)
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(view.text()).toContain('高')
    expect(f.probes()).toBe(2)
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(f.probes()).toBe(2)
  })

  it('stops recovery after two retries and clears it when the Session changes', async () => {
    vi.useFakeTimers()
    const f = fixture(() => unavailable)
    const view = await mount(f)
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(f.probes()).toBe(3)
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(f.probes()).toBe(3)
    await view.update(false, 'session-b')
    expect(f.probes()).toBe(4)
    await view.update(true)
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(f.probes()).toBe(4)
  })

  it('defers CLI startup while locked and loads as soon as the input unlocks', async () => {
    const f = fixture(() => known('high'))
    const view = await mount(f, true)
    expect(f.probes()).toBe(0)
    await view.update(false)
    expect(f.probes()).toBe(1)
    expect(view.text()).toContain('高')
  })

  it('keeps the confirmed same-combination value during refresh and failed refresh', async () => {
    vi.useFakeTimers()
    const pending = deferred<HarnessReasoningPreflight>()
    const f = fixture((attempt) =>
      attempt === 1 ? known('high') : attempt === 2 ? pending.promise : unavailable,
    )
    const view = await mount(f)
    await view.update(true)
    await view.update(false)
    expect(view.text()).toContain('高')
    await act(async () => pending.resolve(unavailable))
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(view.text()).toContain('高')
  })

  it('ignores a late response from the previous combination', async () => {
    const pending = deferred<HarnessReasoningPreflight>()
    const f = fixture((attempt) => (attempt === 1 ? pending.promise : known('low')))
    const view = await mount(f)
    await act(async () => f.switchModel())
    expect(view.text()).toContain('低')
    await act(async () => pending.resolve(known('high')))
    expect(view.text()).toContain('低')
    expect(view.text()).not.toContain('高')
  })

  it('refreshes after an explicit effort change without restoring the previous CLI value', async () => {
    const pending = deferred<HarnessReasoningPreflight>()
    const f = fixture((attempt) => (attempt === 1 ? known('high') : pending.promise))
    const view = await mount(f)
    await view.open()
    await view.click('推理强度高')
    await view.click('低')
    expect(f.probes()).toBe(2)
    expect(view.text()).toContain('低')
    expect(view.text()).not.toContain('高')
    await act(async () => pending.resolve(known('low')))
    expect(view.text()).toContain('低')
  })

  it('keeps unsupported controls hidden', async () => {
    const f = fixture(() => ({ status: 'not-applicable', efforts: [] }))
    const view = await mount(f)
    expect(view.text()).not.toContain('高')
    await view.open()
    expect(globalThis.document.body.textContent).not.toContain('推理强度')
    expect(f.probes()).toBe(1)
  })
})
