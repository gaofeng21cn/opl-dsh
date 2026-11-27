import { createTestDom } from './dom.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import type { ReactNode } from 'react'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCheckOutlineRegular: () => null,
  IconChevronDownOutlineRegular: () => null,
  IconChevronRightOutlineRegular: () => null,
  MenuGroup: ({ label, children }: { label: string; children: ReactNode }) =>
    React.createElement('section', { role: 'group', 'aria-label': label }, label, children),
  StateDot: () => null,
  MenuSurface: React.forwardRef(function MenuSurface(
    props: { children?: ReactNode; role?: string; 'aria-label'?: string },
    ref: React.ForwardedRef<HTMLDivElement>,
  ) {
    return React.createElement('div', { ...props, ref })
  }),
}))

const dom = createTestDom()
const { act } = React
const { OfficialCombinationOption, OfficialCombinationPane } =
  await import('../../src/execution/client/CombinationSelect.tsx')
const { createRoot } = await import('react-dom/client')

type ShimNode = {
  nodeName: string
  textContent: string | null
  childNodes: ShimNode[]
  parentNode: ShimNode | null
  getAttribute?: (name: string) => string | null
  click?: () => boolean
}

function completeDom() {
  const listeners = new WeakMap<object, Map<string, Set<(event: unknown) => void>>>()
  const addListener = function (this: object, type: string, listener: (event: unknown) => void) {
    let byType = listeners.get(this)
    if (!byType) listeners.set(this, (byType = new Map()))
    const set = byType.get(type) ?? new Set()
    set.add(listener)
    byType.set(type, set)
  }
  const proto = Object.getPrototypeOf(dom.document.createElement('div')) as Record<string, unknown>
  const docProto = Object.getPrototypeOf(dom.document) as Record<string, unknown>
  proto['addEventListener'] = addListener
  docProto['addEventListener'] = addListener
  proto['click'] = function () {
    const event = {
      type: 'click',
      target: this,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      timeStamp: 0,
      eventPhase: 2,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    }
    let node = this as { parentNode: object | null } | null
    while (node) {
      for (const listener of [...(listeners.get(node)?.get('click') ?? [])]) listener(event)
      node = node.parentNode
    }
    return true
  }
}

completeDom()

function walk(root: ShimNode): ShimNode[] {
  const result: ShimNode[] = [root]
  for (const child of root.childNodes ?? []) result.push(...walk(child))
  return result
}

const mounted: Array<() => Promise<void>> = []
afterEach(async () => {
  while (mounted.length) await mounted.pop()!()
})

const GPT5 = { provider: 'opl-gateway', model: 'codex::gpt-5' }
const DEEPSEEK = { provider: 'opl-gateway', model: 'deepseek-flash' }

function baseCatalog(modelRef = GPT5) {
  return {
    version: 2 as const,
    models: [
      {
        ref: modelRef,
        name: modelRef.model === GPT5.model ? 'GPT-5' : 'DeepSeek Flash',
        source: 'OPL Gateway',
        available: true,
      },
    ],
    harnesses: [
      { id: 'dsh', name: 'DSH', kind: 'dsh' as const },
      { id: 'codex', name: 'Codex CLI', kind: 'acp' as const, command: 'codex' },
      { id: 'opencode', name: 'OpenCode', kind: 'acp' as const, command: 'opencode' },
      { id: 'custom-acp', name: 'Custom ACP', kind: 'acp' as const, command: 'custom-acp' },
    ],
    combinations:
      modelRef.model === DEEPSEEK.model
        ? [
            {
              id: 'auto:opl-gateway:deepseek-flash',
              name: 'DeepSeek Flash + DSH',
              modelRef: DEEPSEEK,
              harnessRef: 'dsh',
              permissionPolicy: 'read-only' as const,
              isDefault: true,
              enabled: true,
              generated: true,
            },
          ]
        : [],
    supportedPairings: [
      {
        modelRef,
        harnessRefs:
          modelRef.model === DEEPSEEK.model ? ['dsh', 'opencode', 'custom-acp'] : ['codex', 'dsh'],
      },
    ],
  }
}

function faceFor(initial: ModelSelectionProjection) {
  return {
    getSnapshot: () => initial,
    subscribe: () => () => {},
  }
}

async function mountOption(call: ExecutionCall, initial: ModelSelectionProjection) {
  const container = dom.container() as unknown as ShimNode
  const root = createRoot(container as unknown as Element)
  mounted.push(() => act(async () => root.unmount()))
  const openPane = vi.fn()
  await act(async () => {
    root.render(
      React.createElement(OfficialCombinationOption as never, {
        locked: false,
        openPane,
        call,
        sessionId: 's-1',
        available: true,
        selectionSource: () => faceFor(initial),
      }),
    )
  })
  return { container, text: () => container.textContent ?? '', openPane }
}

async function mountPane(call: ExecutionCall, initial: ModelSelectionProjection) {
  const container = dom.container() as unknown as ShimNode
  const root = createRoot(container as unknown as Element)
  mounted.push(() => act(async () => root.unmount()))
  const dismiss = vi.fn()
  await act(async () => {
    root.render(
      React.createElement(OfficialCombinationPane as never, {
        call,
        sessionId: 's-1',
        locked: false,
        dismiss,
        reportFailure: vi.fn(),
        loadingLabel: '加载中…',
        selectionSource: () => faceFor(initial),
      }),
    )
  })
  return {
    container,
    text: () => container.textContent ?? '',
    dismiss,
    findByAttr: (attr: string, value: string) =>
      walk(container).find((node) => node.getAttribute?.(attr) === value),
    buttons: () => walk(container).filter((node) => node.nodeName === 'BUTTON'),
  }
}

