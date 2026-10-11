/**
 * Context-budget Client view — component and projection tests.
 *
 * Nothing here touches a real credential, model, Remote, or Host: the only
 * dependency of the view is the `read` seam, and every case drives it with a
 * local promise. Coverage: unknown values and absent keys, per-figure source
 * labels, official metric wording, fixed-vocabulary warning mapping, the
 * no-data/read-failure split, failure retry, refresh on a model-selection
 * change and on reopening, a late answer from a previous Session or a previous
 * Host generation, a snapshot naming another Session, and post-unmount silence.
 */
import './dom.ts'
import { createTestDom } from './dom.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ContextBudgetSnapshot } from '../../src/context-budget/contracts/budget.ts'
import {
  ContextBudgetControl,
  OptionalBudgetControl,
  type ContextBudgetControlProps,
} from '../../src/context-budget/client/ContextBudgetControl.tsx'
import {
  METRIC_LABEL_KEY,
  METRIC_ORDER,
  SOURCE_LABEL_KEY,
  SOURCE_ORDER,
  WARNING_LABEL_KEY,
  WARNING_ORDER,
  formatTokenCount,
  hasObservation,
  metricsByKey,
  warningRows,
} from '../../src/context-budget/client/budget-view.ts'
import { ContextBudgetReadStore } from '../../src/context-budget/client/controller.ts'
import {
  MODEL_SELECTION_PROJECTION,
  modelSelectionKey,
  watchBudgetSession,
  type BudgetSessionFace,
} from '../../src/context-budget/client/session-signals.ts'
import { BudgetPreference } from '../../src/context-budget/client/preference.ts'
import { en, zh } from '../../src/context-budget/client/locales.ts'

// The official Desktop supplies Zustand/Immer; component tests use observable snapshots.
vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: <T,>(initial: T) => {
    let snapshot = initial
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set: (value: T) => {
        snapshot = value
        listeners.forEach((listener) => listener())
      },
    }
  },
}))

type ShimNode = {
  nodeType: number
  childNodes?: ShimNode[]
  parentNode?: ShimNode | null
  nodeName?: string
  textContent?: string | null
  getAttribute?(name: string): string | null
  click?(): boolean
}

/**
 * Give the shim a real bubbling `click`, so React's delegated listener runs
 * the component's own handler instead of the test reaching into it.
 */
