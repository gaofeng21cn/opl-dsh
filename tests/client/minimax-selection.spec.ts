/**
 * Menu labels for the two official MiniMax Code combinations.
 *
 * These tests render the real `CombinationSelect` in the same minimal DOM as the
 * sibling projection spec and drive it only through the public surface the
 * desktop uses: the OPL RPC call and the official selection projection face.
 *
 * They pin the product decision that a model row is one model name plus one
 * Harness — never a name that already carries the Harness and a pinned thinking
 * tier — and that a model whose only reasoning control is thinking on/off is
 * presented as a switch rather than as an "推理强度" ladder. M3.1 keeps the real
 * effort levels and sends the official id for each one.
 */
import { createTestDom } from './dom.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import type { ReactNode } from 'react'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'
import { displayModelName } from '../../src/shared/models.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  // The published primitives package is not loadable from this offline install
  // (it needs `clsx`), so the atoms the button uses are stood in for by
  // pass-through elements. Nothing under test lives inside them.
  IconCheckOutlineRegular: () => null,
  IconChevronDownOutlineRegular: () => null,
  IconChevronRightOutlineRegular: () => null,
  StateDot: () => null,
  MenuSurface: React.forwardRef(function MenuSurface(
    props: { children?: ReactNode; role?: string; 'aria-label'?: string },
    ref: React.ForwardedRef<HTMLDivElement>,
  ) {
    return React.createElement('div', { ...props, ref })
  }),
}))

// `./dom.ts` installs the process DOM on import, before React DOM is loaded.
const dom = createTestDom()

const { act } = React
const { CombinationSelect } = await import('../../src/execution/client/CombinationSelect.tsx')
const { createRoot } = await import('react-dom/client')

const PROVIDER = 'minimax-official'
const HARNESS = 'minimax-code'
const HARNESS_NAME = 'MiniMax Code'
const M3_FLASH = 'MiniMax-M3.1-Flash-Preview'
const M3 = 'MiniMax-M3'

const flashCombination = {
  id: `${HARNESS}/${M3_FLASH}`,
  name: `${M3_FLASH} + ${HARNESS_NAME}`,
  enabled: true,
  isDefault: true,
  modelRef: { provider: PROVIDER, model: M3_FLASH },
  harnessRef: HARNESS,
  permissionPolicy: 'full-access',
}
const m3Combination = {
  ...flashCombination,
  id: `${HARNESS}/${M3}`,
  name: `${M3} + ${HARNESS_NAME}`,
  isDefault: false,
  modelRef: { provider: PROVIDER, model: M3 },
}

/**
 * The catalogue as the Host projects it: model names are the bare official model
 * name, and the Harness is carried separately by the combination.
 */
const catalog = {
  models: [
    {
      ref: { provider: PROVIDER, model: M3_FLASH },
      name: displayModelName({ provider: PROVIDER, model: M3_FLASH }),
      source: 'MiniMax 官方账号（mcode）',
      available: true,
    },
    {
      ref: { provider: PROVIDER, model: M3 },
      name: displayModelName({ provider: PROVIDER, model: M3 }),
      source: 'MiniMax 官方账号（mcode）',
      available: true,
    },
  ],
  harnesses: [{ id: HARNESS, name: HARNESS_NAME, available: true }],
  combinations: [flashCombination, m3Combination],
}

/**
 * Reasoning catalogues as the official Host advertises them: M3.1 offers real
 * effort levels, M3 offers a thinking on/off switch and no strength level.
 */
const flashReasoning = {
  defaultEffort: 'max',
  efforts: [
    { id: 'default', name: '默认' },
    { id: 'low', name: '低' },
    { id: 'xhigh', name: '极高' },
    { id: 'medium', name: '中' },
    { id: 'high', name: '高' },
    { id: 'max', name: '最大' },
  ],
}
const m3Reasoning = {
  defaultEffort: 'on',
  efforts: [
    { id: 'on', name: '开启思考' },
    { id: 'off', name: '关闭思考' },
  ],
}
const groups = [
  {
    id: PROVIDER,
    name: 'MiniMax 官方账号（mcode）',
    models: [
      { id: M3_FLASH, name: M3_FLASH, reasoning: flashReasoning },
      { id: M3, name: M3, reasoning: m3Reasoning },
    ],
  },
]