describe('official model menu option and in-place engine pane', () => {
  it('keeps the engine option visible with missing-default summary when Codex is uninstalled', async () => {
    const cat = baseCatalog(GPT5)
    const call = (async (method: string) => {
      if (method === 'catalog') return cat
      if (method === 'combinations') return []
      if (method === 'model-selection') return { current: GPT5, groups: [] }
      throw Error('unexpected rpc ' + method)
    }) as unknown as ExecutionCall
    const view = await mountOption(call, { lastUsed: null, next: GPT5 })
    expect(view.text()).toContain('执行引擎')
    expect(view.text()).toContain('Codex CLI（未安装）')
  })

  it('shows gentle missing-default hint, available DSH, and one-click install button inside pane', async () => {
    const calls: Array<{ method: string; args?: unknown }> = []
    const cat = baseCatalog(GPT5)
    const call = (async (method: string, args?: unknown) => {
      calls.push({ method, args })
      if (method === 'catalog') return cat
      if (method === 'combinations') return []
      if (method === 'model-selection') return { current: GPT5, groups: [] }
      if (method === 'harness-installations')
        return [
          {
            id: 'dsh',
            name: 'DSH',
            installed: true,
            runnable: true,
            instructions: '',
            website: '',
          },
          {
            id: 'codex',
            name: 'Codex CLI',
            installed: false,
            runnable: false,
            maintenanceAction: 'install',
            instructions: '',
            website: '',
          },
        ]
      if (method === 'harness-update') return null
      throw Error('unexpected rpc ' + method)
    }) as unknown as ExecutionCall
    const view = await mountPane(call, { lastUsed: null, next: GPT5 })
    expect(view.findByAttr('data-opl-missing-default-hint', 'codex')?.textContent).toContain(
      'Codex CLI',
    )
    const dshButton = view
      .buttons()
      .find(
        (btn) => btn.getAttribute?.('role') === 'menuitemradio' && btn.textContent?.includes('DSH'),
      )!
    expect(dshButton).toBeTruthy()
    const installButton = view.findByAttr('data-opl-install-harness', 'codex')!
    expect(installButton.textContent).toContain('一键安装')
    await act(async () => {
      installButton.click?.()
    })
    expect(calls).toContainEqual({ method: 'harness-update', args: { id: 'codex' } })
  })

  it('switches to any compatible engine in place via select-model-harness and promotes default on demand', async () => {
    const calls: Array<{ method: string; args?: unknown }> = []
    let boundCombination = 'auto:opl-gateway:deepseek-flash'
    let cat = baseCatalog(DEEPSEEK)
    const call = (async (method: string, args?: unknown) => {
      calls.push({ method, args })
      if (method === 'catalog') return cat
      if (method === 'combinations')
        return cat.combinations.map((c) => ({ id: c.id, available: true }))
      if (method === 'model-selection')
        return { current: DEEPSEEK, groups: [], combination: boundCombination }
      if (method === 'harness-installations')
        return [
          {
            id: 'dsh',
            name: 'DSH',
            installed: true,
            runnable: true,
            instructions: '',
            website: '',
          },
          {
            id: 'opencode',
            name: 'OpenCode',
            installed: true,
            runnable: true,
            instructions: '',
            website: '',
          },
          {
            id: 'custom-acp',
            name: 'Custom ACP',
            installed: true,
            runnable: true,
            instructions: '',
            website: '',
          },
        ]
      if (method === 'select-model-harness') {
        const input = args as { harnessRef: string; setAsDefault?: boolean }
        const comboId = `custom:${input.harnessRef}:opl-gateway:deepseek-flash`
        if (!cat.combinations.some((c) => c.id === comboId)) {
          cat = {
            ...cat,
            combinations: [
              ...cat.combinations,
              {
                id: comboId,
                name: 'DeepSeek Flash + OpenCode',
                modelRef: DEEPSEEK,
                harnessRef: input.harnessRef,
                permissionPolicy: 'full-access',
                isDefault: !!input.setAsDefault,
                enabled: true,
                generated: false,
              },
            ],
          }
        } else if (input.setAsDefault) {
          cat = {
            ...cat,
            combinations: cat.combinations.map((c) => ({
              ...c,
              isDefault: c.id === comboId,
            })),
          }
        }
        boundCombination = comboId
        return { kind: 'external', sessionId: 's-1', combination: comboId }
      }
      throw Error('unexpected rpc ' + method)
    }) as unknown as ExecutionCall

    const view = await mountPane(call, { lastUsed: null, next: DEEPSEEK })
    const openCodeBtn = view
      .buttons()
      .find(
        (btn) =>
          btn.getAttribute?.('role') === 'menuitemradio' && btn.textContent?.includes('OpenCode'),
      )!
    expect(openCodeBtn).toBeTruthy()
    await act(async () => {
      openCodeBtn.click?.()
    })
    expect(calls).toContainEqual({
      method: 'select-model-harness',
      args: { sessionId: 's-1', modelRef: DEEPSEEK, harnessRef: 'opencode' },
    })
    expect(view.dismiss).toHaveBeenCalled()

    const setDefaultBtn = view.findByAttr('data-opl-set-default-harness', 'opencode')!
    expect(setDefaultBtn).toBeTruthy()
    await act(async () => {
      setDefaultBtn.click?.()
    })
    expect(calls).toContainEqual({
      method: 'select-model-harness',
      args: { sessionId: 's-1', modelRef: DEEPSEEK, harnessRef: 'opencode', setAsDefault: true },
    })
  })
})
