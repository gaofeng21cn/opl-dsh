import { createTestDom } from './dom.ts'
import { afterEach, expect, it, vi } from 'vitest'
import * as React from 'react'
import type { Root } from 'react-dom/client'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'
import type {
  MiniMaxIntegrationForm,
  MiniMaxIntegrationSettings,
} from '../../src/execution/client/MiniMaxIntegration.tsx'
import { minimaxAccountZh } from '../../src/execution/client/minimax-account-locales.ts'

const state = vi.hoisted(() => ({ catalogMounts: 0 }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement('button', props),
  IconChevronDownOutlineRegular: () => null,
  Menu: ({ anchor }: { anchor: React.ReactNode }) => React.createElement('div', null, anchor),
  Switch: ({
    label,
    checked,
    onChange,
    ...props
  }: {
    label: string
    checked: boolean
    onChange: (value: boolean) => void
  }) =>
    React.createElement(
      'button',
      {
        ...props,
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        onClick: () => onChange(!checked),
      },
      label,
    ),
}))
vi.mock('../../src/execution/client/MiniMaxAccountSection.tsx', () => ({
  MiniMaxAccountSection: () =>
    React.createElement('section', { 'data-opl-panel': 'minimax-account' }),
}))
vi.mock('../../src/execution/client/ExecutionCatalogSection.tsx', () => ({
  ExecutionCatalogSection: ({ refreshKey }: { refreshKey?: unknown }) => {
    React.useEffect(() => {
      state.catalogMounts += 1
    }, [])
    const [draft, setDraft] = React.useState('')
    return React.createElement('section', {
      'data-opl-panel': 'catalog',
      'data-opl-refresh-key': String(refreshKey),
      children: React.createElement(
        'button',
        { 'data-catalog-draft': 'true', onClick: () => setDraft('unsaved draft') },
        draft || 'empty draft',
      ),
    })
  },
}))
vi.mock('../../src/execution/client/ExecutionLimitsSection.tsx', () => ({
  ExecutionLimitsSection: () => null,
}))
vi.mock('../../src/execution/client/HarnessSettings.tsx', () => ({
  HarnessSettings: () => null,
}))

const dom = createTestDom()
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
proto['dispatchEvent'] = function (type: string) {
  const event = { type, target: this, bubbles: true, defaultPrevented: false }
  let node = this as { parentNode: object | null } | null
  while (node) {
    for (const listener of [...(listeners.get(node)?.get(type) ?? [])]) listener(event)
    node = node.parentNode
  }
  return true
}
proto['click'] = function () {
  return (this as { dispatchEvent: (type: string) => boolean }).dispatchEvent('click')
}

const { act } = React
const { createRoot } = await import('react-dom/client')
const { MiniMaxAccountGate } = await import('../../src/execution/client/MiniMaxIntegration.tsx')
const { ExecutionSettings } = await import('../../src/execution/client/ExecutionSettings.tsx')

type Snapshot = ConfigFormSnapshot<MiniMaxIntegrationSettings>
type Node = {
  nodeName: string
  textContent: string | null
  childNodes: Node[]
  parentNode: Node | null
  disabled?: boolean
  click: () => boolean
  getAttribute: (name: string) => string | null
}

function walk(node: unknown, into: Node[] = []): Node[] {
  const element = node as Node
  into.push(element)
  for (const child of element.childNodes ?? []) walk(child, into)
  return into
}

function switchControl(scope: unknown): Node {
  const control = walk(scope).find((node) => node.getAttribute?.('role') === 'switch')
  expect(control).toBeDefined()
  return control!
}

function accountCard(scope: unknown): boolean {
  return walk(scope).some((node) => node.getAttribute?.('data-opl-panel') === 'minimax-account')
}

function formFixture(initial: Snapshot) {
  let snapshot = initial
  let accepted = true
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of [...listeners]) listener()
  }
  const set = vi.fn(async (field: string, value: unknown) => {
    if (!accepted) return false
    snapshot = {
      ...snapshot,
      status: 'ready',
      value: { ...snapshot.value, [field]: value } as MiniMaxIntegrationSettings,
      revision: (snapshot.revision ?? 0) + 1,
    }
    emit()
    return true
  })
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set,
  } as unknown as MiniMaxIntegrationForm
  return {
    form,
    set,
    setAccepted(value: boolean) {
      accepted = value
    },
    publish(next: Snapshot) {
      snapshot = next
      emit()
    },
  }
}

const ready = (enabled: boolean, revision = 1): Snapshot => ({
  status: 'ready',
  value: { minimaxCodeEnabled: enabled },
  base: undefined,
  user: undefined,
  revision,
  writable: true,
})
const loading = (): Snapshot => ({
  status: 'loading',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
})
const t = (key: keyof typeof minimaxAccountZh) => minimaxAccountZh[key]
const call = vi.fn() as unknown as ExecutionCall
const roots: Root[] = []
afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount())
  })
  vi.clearAllMocks()
  state.catalogMounts = 0
})

async function render(children: React.ReactNode) {
  const container = dom.container()
  const root = createRoot(container as unknown as Element)
  roots.push(root)
  await act(async () => {
    root.render(children)
  })
  expect(walk(container).filter((node) => node.getAttribute?.('role') === 'switch')).toHaveLength(0)
  const edit = walk(container).find(
    (node) => node.getAttribute?.('data-opl-minimax-edit') !== null,
  )!
  expect(edit.getAttribute('aria-expanded')).toBe('false')
  await act(async () => {
    edit.click()
  })
  expect(edit.getAttribute('aria-expanded')).toBe('true')
  expect(edit.textContent).toBe(minimaxAccountZh.edit)
  return container
}