/** Official per-Session projection face: holds the pushed value and its subscribers. */
function createFace(initial: ModelSelectionProjection) {
  let value = initial
  const subscribed = new Set<() => void>()
  return {
    face: {
      getSnapshot: () => value,
      subscribe: (listener: () => void) => {
        subscribed.add(listener)
        return () => subscribed.delete(listener)
      },
    },
    /** Push one finished projection value, exactly as the control stream does. */
    push(next: ModelSelectionProjection) {
      value = next
      for (const listener of [...subscribed]) listener()
    },
  }
}

type Calls = { method: string; args: unknown }[]

/**
 * RPC stub over the two fixed combinations. `model-selection` answers with the
 * selection the test installs, so a `select-effort` call is observable exactly
 * as the desktop sends it.
 */
function fixture(initial: { model: string; reasoningEffort?: string }) {
  const calls: Calls = []
  let current = {
    provider: PROVIDER,
    model: initial.model,
    ...(initial.reasoningEffort === undefined ? {} : { reasoningEffort: initial.reasoningEffort }),
  }
  const call = (async (method: string, args?: unknown) => {
    calls.push({ method, args })
    if (method === 'catalog') return catalog
    if (method === 'combinations')
      return catalog.combinations.map((item) => ({ id: item.id, available: true }))
    if (method === 'select-effort') {
      const input = args as { reasoningEffort?: string }
      current = {
        ...current,
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      }
      return undefined
    }
    if (method === 'model-selection')
      return {
        current: { ...current },
        groups,
        combination: `${HARNESS}/${current.model}`,
      }
    throw new Error(`unexpected RPC ${method}`)
  }) as unknown as ExecutionCall
  return { call, calls }
}

const mounted: Array<() => Promise<void>> = []
afterEach(async () => {
  while (mounted.length) await mounted.pop()!()
})

/** Mount the real component against the projection face, as the desktop does. */
async function mount(props: { call: ExecutionCall; source: () => unknown; sessionId?: string }) {
  const container = dom.container()
  const root = createRoot(container as unknown as Element)
  mounted.push(() =>
    act(async () => {
      root.unmount()
    }),
  )
  const sessionId = props.sessionId ?? 'session-1'
  await act(async () => {
    root.render(
      React.createElement(CombinationSelect as never, {
        call: props.call,
        sessionId,
        locked: false,
        available: true,
        selectionSource: (id: string) => (id === sessionId ? props.source() : undefined),
      }),
    )
  })
  const trigger = container.childNodes[0]?.childNodes[0] as ShimButton
  // The menu is portaled onto the global document body, so menu reads start there.
  const menuRoot = (globalThis as unknown as { document: { body: ShimNode } }).document.body
  const menuText = () => menuRoot.textContent ?? ''
  /** Every rendered button, trigger and menu item alike, in document order. */
  const buttons = () =>
    collect(menuRoot).filter(
      (node) => (node as unknown as { nodeName: string }).nodeName === 'BUTTON',
    ) as ShimButton[]
  return {
    container,
    trigger,
    buttons,
    menuText,
    open: async () => {
      await act(async () => {
        trigger.click()
      })
    },
    click: async (label: string) => {
      const target =
        buttons().find((button) => button.textContent === label) ??
        buttons().find((button) => (button.textContent ?? '').startsWith(label))
      expect(target, `找不到可点击项「${label}」`).toBeDefined()
      await act(async () => {
        target!.click()
      })
    },
    push: async (next: ModelSelectionProjection) => {
      await act(async () => {
        ;(props.source() as { push: (value: ModelSelectionProjection) => void }).push(next)
      })
    },
  }
}

type ShimButton = {
  click: () => void
  textContent: string | null
  childNodes: ShimNode[]
  attributes: Map<string, string>
  getAttribute(name: string): string | null
}

type ShimNode = {
  click: () => void
  textContent: string | null
  childNodes: ShimNode[]
  parentNode: ShimNode | null
  attributes: Map<string, string>
  getAttribute(name: string): string | null
}

function collect(node: ShimNode, into: ShimNode[] = []): ShimNode[] {
  into.push(node)
  for (const child of node.childNodes ?? []) collect(child, into)
  return into
}

/** Count how many times a fragment occurs, so a duplicated Harness is detectable. */
const occurrences = (text: string, fragment: string): number => text.split(fragment).length - 1

