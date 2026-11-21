import { JSDOM } from 'jsdom'
import { act, createElement, type ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
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
  Button: ({ children, ...props }: { children?: ReactNode }) =>
    createElement('button', props, children),
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
    await act(async () => container.querySelector('section button')!.click())
    const checks = container.querySelectorAll<HTMLInputElement>('input:not([role="switch"])')
    expect(checks).toHaveLength(2)
    await act(async () => checks[0]!.click())
    expect(call.mock.calls.some(([method]) => method === 'engine-updates-install')).toBe(false)
    await act(async () => container.querySelectorAll('section button')[1]!.click())
    expect(call).toHaveBeenCalledWith('engine-updates-install', { ids: ['kilo'] })
    expect(container.querySelector('[aria-live]')?.textContent).toContain('正在安装')
    const select = container.querySelector('select')!
    await act(async () => {
      select.value = 'auto'
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    expect(call).toHaveBeenCalledWith('engine-updates-settings', { enabled: true, mode: 'auto' })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
