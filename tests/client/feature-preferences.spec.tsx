// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  FeatureSwitch,
  SuiteFeaturePreferences,
  labels,
} from '../../src/shared/client/FeaturePreferences.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => null,
  Menu: ({ anchor }: { anchor: React.ReactNode }) => createElement('div', null, anchor),
  Switch: (props: {
    label: string
    checked: boolean
    disabled?: boolean
    onChange: (value: boolean) => void
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        disabled: props.disabled,
        'aria-pressed': props.checked,
        onClick: () => props.onChange(!props.checked),
      },
      props.label,
    ),
}))

function fixture() {
  let snapshot: ConfigFormSnapshot<{ enhancedConversationStats: boolean }> = {
    status: 'ready',
    value: { enhancedConversationStats: false },
    base: {},
    user: {},
    revision: 1,
    writable: true,
  }
  const listeners = new Set<() => void>()
  const set = vi.fn(async (_field: string, value: unknown) => {
    snapshot = { ...snapshot, value: { enhancedConversationStats: value === true }, revision: 2 }
    for (const listener of listeners) listener()
    return true
  })
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set,
    mutate: vi.fn(),
    unset: vi.fn(),
  } as unknown as ConfigForm<{ enhancedConversationStats: boolean }>
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() =>
    root.render(
      createElement(FeatureSwitch, {
        form,
        field: 'enhancedConversationStats',
        title: 'Enhanced todo',
        description: 'Optional',
        saveFailed: labels.zh.saveFailed,
      }),
    ),
  )
  return { form, set, container, root }
}

afterEach(() => document.body.replaceChildren())

describe('suite feature preference', () => {
  it('starts disabled and persists through the existing config owner', async () => {
    const f = fixture()
    const button = f.container.querySelector('button')!
    expect(button.textContent).toBe('Enhanced todo')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    await act(async () => button.click())
    expect(f.set).toHaveBeenCalledExactlyOnceWith('enhancedConversationStats', true)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    act(() => f.root.unmount())
  })

  it('keeps the scope selector as the only row in the feature group', () => {
    let snapshot: ConfigFormSnapshot<{ conversationStats: 'current' | 'history' }> = {
      status: 'ready',
      value: { conversationStats: 'history' },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    }
    const listeners = new Set<() => void>()
    const form = {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set: vi.fn(async (field: string, value: unknown) => {
        snapshot = {
          ...snapshot,
          value: { ...snapshot.value!, [field]: value as 'current' | 'history' },
          revision: snapshot.revision + 1,
        }
        for (const listener of listeners) listener()
        return true
      }),
      mutate: vi.fn(),
      unset: vi.fn(),
    } as unknown as ConfigForm<{ conversationStats: 'current' | 'history' }>
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() =>
      root.render(
        createElement(SuiteFeaturePreferences, {
          form,
          t: (key: keyof typeof labels.zh) => labels.zh[key],
        }),
      ),
    )
    const group = container.querySelector('[data-opl-preference="suite-features"]')!
    expect(group.querySelector('[data-opl-preference="conversation-counts"]')).not.toBeNull()
    expect(group.textContent).toContain('轮次与步数')
    expect(group.textContent).toContain('历史累计')
    act(() => root.unmount())
  })
})