it('uses the accepted snapshot for save → readback → disable → re-enable', async () => {
  const fixture = formFixture(ready(true))
  const view = await render(
    React.createElement(MiniMaxAccountGate, { form: fixture.form, call, t }),
  )
  expect(accountCard(view)).toBe(true)
  expect(switchControl(view).getAttribute('aria-checked')).toBe('true')

  await act(async () => {
    switchControl(view).click()
  })
  expect(view.textContent).toContain(minimaxAccountZh.disabled)
  expect(fixture.set).toHaveBeenLastCalledWith('minimaxCodeEnabled', false)
  expect(switchControl(view).getAttribute('aria-checked')).toBe('false')
  expect(accountCard(view)).toBe(false)

  await act(async () => {
    switchControl(view).click()
  })
  expect(fixture.set).toHaveBeenLastCalledWith('minimaxCodeEnabled', true)
  expect(switchControl(view).getAttribute('aria-checked')).toBe('true')
  expect(accountCard(view)).toBe(true)
  const edit = walk(view).find((node) => node.getAttribute?.('data-opl-minimax-edit') !== null)!
  await act(async () => {
    edit.click()
  })
  expect(edit.textContent).toBe(minimaxAccountZh.edit)
  expect(edit.getAttribute('aria-expanded')).toBe('false')
  expect(accountCard(view)).toBe(false)
})

it('does not claim a refused save and keeps the accepted account state', async () => {
  const fixture = formFixture(ready(true))
  fixture.setAccepted(false)
  const view = await render(
    React.createElement(MiniMaxAccountGate, { form: fixture.form, call, t }),
  )
  await act(async () => {
    switchControl(view).click()
  })
  expect(fixture.set).toHaveBeenCalledWith('minimaxCodeEnabled', false)
  expect(switchControl(view).getAttribute('aria-checked')).toBe('true')
  expect(accountCard(view)).toBe(true)
  expect(walk(view).some((node) => node.getAttribute?.('role') === 'alert')).toBe(true)
  expect(view.textContent).toContain(minimaxAccountZh.integrationSaveFailed)
})

it('fails closed before the first snapshot and refreshes without discarding catalog drafts', async () => {
  const fixture = formFixture(loading())
  const view = await render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(ExecutionSettings, {
        call,
        minimax: { form: fixture.form, t },
      }),
      React.createElement(MiniMaxAccountGate, { form: fixture.form, call, t }),
    ),
  )
  expect(accountCard(view)).toBe(false)
  expect(switchControl(view).getAttribute('disabled')).not.toBeNull()
  expect(view.textContent).toContain(minimaxAccountZh.integrationLoading)
  expect(state.catalogMounts).toBe(1)
  const draft = walk(view).find((node) => node.getAttribute?.('data-catalog-draft') !== null)!
  await act(async () => {
    draft.click()
  })
  expect(draft.textContent).toBe('unsaved draft')

  await act(async () => {
    fixture.publish(ready(true, 2))
  })
  expect(accountCard(view)).toBe(true)
  expect(state.catalogMounts).toBe(1)
  expect(draft.textContent).toBe('unsaved draft')
  expect(walk(view).some((node) => node.getAttribute?.('data-opl-refresh-key') === 'true')).toBe(
    true,
  )

  await act(async () => {
    fixture.publish(ready(false, 3))
  })
  expect(accountCard(view)).toBe(false)
  expect(state.catalogMounts).toBe(1)
  expect(draft.textContent).toBe('unsaved draft')
  expect(walk(view).some((node) => node.getAttribute?.('data-opl-refresh-key') === 'false')).toBe(
    true,
  )
  await act(async () => {
    fixture.publish(ready(true, 4))
  })
  expect(accountCard(view)).toBe(true)
  expect(state.catalogMounts).toBe(1)
  expect(draft.textContent).toBe('unsaved draft')
})

it('shows saving feedback, prevents duplicate writes and reports a rejected transport', async () => {
  const fixture = formFixture(ready(true))
  const pending = Promise.withResolvers<boolean>()
  fixture.set.mockImplementation(() => pending.promise)
  const view = await render(
    React.createElement(MiniMaxAccountGate, { form: fixture.form, call, t }),
  )
  await act(async () => {
    switchControl(view).click()
  })
  expect(fixture.set).toHaveBeenCalledTimes(1)
  expect(switchControl(view).getAttribute('disabled')).not.toBeNull()
  expect(view.textContent).toContain(minimaxAccountZh.integrationSaving)
  await act(async () => {
    switchControl(view).click()
  })
  expect(fixture.set).toHaveBeenCalledTimes(1)

  await act(async () => {
    pending.reject(new Error('transport failed'))
  })
  expect(view.textContent).toContain(minimaxAccountZh.integrationSaveFailed)
  expect(switchControl(view).getAttribute('aria-checked')).toBe('true')
  expect(switchControl(view).getAttribute('disabled')).toBeNull()
  expect(accountCard(view)).toBe(true)
})

it('explains unavailable and read-only settings while following external snapshots', async () => {
  const fixture = formFixture({ ...loading(), status: 'unavailable' })
  const view = await render(
    React.createElement(MiniMaxAccountGate, { form: fixture.form, call, t }),
  )
  expect(view.textContent).toContain(minimaxAccountZh.integrationUnavailable)
  expect(accountCard(view)).toBe(false)

  await act(async () => {
    fixture.publish({ ...ready(true, 2), writable: false })
  })
  expect(view.textContent).toContain(minimaxAccountZh.integrationReadOnly)
  expect(switchControl(view).getAttribute('disabled')).not.toBeNull()
  expect(accountCard(view)).toBe(true)
})