/**
 * Give the shared DOM shim a working click path.
 *
 * `dom.ts` deliberately models no event dispatch — the projection spec never needs
 * one — but opening this menu and choosing a reasoning setting is a click
 * interaction, so this file teaches the shim's element prototype to register and
 * bubble listeners. Only the elements created by the process DOM are touched, and
 * no component or production code changes.
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
  const dispatch = function (type: string, target: object) {
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
    let node = target as { parentNode: object | null } | null
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
enableClick(dom)

describe('MiniMax Code model menu labels', () => {
  it('shows one model name and one Harness, with no pinned tier in the name', async () => {
    const { call } = fixture({ model: M3_FLASH, reasoningEffort: 'max' })
    const face = createFace({
      lastUsed: null,
      next: { provider: PROVIDER, model: M3_FLASH, reasoningEffort: 'max' },
    })
    const view = await mount({ call, source: () => Object.assign(face.face, { push: face.push }) })

    // The trigger reads model + Harness exactly once.
    expect(view.trigger.textContent).toContain(`${M3_FLASH} · ${HARNESS_NAME}`)
    expect(occurrences(view.trigger.textContent ?? '', HARNESS_NAME)).toBe(1)

    await view.open()
    await view.click('模型')
    const open = view.menuText()
    for (const model of [M3_FLASH, M3]) {
      const row = `${model} · ${HARNESS_NAME}`
      expect(open, `缺少模型行 ${row}`).toContain(row)
      expect(occurrences(open, row), `模型行 ${row} 重复`).toBe(1)
    }
    // No Harness is ever appended twice, and no fixed thinking tier rides along
    // in a model name.
    expect(occurrences(open, `${HARNESS_NAME} · ${HARNESS_NAME}`)).toBe(0)
    for (const tier of ['（max）', '（thinking）', '（思考 max）', '（思考）'])
      expect(open, `模型名仍带固定档位 ${tier}`).not.toContain(tier)
  })

  it('keeps an unavailable registered combination visible with its reason', async () => {
    const zcode = {
      id: 'zcode/glm-5.2',
      name: 'glm-5.2 + ZCode',
      enabled: true,
      isDefault: false,
      modelRef: { provider: 'huawei-maas', model: 'glm-5.2' },
      harnessRef: 'zcode',
      permissionPolicy: 'full-access',
    }
    const call = (async (method: string) => {
      if (method === 'catalog')
        return {
          ...catalog,
          models: [
            ...catalog.models,
            {
              ref: zcode.modelRef,
              name: 'GLM-5.2',
              source: 'Huawei MaaS',
              available: false,
            },
          ],
          harnesses: [...catalog.harnesses, { id: 'zcode', name: 'ZCode', available: false }],
          combinations: [...catalog.combinations, zcode],
        }
      if (method === 'combinations')
        return [
          ...catalog.combinations.map((item) => ({ id: item.id, available: true })),
          { id: zcode.id, available: false, reason: '未找到官方 ZCode CLI，请先安装' },
        ]
      if (method === 'model-selection')
        return {
          current: { provider: PROVIDER, model: M3_FLASH, reasoningEffort: 'max' },
          groups,
          combination: flashCombination.id,
        }
      throw new Error(`unexpected RPC ${method}`)
    }) as unknown as ExecutionCall
    const face = createFace({
      lastUsed: null,
      next: { provider: PROVIDER, model: M3_FLASH, reasoningEffort: 'max' },
    })
    const view = await mount({ call, source: () => Object.assign(face.face, { push: face.push }) })
    await view.open()
    await view.click('模型')
    expect(view.menuText()).toContain('GLM-5.2 · ZCode')
    expect(view.menuText()).toContain('未就绪：未找到官方 ZCode CLI，请先安装')
    const row = view
      .buttons()
      .find((button) => (button.textContent ?? '').includes('GLM-5.2 · ZCode'))
    expect(row?.getAttribute('disabled')).toBe('')
  })

  it('keeps the shared model name free of Harness and thinking text', () => {
    expect(displayModelName({ provider: PROVIDER, model: M3_FLASH })).toBe(M3_FLASH)
    expect(displayModelName({ provider: PROVIDER, model: M3 })).toBe(M3)
    for (const ref of [
      { provider: PROVIDER, model: M3_FLASH },
      { provider: PROVIDER, model: M3 },
    ]) {
      const name = displayModelName(ref)
      expect(name).not.toContain(HARNESS_NAME)
      expect(name).not.toMatch(/[（(]|思考|max|thinking/)
    }
  })

  it('presents M3 thinking as a switch, not as a reasoning-strength ladder', async () => {
    const { call, calls } = fixture({ model: M3, reasoningEffort: 'on' })
    const face = createFace({
      lastUsed: null,
      next: { provider: PROVIDER, model: M3, reasoningEffort: 'on' },
    })
    const view = await mount({ call, source: () => Object.assign(face.face, { push: face.push }) })
    expect(view.trigger.textContent).toContain(`${M3} · ${HARNESS_NAME}`)
    expect(view.trigger.textContent).toContain('开启思考')

    await view.open()
    await view.click('思考')
    const open = view.menuText()
    // A switch, labeled by its state — never "推理强度" with on/off levels.
    expect(open).toContain('思考')
    expect(open).not.toContain('推理强度')
    expect(open).toContain('开启思考')
    expect(open).toContain('关闭思考')
    // The switch reads as on while thinking is enabled.
    const onSwitch = view
      .buttons()
      .find((button) => (button.textContent ?? '').includes('开启思考'))
    expect(onSwitch?.getAttribute('aria-checked')).toBe('true')

    // Choosing 关闭思考 sends that exact official effort id.
    await view.click('关闭思考')
    const sent = calls.filter((entry) => entry.method === 'select-effort').at(-1)
    expect(sent?.args).toMatchObject({
      sessionId: 'session-1',
      provider: PROVIDER,
      model: M3,
      reasoningEffort: 'off',
    })

    // The pushed projection, not the local guess, drives the top summary.
    await view.push({
      lastUsed: { provider: PROVIDER, model: M3, reasoningEffort: 'off' },
      next: { provider: PROVIDER, model: M3, reasoningEffort: 'off' },
    })
    expect(view.trigger.textContent).toContain('关闭思考')
    expect(view.trigger.textContent).not.toContain('开启思考')
  })

  it('keeps the real M3.1 effort levels and sends the official id for each', async () => {
    const { call, calls } = fixture({ model: M3_FLASH, reasoningEffort: 'max' })
    const face = createFace({
      lastUsed: null,
      next: { provider: PROVIDER, model: M3_FLASH, reasoningEffort: 'max' },
    })
    const view = await mount({ call, source: () => Object.assign(face.face, { push: face.push }) })
    expect(view.trigger.textContent).toContain('最大')

    for (const [label, effort] of [
      ['高', 'high'],
      ['中', 'medium'],
      ['最大', 'max'],
      ['低', 'low'],
      ['极高', 'xhigh'],
    ] as const) {
      await view.open()
      await view.click('推理强度')
      expect(view.menuText()).not.toContain('默认')
      expect(view.menuText()).not.toContain('由 CLI 决定')
      await view.click(label)
      const sent = calls.filter((entry) => entry.method === 'select-effort').at(-1)
      expect(sent?.args, `选择 ${label} 未发送官方 effort id`).toMatchObject({
        provider: PROVIDER,
        model: M3_FLASH,
        reasoningEffort: effort,
      })
      // The summary follows the real selection without needing a reopen.
      await view.push({
        lastUsed: null,
        next: { provider: PROVIDER, model: M3_FLASH, reasoningEffort: effort },
      })
      expect(view.trigger.textContent).toContain(label)
    }

    // M3.1 keeps a ladder, so its own control is still named 推理强度.
    await view.open()
    expect(view.menuText()).toContain('推理强度')
  })

  it('does not leak one Session selection into another', async () => {
    const first = fixture({ model: M3, reasoningEffort: 'on' })
    const second = fixture({ model: M3_FLASH, reasoningEffort: 'max' })
    const mine = createFace({
      lastUsed: null,
      next: { provider: PROVIDER, model: M3, reasoningEffort: 'on' },
    })
    const view = await mount({ call: first.call, source: () => mine.face })
    expect(view.trigger.textContent).toContain(`${M3} · ${HARNESS_NAME}`)
    expect(view.trigger.textContent).toContain('开启思考')

    // The other Session resolves to the other model; this view keeps its own.
    const other = fixture({ model: M3_FLASH, reasoningEffort: 'max' })
    expect(other.calls).toEqual([])
    expect(view.trigger.textContent).not.toContain(M3_FLASH)
  })
})