function enableClick(dom: { document: { createElement(name: string): object } }): void {
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
  const dispatch = (type: string, target: object): boolean => {
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
    let node = target as { parentNode?: ShimNode | null | undefined } | null
    while (node) {
      for (const listener of listeners.get(node)?.get(type) ?? []) listener(event)
      node = node.parentNode ?? null
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

/** Local translator over the real `zh` dictionary, matching the injected seat. */
const dictionary: Record<string, string> = zh
function translate(key: string, params?: Record<string, unknown>): string {
  const template = dictionary[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}
const t = translate as ContextBudgetControlProps['t']

function snapshot(
  sessionId: string,
  over: Partial<ContextBudgetSnapshot> = {},
): ContextBudgetSnapshot {
  return {
    sessionId,
    observedAt: '2026-10-11T01:00:00.000Z',
    execution: 'native',
    provider: 'deepseek',
    model: 'deepseek-v4',
    metrics: [],
    warnings: [],
    ...over,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => {
  await React.act(async () => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
})

it('点击面板内部保持展开，外部按下收起且不触发读取', async () => {
  let press!: (event: PointerEvent) => void
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'pointerdown') press = listener as (event: PointerEvent) => void
  })
  const remove = vi.spyOn(document, 'removeEventListener')
  const read = vi.fn(async (id: string) => snapshot(id))
  const container = await renderControl({ sessionId: 'a', read, t })
  await expand(container)
  await React.act(async () =>
    press({ target: buttonWith(container, zh.entry) } as unknown as PointerEvent),
  )
  expect(buttonWith(container, zh.entry).getAttribute!('aria-expanded')).toBe('true')
  const before = read.mock.calls.length
  await React.act(async () => press({ target: document.body } as unknown as PointerEvent))
  expect(buttonWith(container, zh.entry).getAttribute!('aria-expanded')).toBe('false')
  expect(read).toHaveBeenCalledTimes(before)
  expect(remove).toHaveBeenCalledWith('pointerdown', press, true)
})

async function renderControl(props: ContextBudgetControlProps): Promise<ShimNode> {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  root = createRoot(container as unknown as HTMLElement)
  await React.act(async () => root!.render(React.createElement(ContextBudgetControl, props)))
  return container as unknown as ShimNode
}

async function rerender(props: ContextBudgetControlProps): Promise<void> {
  await React.act(async () => root!.render(React.createElement(ContextBudgetControl, props)))
}

/** Flush the microtask queue inside act, so an awaited read can publish. */
async function settle(): Promise<void> {
  await React.act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function walk(node: ShimNode, visit: (node: ShimNode) => void): void {
  visit(node)
  for (const child of node.childNodes ?? []) walk(child, visit)
}

function buttons(scope: ShimNode): ShimNode[] {
  const found: ShimNode[] = []
  walk(scope, (node) => {
    if (node.nodeName === 'BUTTON') found.push(node)
  })
  return found
}

function buttonWith(scope: ShimNode, text: string): ShimNode {
  const found = buttons(scope).find((node) => (node.textContent ?? '').includes(text))
  expect(found, `a button labelled ${text} must exist`).toBeDefined()
  return found!
}

function hoverText(scope: ShimNode): string {
  const titles: string[] = []
  walk(scope, (node) => {
    const title = node.getAttribute?.('title')
    if (title) titles.push(title)
  })
  return titles.join('\n')
}

function textOf(scope: ShimNode): string {
  return scope.textContent ?? ''
}

async function expand(container: ShimNode): Promise<void> {
  await React.act(async () => buttonWith(container, zh.entry).click!())
}

/** A projection face for a key this view must not watch. */
function inertFace(): ObservableSnapshot<unknown> {
  return { getSnapshot: () => undefined, subscribe: () => () => {} }
}

/** An official `ModelSelectionProjection` view: `lastUsed` plus the fallback `next`. */
function selectionView(model: string, provider = 'deepseek'): Record<string, unknown> {
  return { lastUsed: { provider, model }, next: { provider, model } }
}

/** Fake of the official `modelSelection` projection face. */
function modelSelectionFace(initial: unknown) {
  let value = initial
  const subscribers = new Set<() => void>()
  return {
    face: {
      getSnapshot: () => value,
      subscribe: (callback: () => void) => {
        subscribers.add(callback)
        return () => {
          subscribers.delete(callback)
        }
      },
    },
    /** Publish a value under a fresh watermark, as `ProjectionValueStore.apply` does. */
    publish: (next: unknown) => {
      value = next
      subscribers.forEach((callback) => callback())
    },
    subscribers: () => subscribers.size,
  }
}

/** Real refresh wiring of one component test: the official lifecycle observable plus a selection face. */
function realSessionSignal(selection: {
  getSnapshot(): unknown
  subscribe(fn: () => void): () => void
}) {
  const state = { running: false, blank: false, openState: 'open' }
  const lifecycle = new Set<() => void>()
  const session: BudgetSessionFace = {
    getSnapshot: () => state,
    subscribe: (callback: () => void) => {
      lifecycle.add(callback)
      return () => {
        lifecycle.delete(callback)
      }
    },
    projections: {
      faceOf: (key: string) => (key === MODEL_SELECTION_PROJECTION ? selection : inertFace()),
    },
  }
  return {
    session,
    subscribeSession: (_id: string, listener: () => void) => watchBudgetSession(session, listener),
    transition: (next: Partial<typeof state>) => {
      Object.assign(state, next)
      lifecycle.forEach((callback) => callback())
    },
  }
}

describe('budget-view projection', () => {
  it('groups token counts and refuses to render a non-finite or absent number', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(119040)).toBe('119,040')
    expect(formatTokenCount(1000000)).toBe('1,000,000')
    expect(formatTokenCount(-25)).toBe('-25')
    expect(formatTokenCount(1.25)).toBe('1.3')
    expect(formatTokenCount(null)).toBeUndefined()
    expect(formatTokenCount(undefined)).toBeUndefined()
    expect(formatTokenCount(Number.NaN)).toBeUndefined()
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('has a dictionary label for every metric, source, and warning', () => {
    for (const key of METRIC_ORDER) expect(dictionary[METRIC_LABEL_KEY[key]]).toBeTypeOf('string')
    for (const source of SOURCE_ORDER)
      expect(dictionary[SOURCE_LABEL_KEY[source]]).toBeTypeOf('string')
    for (const warning of WARNING_ORDER) {
      expect(dictionary[WARNING_LABEL_KEY[warning]]).toBeTypeOf('string')
    }
    // Display order must cover the declared key vocabulary exactly once.
    expect([...METRIC_ORDER].sort()).toEqual(Object.keys(METRIC_LABEL_KEY).sort())
    expect([...SOURCE_ORDER].sort()).toEqual(Object.keys(SOURCE_LABEL_KEY).sort())
    expect([...WARNING_ORDER].sort()).toEqual(Object.keys(WARNING_LABEL_KEY).sort())
  })

  it('reads a malformed metric payload as nothing provided and keeps the first duplicate', () => {
    const malformed = { ...snapshot('s'), metrics: undefined } as unknown as ContextBudgetSnapshot
    expect(metricsByKey(malformed).size).toBe(0)
    const duplicated = snapshot('s', {
      metrics: [
        { key: 'pressure', value: 12, source: 'runtime' },
        { key: 'pressure', value: 99, source: 'request-header' },
      ],
    })
    expect(metricsByKey(duplicated).get('pressure')?.value).toBe(12)
  })

  it('maps only the fixed warning vocabulary, in display order', () => {
    const rows = warningRows(
      snapshot('s', {
        warnings: [
          'policy-unknown',
          'declaration-only',
          'not-a-warning' as ContextBudgetSnapshot['warnings'][number],
        ],
      }),
    )
    expect(rows.map((row) => row.key)).toEqual(['declaration-only', 'policy-unknown'])
  })

  it('treats a snapshot with no renderable number as "no usable observation"', () => {
    expect(hasObservation(snapshot('s'))).toBe(false)
    expect(
      hasObservation(
        snapshot('s', { metrics: [{ key: 'pressure', value: null, source: 'unavailable' }] }),
      ),
    ).toBe(false)
    expect(
      hasObservation(
        snapshot('s', { metrics: [{ key: 'pressure', value: 0, source: 'runtime' }] }),
      ),
    ).toBe(true)
  })
})

describe('ContextBudgetReadStore staleness rules', () => {
  const pressure = (value: number, sessionId = 'a'): ContextBudgetSnapshot =>
    snapshot(sessionId, { metrics: [{ key: 'pressure', value, source: 'runtime' }] })

  it('drops the previous route figures while a re-read is pending and marks it a reload', async () => {
    const second = deferred<ContextBudgetSnapshot>()
    const read = vi
      .fn<(id: string) => Promise<ContextBudgetSnapshot>>()
      .mockResolvedValueOnce(snapshot('a', { model: 'old-route' }))
      .mockReturnValueOnce(second.promise)
    const store = new ContextBudgetReadStore({ read })
    await store.load('a')
    expect(store.getSnapshot().status).toBe('ready')
    expect(store.getSnapshot().reloading).toBe(false)
    const refresh = store.load('a')
    // A pending re-read never keeps the previous route's figures on screen as
    // if they described the route being read now.
    expect(store.getSnapshot().status).toBe('loading')
    expect(store.getSnapshot().reloading).toBe(true)
    expect(store.getSnapshot().snapshot).toBeUndefined()
    second.resolve(snapshot('a', { model: 'new-route' }))
    await refresh
    expect(store.getSnapshot().snapshot?.model).toBe('new-route')
    expect(store.getSnapshot().reloading).toBe(false)
  })

  it('clears the observation on failure and reports a failure rather than a reload', async () => {
    const read = vi
      .fn<(id: string) => Promise<ContextBudgetSnapshot>>()
      .mockResolvedValueOnce(pressure(10))
      .mockRejectedValueOnce(new Error('transport detail'))
    const store = new ContextBudgetReadStore({ read })
    await store.load('a')
    expect(store.getSnapshot().snapshot?.metrics[0]?.value).toBe(10)
    await store.load('a')
    expect(store.getSnapshot().status).toBe('error')
    expect(store.getSnapshot().reloading).toBe(false)
    expect(store.getSnapshot().snapshot).toBeUndefined()
  })

  it('ignores a late answer for a Session the store no longer targets', async () => {
    const first = deferred<ContextBudgetSnapshot>()
    const second = deferred<ContextBudgetSnapshot>()
    const read = vi.fn((id: string) => (id === 'a' ? first.promise : second.promise))
    const store = new ContextBudgetReadStore({ read })
    const one = store.load('a')
    const two = store.load('b')
    second.resolve({ ...pressure(2), sessionId: 'b' })
    await two
    expect(store.getSnapshot().sessionId).toBe('b')
    expect(store.getSnapshot().snapshot?.metrics[0]?.value).toBe(2)
    first.resolve({ ...pressure(9), sessionId: 'a' })
    await one
    expect(store.getSnapshot().sessionId).toBe('b')
    expect(store.getSnapshot().snapshot?.metrics[0]?.value).toBe(2)
  })

  it('invalidation discards an answer from before the new Host generation', async () => {
    const stale = deferred<ContextBudgetSnapshot>()
    const fresh = deferred<ContextBudgetSnapshot>()
    const read = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    const store = new ContextBudgetReadStore({ read })
    const one = store.load('a')
    store.reset()
    expect(store.getSnapshot().status).toBe('loading')
    const two = store.load('a')
    // A reconnect knows nothing, so the next read is a first read, not a reload.
    expect(store.getSnapshot().reloading).toBe(false)
    fresh.resolve(pressure(5))
    await two
    expect(store.getSnapshot().snapshot?.metrics[0]?.value).toBe(5)
    stale.resolve(pressure(6))
    await one
    expect(store.getSnapshot().snapshot?.metrics[0]?.value).toBe(5)
  })

  it('refuses a snapshot naming another Session and never echoes the failure', async () => {
    const store = new ContextBudgetReadStore({
      read: async () => ({ ...pressure(55), sessionId: 'somebody-else' }),
    })
    await store.load('a')
    expect(store.getSnapshot().status).toBe('error')
    expect(store.getSnapshot().snapshot).toBeUndefined()
    const failing = new ContextBudgetReadStore({
      read: async () => {
        throw new Error('credential-bearing transport detail')
      },
    })
    await failing.load('a')
    expect(failing.getSnapshot().status).toBe('error')
  })

  it('rebinds at render time, so a switch rejects the answer before the next read starts', async () => {
    const pending = deferred<ContextBudgetSnapshot>()
    const store = new ContextBudgetReadStore({ read: () => pending.promise })
    const one = store.load('a')
    // The composer already renders Session `b` while no effect has issued the
    // new read yet: this window is exactly where a late answer would leak.
    store.target('b')
    expect(store.getSnapshot().sessionId).toBe('b')
    expect(store.getSnapshot().snapshot).toBeUndefined()
    pending.resolve(pressure(9, 'a'))
    await one
    expect(store.getSnapshot().sessionId).toBe('b')
    expect(store.getSnapshot().snapshot).toBeUndefined()
    // Rebinding to the Session already shown is a no-op, not a state reset.
    store.target('b')
    expect(store.getSnapshot().sessionId).toBe('b')
  })

  it('publishes nothing at all once detached', async () => {
    const pending = deferred<ContextBudgetSnapshot>()
    const store = new ContextBudgetReadStore({ read: () => pending.promise })
    const listener = vi.fn()
    store.subscribe(listener)
    const loading = store.load('a')
    expect(store.getSnapshot().status).toBe('loading')
    listener.mockClear()
    store.detach()
    pending.resolve(pressure(3))
    await loading
    expect(store.getSnapshot().status).toBe('loading')
    expect(store.getSnapshot().snapshot).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('context-budget composer entry', () => {
  it('defaults off, persists opt-in and stops reads/subscriptions when disabled', async () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
    const preference = new BudgetPreference(storage)
    const read = vi.fn(async (id: string) => snapshot(id))
    const off = vi.fn()
    const subscribeSession = vi.fn(() => off)
    const container = dom.document.createElement('div')
    root = createRoot(container as unknown as HTMLElement)
    await React.act(async () =>
      root!.render(
        <OptionalBudgetControl
          sessionId="a"
          read={read}
          subscribeSession={subscribeSession}
          preference={preference}
          t={t}
        />,
      ),
    )
    expect(container.textContent).toBe('')
    expect(read).not.toHaveBeenCalled()
    expect(subscribeSession).not.toHaveBeenCalled()
    await React.act(async () => preference.setEnabled(true))
    expect(container.textContent).toContain(zh.entry)
    expect(read).toHaveBeenCalledTimes(1)
    expect(new BudgetPreference(storage).state.getSnapshot().enabled).toBe(true)
    await React.act(async () => preference.setEnabled(false))
    expect(container.textContent).toBe('')
    expect(off).toHaveBeenCalledTimes(1)
    expect(new BudgetPreference(storage).state.getSnapshot().enabled).toBe(false)
  })

  it('reports unavailable persistence while keeping the window preference', () => {
    const preference = new BudgetPreference({
      getItem: () => {
        throw new Error('unavailable')
      },
      setItem: () => {
        throw new Error('unavailable')
      },
    })
    expect(preference.state.getSnapshot()).toEqual({ enabled: false, savingFailed: true })
    preference.setEnabled(true)
    expect(preference.state.getSnapshot()).toEqual({ enabled: true, savingFailed: true })
  })

  it('renders a compact entry and keeps the panel closed until it is expanded', async () => {
    const read = vi.fn(async (id: string) => snapshot(id))
    const container = await renderControl({ sessionId: 'a', read, t })
    const trigger = buttonWith(container, zh.entry)
    expect(trigger.getAttribute!('aria-expanded')).toBe('false')
    expect(trigger.getAttribute!('aria-haspopup')).toBe('dialog')
    expect(textOf(container)).not.toContain(zh.panelHint)
    await expand(container)
    expect(buttonWith(container, zh.entry).getAttribute!('aria-expanded')).toBe('true')
    expect(hoverText(container)).toContain(zh.panelHint)
    // Collapsing again removes the panel body but keeps the entry reachable.
    await React.act(async () => buttonWith(container, zh.entry).click!())
    expect(textOf(container)).not.toContain(zh.panelHint)
    expect(buttons(container)).toHaveLength(1)
  })

  it('hides absent, null and non-finite figures and unknown execution', async () => {
    const read = vi.fn(async (id: string) =>
      snapshot(id, {
        execution: 'unknown',
        provider: null,
        model: null,
        metrics: [
          { key: 'pressure', value: null, source: 'unavailable' },
          { key: 'projected-input', value: Number.NaN, source: 'session-projection' },
        ],
      }),
    )
    const container = await renderControl({ sessionId: 'a', read, t })
    await expand(container)
    await settle()
    for (const key of METRIC_ORDER)
      expect(textOf(container)).not.toContain(zh[METRIC_LABEL_KEY[key]])
    expect(textOf(container)).not.toContain(zh.executionUnknown)
    expect(textOf(container)).not.toContain(zh.provider)
    expect(textOf(container)).not.toContain(zh.model)
    expect(textOf(container)).not.toContain(zh.unknownValue)
    expect(textOf(container)).toContain(zh.statusEmpty)
  })

  it('labels every displayed figure with its observation source', async () => {
    const read = vi.fn(async (id: string) =>
      snapshot(id, {
        metrics: [
          { key: 'context-window', value: 512000, source: 'adapter-declaration' },
          { key: 'request-output-limit', value: 256000, source: 'request-header' },
          { key: 'projected-input', value: 12000, source: 'session-projection' },
          { key: 'pressure', value: 40000, source: 'runtime' },
        ],
      }),
    )
    const container = await renderControl({ sessionId: 'a', read, t })
    await expand(container)
    await settle()
    // Every rendered figure carries exactly the source the Host reported.
    for (const source of [
      'adapter-declaration',
      'request-header',
      'session-projection',
      'runtime',
    ] as const)
      expect(hoverText(container)).toContain(zh[SOURCE_LABEL_KEY[source]])
    // No metric was reported unavailable, so that label must not be invented.
    expect(textOf(container)).not.toContain(zh['source.unavailable'])
    expect(textOf(container)).toContain('512,000')
    expect(textOf(container)).toContain('256,000')
    expect(textOf(container)).toContain('40,000')
    expect(textOf(container)).not.toContain(zh.sourceLabel)
  })

  it('renders absolute token counts only: never a percentage', async () => {
    const read = vi.fn(async (id: string) =>
      snapshot(id, {
        metrics: [
          { key: 'context-window', value: 1000000, source: 'adapter-declaration' },
          { key: 'pressure', value: 678464, source: 'runtime' },
        ],
        warnings: ['declaration-only'],
      }),
    )
    const container = await renderControl({ sessionId: 'a', read, t })
    await expand(container)
    await settle()
    expect(textOf(container)).toContain('678,464')
    expect(textOf(container)).toContain(zh.unitTokens)
    expect(textOf(container)).not.toContain('%')
    expect(textOf(container)).not.toContain(zh.unitNote)
    expect(hoverText(container)).toContain(zh.unitNote)
  })

  it('renders exactly the snapshot warnings, mapped from the fixed vocabulary', async () => {
    const read = vi.fn(async (id: string) =>
      snapshot(id, {
        execution: 'harness',
        provider: null,
        model: null,
        metrics: [{ key: 'pressure', value: 10, source: 'runtime' }],
        warnings: ['policy-unknown', 'declaration-only', 'harness-managed'],
      }),
    )
    const container = await renderControl({ sessionId: 'a', read, t })
    await expand(container)
    await settle()
    expect(textOf(container)).not.toContain(zh['warning.declaration-only'])
    expect(hoverText(container)).toContain(zh['warning.declaration-only'])
    expect(textOf(container)).not.toContain(zh['warning.harness-managed'])
    expect(hoverText(container)).toContain(zh['warning.harness-managed'])
    expect(textOf(container)).not.toContain(zh['warning.policy-unknown'])
    expect(hoverText(container)).toContain(zh['warning.policy-unknown'])
    // A warning the Host did not report is never invented by the view.
    expect(textOf(container)).not.toContain(zh['warning.read-unavailable'])
    expect(textOf(container)).toContain(zh.executionHarness)
    expect(textOf(container)).not.toContain(zh.unknownValue)
  })

  it('keeps "reading" and "read failed" as independent states', async () => {
    const pending = deferred<ContextBudgetSnapshot>()
    const read = vi.fn(() => pending.promise)
    const container = await renderControl({ sessionId: 'a', read, t })
    await expand(container)
    expect(textOf(container)).toContain(zh.statusLoading)
    expect(textOf(container)).not.toContain(zh.statusError)
    pending.reject(new Error('transport detail'))
    await settle()
    expect(textOf(container)).toContain(zh.statusError)
    expect(textOf(container)).not.toContain(zh.statusLoading)
    expect(textOf(container)).not.toContain(zh.statusEmpty)
  })

  it('reports a failure without echoing the thrown message and re-reads on demand', async () => {
    const read = vi
      .fn<(id: string) => Promise<ContextBudgetSnapshot>>()
      .mockRejectedValueOnce(new Error('credential-bearing transport detail'))
      .mockRejectedValueOnce(new Error('credential-bearing transport detail'))
      .mockResolvedValueOnce(
        snapshot('a', { metrics: [{ key: 'pressure', value: 4321, source: 'runtime' }] }),
      )
    const container = await renderControl({ sessionId: 'a', read, t })
    await expand(container)
    await settle()
    // Both the mount read and the open read failed; the failure stands.
    expect(read).toHaveBeenCalledTimes(2)
    expect(textOf(container)).toContain(zh.statusError)
    expect(textOf(container)).not.toContain('credential-bearing transport detail')
    await React.act(async () => buttonWith(container, zh.retry).click!())
    await settle()
    expect(read).toHaveBeenCalledTimes(3)
    expect(read).toHaveBeenLastCalledWith('a')
    expect(textOf(container)).toContain('4,321')
    expect(textOf(container)).not.toContain(zh.statusError)
  })

  it('never lets a late answer for a previous Session reach the current one', async () => {
    const first = deferred<ContextBudgetSnapshot>()
    const second = deferred<ContextBudgetSnapshot>()
    const read = vi.fn((id: string) => (id === 'a' ? first.promise : second.promise))
    const base = { read, t } as const
    const container = await renderControl({ ...base, sessionId: 'a' })
    await expand(container)
    await rerender({ ...base, sessionId: 'b' })
    // Resolve the previous Session's read in the same tick as the switch, i.e.
    // inside the window React leaves between commit and passive effects.
    first.resolve(snapshot('a', { metrics: [{ key: 'pressure', value: 999, source: 'runtime' }] }))
    second.resolve(snapshot('b', { metrics: [{ key: 'pressure', value: 111, source: 'runtime' }] }))
    await settle()
    expect(textOf(container)).toContain('111')
    expect(textOf(container)).not.toContain('999')
    // mount read, open read, then the switched Session's read.
    expect(read.mock.calls.map(([id]) => id)).toEqual(['a', 'a', 'b'])
  })

  it('invalidates everything read before a new Host generation', async () => {
    const calls: Array<ReturnType<typeof deferred<ContextBudgetSnapshot>>> = []
    const read = vi.fn(() => {
      const attempt = deferred<ContextBudgetSnapshot>()
      calls.push(attempt)
      return attempt.promise
    })
    let reconnect: (() => void) | undefined
    const subscribeConnection = (listener: () => void): (() => void) => {
      reconnect = listener
      return () => {
        reconnect = undefined
      }
    }
    const container = await renderControl({ sessionId: 'a', read, subscribeConnection, t })
    await expand(container)
    expect(read).toHaveBeenCalledTimes(2)
    await React.act(async () => reconnect!())
    expect(read).toHaveBeenCalledTimes(3)
    calls[2]!.resolve(
      snapshot('a', { metrics: [{ key: 'pressure', value: 222, source: 'runtime' }] }),
    )
    await settle()
    expect(textOf(container)).toContain('222')
    // Both attempts from before the reconnect land late and are discarded.
    calls[0]!.resolve(
      snapshot('a', { metrics: [{ key: 'pressure', value: 777, source: 'runtime' }] }),
    )
    calls[1]!.resolve(
      snapshot('a', { metrics: [{ key: 'pressure', value: 888, source: 'runtime' }] }),
    )
    await settle()
    expect(textOf(container)).toContain('222')
    expect(textOf(container)).not.toContain('777')
    expect(textOf(container)).not.toContain('888')
  })

  it('refuses a snapshot that names another Session', async () => {
    const read = vi.fn(async () =>
      snapshot('somebody-else', { metrics: [{ key: 'pressure', value: 55, source: 'runtime' }] }),
    )
    const container = await renderControl({ sessionId: 'a', read, t })
    await expand(container)
    await settle()
    expect(textOf(container)).toContain(zh.statusError)
    expect(textOf(container)).not.toContain('55')
  })

  it('re-reads when an idle Session changes model, and never keeps the old route figures', async () => {
    // Real refresh wiring: the official lifecycle observable plus the official
    // `modelSelection` projection face, exactly as the plugin injects it.
    const selection = modelSelectionFace(selectionView('v4'))
    const wiring = realSessionSignal(selection.face)
    let current = { model: 'v4', pressure: 111 }
    const read = vi
      .fn<(id: string) => Promise<ContextBudgetSnapshot>>()
      .mockImplementation(async (id: string) =>
        snapshot(id, {
          model: current.model,
          metrics: [{ key: 'pressure', value: current.pressure, source: 'runtime' }],
        }),
      )
    const container = await renderControl({
      sessionId: 'a',
      read,
      subscribeSession: wiring.subscribeSession,
      t,
    })
    await expand(container)
    await settle()
    expect(textOf(container)).toContain('111')
    expect(textOf(container)).toContain('v4')
    // The Session stays completely idle; only the selection moves.
    current = { model: 'v4-pro', pressure: 222 }
    await React.act(async () => selection.publish(selectionView('v4-pro')))
    await settle()
    expect(read).toHaveBeenCalledTimes(3)
    expect(textOf(container)).toContain('222')
    expect(textOf(container)).toContain('v4-pro')
    expect(textOf(container)).not.toContain('111')
  })

  it('shows no previous route figures while a model-change re-read is pending', async () => {
    const selection = modelSelectionFace(selectionView('v4'))
    const wiring = realSessionSignal(selection.face)
    const oldRoute = snapshot('a', {
      model: 'old-route',
      metrics: [{ key: 'pressure', value: 999, source: 'session-projection' }],
    })
    const pending = deferred<ContextBudgetSnapshot>()
    const read = vi
      .fn<(id: string) => Promise<ContextBudgetSnapshot>>()
      .mockResolvedValueOnce(oldRoute)
      .mockResolvedValueOnce(oldRoute)
      .mockImplementation(() => pending.promise)
    const container = await renderControl({
      sessionId: 'a',
      read,
      subscribeSession: wiring.subscribeSession,
      t,
    })
    await expand(container)
    await settle()
    expect(textOf(container)).toContain('old-route')
    // The route changes while the Session stays idle and the new read hangs.
    await React.act(async () => selection.publish(selectionView('v4-pro')))
    const during = textOf(container)
    expect(read).toHaveBeenCalledTimes(3)
    // The pending read must not leave the old route on screen as if current.
    expect(during).not.toContain('old-route')
    expect(during).not.toContain('999')
    expect(during).toContain(zh.statusReloading)
    pending.resolve(
      snapshot('a', {
        model: 'v4-pro',
        metrics: [{ key: 'pressure', value: 111, source: 'session-projection' }],
      }),
    )
    await settle()
    expect(textOf(container)).toContain('v4-pro')
    expect(textOf(container)).toContain('111')
    expect(textOf(container)).not.toContain(zh.statusReloading)
  })

  it('shows no previous route figures while a lifecycle-triggered re-read is pending', async () => {
    const selection = modelSelectionFace(selectionView('v4'))
    const wiring = realSessionSignal(selection.face)
    const oldRoute = snapshot('a', {
      model: 'old-route',
      metrics: [{ key: 'pressure', value: 999, source: 'runtime' }],
    })
    const pending = deferred<ContextBudgetSnapshot>()
    const read = vi
      .fn<(id: string) => Promise<ContextBudgetSnapshot>>()
      .mockResolvedValueOnce(oldRoute)
      .mockResolvedValueOnce(oldRoute)
      .mockImplementation(() => pending.promise)
    const container = await renderControl({
      sessionId: 'a',
      read,
      subscribeSession: wiring.subscribeSession,
      t,
    })
    await expand(container)
    await settle()
    expect(textOf(container)).toContain('old-route')
    // A run starting is a lifecycle transition, not a selection change.
    await React.act(async () => wiring.transition({ running: true }))
    expect(read).toHaveBeenCalledTimes(3)
    expect(textOf(container)).not.toContain('old-route')
    expect(textOf(container)).not.toContain('999')
    expect(textOf(container)).toContain(zh.statusReloading)
    pending.resolve(
      snapshot('a', { metrics: [{ key: 'pressure', value: 111, source: 'runtime' }] }),
    )
    await settle()
    expect(textOf(container)).toContain('111')
  })

  it('re-reads every time the panel is opened, so a stale figure cannot persist', async () => {
    const read = vi
      .fn<(id: string) => Promise<ContextBudgetSnapshot>>()
      .mockResolvedValueOnce(
        snapshot('a', { metrics: [{ key: 'pressure', value: 111, source: 'runtime' }] }),
      )
      .mockResolvedValueOnce(
        snapshot('a', { metrics: [{ key: 'pressure', value: 222, source: 'runtime' }] }),
      )
      .mockResolvedValueOnce(
        snapshot('a', { metrics: [{ key: 'pressure', value: 333, source: 'runtime' }] }),
      )
    const container = await renderControl({ sessionId: 'a', read, t })
    // Mount reads once, with the panel still collapsed.
    expect(read).toHaveBeenCalledTimes(1)
    await expand(container)
    await settle()
    expect(textOf(container)).toContain('222')
    await React.act(async () => buttonWith(container, zh.entry).click!())
    await React.act(async () => buttonWith(container, zh.entry).click!())
    await settle()
    expect(read).toHaveBeenCalledTimes(3)
    expect(textOf(container)).toContain('333')
    expect(textOf(container)).not.toContain('222')
  })

  it('offers a side-effect-free refresh while showing data', async () => {
    let value = 111
    const read = vi.fn(async (id: string) =>
      snapshot(id, { metrics: [{ key: 'pressure', value, source: 'runtime' }] }),
    )
    const container = await renderControl({ sessionId: 'a', read, t })
    await expand(container)
    await settle()
    expect(textOf(container)).toContain('111')
    value = 444
    await React.act(async () => buttonWith(container, zh.refresh).click!())
    await settle()
    expect(read).toHaveBeenCalledTimes(3)
    expect(read).toHaveBeenLastCalledWith('a')
    expect(textOf(container)).toContain('444')
    expect(textOf(container)).not.toContain('111')
  })

  it('stops publishing once the entry is unmounted', async () => {
    const pending = deferred<ContextBudgetSnapshot>()
    const read = vi.fn(() => pending.promise)
    const container = await renderControl({ sessionId: 'a', read, t })
    await expand(container)
    await React.act(async () => root!.unmount())
    root = undefined
    expect(textOf(container)).toBe('')
    pending.resolve(snapshot('a', { metrics: [{ key: 'pressure', value: 8, source: 'runtime' }] }))
    await settle()
    // mount read and open read; the late answer for neither may publish.
    expect(read).toHaveBeenCalledTimes(2)
    expect(textOf(container)).toBe('')
  })
})

describe('budget refresh signal', () => {
  /** One fake identity-stable observable face. */
  function face<T>(initial: T) {
    let value = initial
    const subscribers = new Set<() => void>()
    return {
      getSnapshot: () => value,
      subscribe: (callback: () => void) => {
        subscribers.add(callback)
        return () => {
          subscribers.delete(callback)
        }
      },
      set: (next: T) => {
        value = next
        subscribers.forEach((callback) => callback())
      },
      size: () => subscribers.size,
    }
  }

  function sessionFace(modelSelection: ObservableSnapshot<unknown>) {
    const state = { running: false, blank: true, openState: 'open' }
    const subscribers = new Set<() => void>()
    const session = {
      getSnapshot: () => state,
      subscribe: (callback: () => void) => {
        subscribers.add(callback)
        return () => {
          subscribers.delete(callback)
        }
      },
      projections: {
        faceOf: (key: string) =>
          key === MODEL_SELECTION_PROJECTION ? modelSelection : inertFace(),
      },
    }
    return {
      session,
      state,
      churn: () => subscribers.forEach((callback) => callback()),
      size: () => subscribers.size,
    }
  }

  it('notifies only on a real Session lifecycle transition', () => {
    const selection = face<unknown>(selectionView('v4'))
    const fixture = sessionFace(selection)
    const listener = vi.fn()
    const off = watchBudgetSession(fixture.session, listener)
    // Unrelated churn is not a lifecycle transition.
    fixture.churn()
    expect(listener).not.toHaveBeenCalled()
    fixture.state.blank = false
    fixture.churn()
    fixture.state.running = true
    fixture.churn()
    fixture.state.openState = 'closed'
    fixture.churn()
    expect(listener).toHaveBeenCalledTimes(3)
    off()
    fixture.state.running = false
    fixture.churn()
    selection.set(selectionView('v5'))
    expect(listener).toHaveBeenCalledTimes(3)
    expect(fixture.size()).toBe(0)
    expect(selection.size()).toBe(0)
  })

  it('notifies on an idle model-selection change, which no lifecycle field reflects', () => {
    const selection = face<unknown>(selectionView('v4'))
    const fixture = sessionFace(selection)
    const listener = vi.fn()
    const off = watchBudgetSession(fixture.session, listener)
    // The Session is completely idle: no running/blank/openState movement.
    selection.set(selectionView('v4-pro'))
    expect(listener).toHaveBeenCalledTimes(1)
    selection.set({
      lastUsed: { provider: 'deepseek', model: 'v4-pro' },
      next: { provider: 'deepseek', model: 'v4-pro', reasoningEffort: 'high' },
    })
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    selection.set(selectionView('v4'))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('ignores an unchanged selection republished under a newer watermark', () => {
    // `ProjectionValueStore.apply` notifies per accepted seq and hands out a
    // fresh object even when the durable selection is identical.
    const selection = face<unknown>(selectionView('flash'))
    const fixture = sessionFace(selection)
    const listener = vi.fn()
    const off = watchBudgetSession(fixture.session, listener)
    expect(listener).not.toHaveBeenCalled()
    selection.set(selectionView('flash'))
    selection.set(selectionView('flash'))
    expect(listener).not.toHaveBeenCalled()
    // A real change still refreshes exactly once.
    selection.set(selectionView('flash-pro'))
    expect(listener).toHaveBeenCalledTimes(1)
    off()
  })

  it('compares the durable selection fields, not the whole view object', () => {
    const selection = face<unknown>(selectionView('v4'))
    const fixture = sessionFace(selection)
    const listener = vi.fn()
    const off = watchBudgetSession(fixture.session, listener)
    // An unrelated field on the view object is not a selection change.
    selection.set({ ...selectionView('v4'), watermark: 42 })
    expect(listener).not.toHaveBeenCalled()
    // `reasoningEffort` is part of the official comparison.
    selection.set({
      lastUsed: { provider: 'deepseek', model: 'v4' },
      next: { provider: 'deepseek', model: 'v4', reasoningEffort: 'high' },
    })
    expect(listener).toHaveBeenCalledTimes(1)
    // `lastUsed` and `next` are compared independently.
    selection.set({
      lastUsed: { provider: 'deepseek', model: 'v4', reasoningEffort: 'high' },
      next: { provider: 'deepseek', model: 'v4', reasoningEffort: 'high' },
    })
    expect(listener).toHaveBeenCalledTimes(2)
    off()
  })

  it('refreshes once when the selection is removed and once when it returns', () => {
    const selection = face<unknown>(selectionView('v4'))
    const fixture = sessionFace(selection)
    const listener = vi.fn()
    const off = watchBudgetSession(fixture.session, listener)
    selection.set(undefined)
    expect(listener).toHaveBeenCalledTimes(1)
    // Staying absent is not a change.
    selection.set(undefined)
    expect(listener).toHaveBeenCalledTimes(1)
    selection.set(selectionView('v4'))
    expect(listener).toHaveBeenCalledTimes(2)
    selection.set({ lastUsed: null, next: null })
    expect(listener).toHaveBeenCalledTimes(3)
    off()
  })

  it('keys only the fields the official sameSelection comparison uses', () => {
    expect(modelSelectionKey(undefined)).toBe(modelSelectionKey(null))
    expect(modelSelectionKey(undefined)).not.toBe(modelSelectionKey({ lastUsed: null, next: null }))
    expect(modelSelectionKey(selectionView('v4'))).toBe(modelSelectionKey(selectionView('v4')))
    expect(modelSelectionKey(selectionView('v4'))).not.toBe(modelSelectionKey(selectionView('v5')))
    expect(
      modelSelectionKey({
        lastUsed: { provider: 'a', model: 'm' },
        next: { provider: 'a', model: 'm' },
      }),
    ).not.toBe(modelSelectionKey({ lastUsed: { provider: 'a', model: 'm' }, next: null }))
    expect(modelSelectionKey({ ...selectionView('v4'), watermark: 7 })).toBe(
      modelSelectionKey(selectionView('v4')),
    )
  })

  it('keeps working without a selection face instead of inventing a signal', () => {
    const state = { running: false, blank: false, openState: 'open' }
    const subscribers = new Set<() => void>()
    const session = {
      getSnapshot: () => state,
      subscribe: (callback: () => void) => {
        subscribers.add(callback)
        return () => {
          subscribers.delete(callback)
        }
      },
      projections: { faceOf: () => undefined as never },
    }
    const listener = vi.fn()
    const off = watchBudgetSession(session, listener)
    state.running = true
    subscribers.forEach((callback) => callback())
    expect(listener).toHaveBeenCalledTimes(1)
    off()
  })
})

describe('context-budget official wording', () => {
  it('states an unpublished policy as unknown instead of implying derived estimates', () => {
    expect(zh['warning.policy-unknown']).toContain('未知')
    expect(zh['warning.policy-unknown']).not.toContain('推导')
    expect(zh['warning.policy-unknown']).not.toContain('可能')
    expect(en['warning.policy-unknown']).toContain('unknown')
    expect(en['warning.policy-unknown']).not.toContain('derived')
    expect(en['warning.policy-unknown']).not.toContain('may be')
  })

  it('scopes the empty and unavailable hints instead of claiming every observation is missing', () => {
    // The empty hint speaks about this snapshot only.
    expect(zh.statusEmpty).toContain('本快照')
    expect(en.statusEmpty).toContain('This snapshot')
    // The unavailable-warning hint speaks about the read, not about the data.
    expect(zh['warning.read-unavailable']).toContain('部分观测')
    expect(en['warning.read-unavailable']).toContain('Some observations')
    for (const text of [
      zh.statusEmpty,
      zh['warning.read-unavailable'],
      en.statusEmpty,
      en['warning.read-unavailable'],
    ]) {
      expect(text).not.toContain('所有')
      expect(text).not.toContain('all ')
    }
    // An unknown source is labelled per figure, never as a global verdict.
    expect(zh.sourceAbsent).toBe('未提供')
    expect(en.sourceAbsent).toBe('Not provided')
    expect(zh.statusReloading).toContain('正在')
    expect(en.statusReloading).toContain('Re-reading')
  })

  it('names each observation after its real projection semantics', () => {
    // The latest *recorded* request, not a promise about the next one.
    expect(zh['metric.request-output-limit']).toContain('最近请求')
    expect(en['metric.request-output-limit']).toContain('Latest recorded request')
    // projectedTokens is the whole projected context, not the input share.
    expect(zh['metric.projected-input']).toContain('总')
    expect(zh['metric.projected-input']).toContain('估算')
    expect(zh['metric.projected-input']).not.toContain('输入')
    expect(en['metric.projected-input']).not.toContain('input')
    expect(en['metric.projected-input']).toContain('estimate')
    // pressureTokens anchors on provider usage; it is not an exact reading.
    expect(zh['metric.pressure']).toContain('用量锚定')
    expect(zh['metric.pressure']).not.toContain('压力')
    expect(en['metric.pressure']).toContain('anchored')
    // The note must not present an estimate as a measurement either.
    expect(zh.unitNote).toContain('估算')
    expect(zh.unitNote).toContain('不是精确')
    expect(en.unitNote).toContain('estimate')
  })
})
