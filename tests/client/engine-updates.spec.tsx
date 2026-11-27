import { JSDOM } from 'jsdom'
import { act, createElement, type ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => null,
  Menu: ({
    anchor,
    open,
    items,
    onSelect,
  }: {
    anchor: ReactNode
    open: boolean
    items: { id: string; label: string }[]
    onSelect(id: string): void
  }) =>
    createElement(
      'div',
      null,
      anchor,
      open &&
        items.map((item) =>
          createElement('button', { key: item.id, onClick: () => onSelect(item.id) }, item.label),
        ),
    ),
  Switch: ({
    checked,
    disabled,
    label,
    onChange,
  }: {
    checked: boolean
    disabled: boolean
    label: string
    onChange(value: boolean): void
  }) =>
    createElement('input', {
      type: 'checkbox',
      role: 'switch',
      'aria-label': label,
      checked,
      disabled,
      onChange: (e: { target: { checked: boolean } }) => onChange(e.target.checked),
    }),
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: { children?: ReactNode; variant?: string; size?: string } & Record<string, unknown>) =>
    createElement('button', { type: 'button', ...props }, children),
}))

it('checks without installing and submits only the selected available engines', async () => {
  const dom = new JSDOM('<div id="root"></div>')
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const { createRoot } = await import('react-dom/client')
  const { EngineUpdates } = await import('../../src/execution/client/EngineUpdates.tsx')
  const available = ['pi', 'kilo'].map((id) => ({
    id,
    name: id,
    status: 'available',
    current: '1',
    target: '2',
  }))
  let state = { enabled: true, mode: 'notify', checking: false, items: available.slice(0, 0) }
  const call = vi.fn(async (method: string, args?: object) => {
    if (method === 'engine-updates-check') state = { ...state, items: available }
    if (method === 'engine-updates-install')
      state = {
        ...state,
        ...{ selectedIds: ['kilo'] },
        items: [available[0]!, { ...available[1]!, status: 'installing' }],
      }
    if (method === 'engine-updates-settings') state = { ...state, ...args }
    return state
  })
  const container = dom.window.document.getElementById('root')!
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        createElement(EngineUpdates, {
          call: call as unknown as ExecutionCall,
          detectButton: null,
        }),
      ),
    )
    expect(container.querySelector('section')).toBeNull()
    await act(async () => container.querySelector('button')!.click())
    const findButton = (predicate: (button: HTMLButtonElement) => boolean) =>
      [...container.querySelectorAll<HTMLButtonElement>('section button')].find(predicate)!
    await act(async () => findButton((btn) => btn.textContent === '检查引擎更新').click())
    const checks = container.querySelectorAll<HTMLInputElement>('input:not([role="switch"])')
    expect(checks).toHaveLength(2)
    await act(async () => checks[0]!.click())
    expect(call.mock.calls.some(([method]) => method === 'engine-updates-install')).toBe(false)
    await act(async () =>
      findButton((btn) => Boolean(btn.textContent?.startsWith('更新所选'))).click(),
    )
    expect(call).toHaveBeenCalledWith('engine-updates-install', { ids: ['kilo'] })
    expect(container.querySelector('[aria-live]')?.textContent).toContain('正在安装')
    const modeSelect = container.querySelector<HTMLButtonElement>(
      '[data-opl-select="engine-update-mode"]',
    )!
    await act(async () => modeSelect.click())
    const autoOption = findButton((btn) => btn !== modeSelect && btn.textContent === '自动安装更新')
    await act(async () => autoOption.click())
    expect(call).toHaveBeenCalledWith('engine-updates-settings', { enabled: true, mode: 'auto' })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

it('renders engine updates immediately when embedded or when available updates arrive', async () => {
  const dom = new JSDOM('<div id="root"></div>')
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const { createRoot } = await import('react-dom/client')
  const { EngineUpdates } = await import('../../src/execution/client/EngineUpdates.tsx')
  const available = [
    {
      id: 'claude',
      name: 'Claude Code',
      status: 'available',
      current: '2.1.319',
      target: '2.1.332',
    },
  ]
  const call = vi.fn(async () => ({
    enabled: true,
    mode: 'notify',
    checking: false,
    items: available,
  }))
  const container = dom.window.document.getElementById('root')!
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        createElement(EngineUpdates, {
          call: call as unknown as ExecutionCall,
          embedded: true,
        }),
      ),
    )
    expect(container.querySelector('#opl-engine-updates-toggle')).toBeNull()
    expect(container.querySelector('#opl-engine-updates')).not.toBeNull()
    expect(container.textContent).toContain('Claude Code')
    expect(container.textContent).toContain('2.1.319 → 2.1.332')

    await act(async () =>
      root.render(
        createElement(EngineUpdates, {
          call: call as unknown as ExecutionCall,
          detectButton: null,
        }),
      ),
    )
    expect(container.querySelector('#opl-engine-updates')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

it('resolves localized engine update labels and falls back safely when the namespace is unregistered', async () => {
  const { resolveExecutionT } =
    await import('../../src/execution/client/execution-settings-locales.ts')

  const boundAvailable = resolveExecutionT({
    bind: () => ((key) => (key === 'engineUpdatesAutoLabel' ? 'Bound label' : key)) as never,
    getSnapshot: () => ({ active: 'en' }),
  })
  expect(boundAvailable('engineUpdatesAutoLabel')).toBe('Bound label')

  const missingZh = resolveExecutionT({
    bind: () => ((key) => key) as never,
    getSnapshot: () => ({ active: 'zh-CN' }),
  })
  expect(missingZh('engineUpdatesAutoLabel')).toBe('自动检查执行引擎更新')
  expect(missingZh('engineUpdatesInstallSelected', { count: 3 })).toBe('更新所选（3）')

  const missingEn = resolveExecutionT({
    bind: () => ((key) => key) as never,
    getSnapshot: () => ({ active: 'en' }),
  })
  expect(missingEn('engineUpdatesAutoLabel')).toBe('Automatically check engine updates')
  expect(missingEn('engineUpdatesInstallSelected', { count: 3 })).toBe('Update selected (3)')
})
