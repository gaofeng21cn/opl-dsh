import { describe, expect, it } from 'vitest'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { apply } from '../../src/compat/client/settings-navigation.ts'
import {
  settingsNavigationEn,
  settingsNavigationZh,
} from '../../src/shared/client/settings-navigation.ts'

/** Exercise the same mutable metadata and subscription face consumed by the official shell. */
function fixture(entries: StoredEntry[]) {
  const effects: (() => void)[] = []
  const listeners = new Set<() => void>()
  let locale: 'zh' | 'en' = 'zh'
  const ctx = {
    effect: (factory: () => () => void) => effects.push(factory()),
    slots: {
      entries: () => entries,
      subscribe: (_key: string, listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    locale: {
      bind: () => (key: keyof typeof settingsNavigationZh) =>
        (locale === 'zh' ? settingsNavigationZh : settingsNavigationEn)[key],
      register: () => () => {},
    },
  }
  apply(ctx as never)
  return {
    change: () => listeners.forEach((listener) => listener()),
    language: (value: 'zh' | 'en') => {
      locale = value
    },
    dispose: () => effects.reverse().forEach((dispose) => dispose()),
  }
}
function entry(id: string, order = 35): StoredEntry {
  return {
    component: () => null,
    options: { id, order, label: () => id },
    inject: () => ({ remote: 'original provider' }),
    children: { 'settings.models.footer': { kind: 'list', scope: 'root' } },
    locale: 'upstream.locale',
  }
}
function label(value: StoredEntry): string | undefined {
  return typeof value.options.label === 'function' ? value.options.label() : value.options.label
}

describe('settings navigation presentation bridge', () => {
  it('changes only known navigation metadata and restores it on unload', () => {
    const source = entry('our-free-model')
    const unknown = entry('another-plugin')
    const original = { ...source, options: { ...source.options } }
    const unknownOptions = { ...unknown.options }
    const entries = [source, unknown]
    const f = fixture(entries)
    expect(entries[0]).toBe(source)
    expect(label(source)).toBe('OFM 模型服务')
    expect(source.options.order).toBe(30)
    expect(source.component).toBe(original.component)
    expect(source.inject).toBe(original.inject)
    expect(source.children).toBe(original.children)
    expect(source.locale).toBe(original.locale)
    expect(unknown.options).toEqual(unknownOptions)
    f.language('en')
    expect(label(source)).toBe('OFM services')
    f.dispose()
    expect(source).toEqual(original)
    expect(entries).toHaveLength(2)
  })

  it('adapts late registration and upstream hot reload without adding duplicate sections', () => {
    const entries: StoredEntry[] = []
    const f = fixture(entries)
    const first = entry('our-free-model')
    entries.push(first)
    f.change()
    expect(label(first)).toBe('OFM 模型服务')
    const reloaded = entry('our-free-model', 42)
    entries.splice(0, 1, reloaded)
    f.change()
    expect(label(reloaded)).toBe('OFM 模型服务')
    expect(reloaded.options.order).toBe(30)
    expect(entries).toHaveLength(1)
    f.dispose()
    expect(reloaded.options.order).toBe(42)
    expect(label(reloaded)).toBe('our-free-model')
  })

  it('does not overwrite a later owner change during cleanup', () => {
    const source = entry('models')
    const f = fixture([source])
    source.options.order = 888
    source.options.label = 'Owner changed label'
    f.dispose()
    expect(source.options.order).toBe(888)
    expect(label(source)).toBe('Owner changed label')
  })
})
