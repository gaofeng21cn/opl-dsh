import type { Context } from '@deepseek-ai/cordis'
import { resolveSlotLabel, type SlotLabel } from '@deepseek-ai/dsh-client-ui-slots'

/** One OPL settings order; section ids keep official navigation and deep links intact. */
export const SETTINGS_ORDER = {
  general: 0,
  'opl-gateway': 10,
  models: 20,
  'opl-execution': 26,
  'opl-updates': 28,
  'opl-codex': 30,
  'agent-presets': 50,
  plugins: 70,
  'our-free-model': 1000,
  bili: 1010,
} as const

export const SETTINGS_NAVIGATION_NS = 'settings.oplNavigation'
export const settingsNavigationZh = {
  general: '通用设置',
  'opl-gateway': 'OPL Gateway',
  models: '模型供应商',
  'our-free-model': 'Our Free Model',
  bili: 'Billion Context',
  'opl-execution': '执行引擎与协作',
  'opl-updates': '更新',
  'agent-presets': 'Agent 预设',
  'opl-codex': '协作与自动化',
  plugins: '插件管理',
} satisfies Record<keyof typeof SETTINGS_ORDER, string>
export const settingsNavigationEn: Record<keyof typeof SETTINGS_ORDER, string> = {
  general: 'General',
  'opl-gateway': 'OPL Gateway',
  models: 'Model providers',
  'our-free-model': 'Our Free Model',
  bili: 'Billion Context',
  'opl-execution': 'Engines & Team',
  'opl-updates': 'Updates',
  'agent-presets': 'Agent presets',
  'opl-codex': 'Collaboration',
  plugins: 'Plugins',
}

/** Canonical product titles for third-party plugin settings pages. */
export const THIRD_PARTY_SECTION_TITLES: Readonly<Record<string, string>> = {
  bili: 'Billion Context',
  'our-free-model': 'Our Free Model',
}

/** Minimum order assigned to third-party plugin settings pages so they always appear last. */
export const THIRD_PARTY_SECTION_ORDER_BASE = 1000

/** Canonical sort orders for known third-party plugin settings pages. */
export const THIRD_PARTY_SECTION_ORDERS: Readonly<Record<string, number>> = {
  'our-free-model': 1000,
  bili: 1010,
}

const OWNED_OR_NATIVE_SECTION_IDS = new Set([
  'general',
  'models',
  'plugins',
  'agent-presets',
  'remote-connection',
  'account',
])

const isOwnedOrNativeSection = (id: string) =>
  !id || id.startsWith('opl-') || OWNED_OR_NATIVE_SECTION_IDS.has(id)

function titleCaseLowerAscii(label: string): string {
  if (!/^[a-z0-9][a-z0-9\s-]*$/u.test(label)) return label
  return label
    .split(/[\s-]+/u)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Normalize third-party plugin settings navigation titles so inconsistent suffixes
 * like `bili设置` or `Acme Settings` become clean product names (`Billion Context`).
 */
export function normalizeThirdPartySectionLabel(id: string, rawLabel: string): string {
  if (isOwnedOrNativeSection(id)) return rawLabel
  const explicit = THIRD_PARTY_SECTION_TITLES[id]
  if (explicit) return explicit
  const trimmed = rawLabel.trim()
  if (!trimmed) return rawLabel
  const stripped = trimmed
    .replace(/\s*设置$/u, '')
    .replace(/\s+settings$/iu, '')
    .trim()
  if (!stripped) return trimmed
  return stripped === trimmed ? titleCaseLowerAscii(trimmed) : titleCaseLowerAscii(stripped)
}

/**
 * Normalize third-party plugin settings navigation order so official DSH and OPL
 * sections always precede third-party plugins.
 */
export function normalizeThirdPartySectionOrder(id: string, rawOrder?: number): number | undefined {
  if (isOwnedOrNativeSection(id)) return rawOrder
  const explicit = THIRD_PARTY_SECTION_ORDERS[id]
  if (explicit !== undefined) return explicit
  if (typeof rawOrder === 'number' && Number.isFinite(rawOrder)) {
    return rawOrder >= THIRD_PARTY_SECTION_ORDER_BASE
      ? rawOrder
      : THIRD_PARTY_SECTION_ORDER_BASE + Math.max(0, rawOrder)
  }
  return THIRD_PARTY_SECTION_ORDER_BASE
}

/**
 * Wrap third-party `settings.section` entry labels and orders so product names
 * and bottom-of-list placement stay consistent, and restore originals on disposal.
 */
export function installSettingsSectionTitleNormalization(ctx: Context): () => void {
  const slots = ctx.get('slots') as
    | {
        entries?: (key: string) => readonly {
          options: {
            id?: string | undefined
            order?: number | undefined
            label?: SlotLabel | undefined
          }
        }[]
        subscribe?: (key: string, fn: () => void) => () => void
        register?: (options: Record<string, unknown>, component: () => null) => () => void
      }
    | undefined
  if (!slots || typeof slots.entries !== 'function' || typeof slots.subscribe !== 'function') {
    return () => {}
  }
  const originals = new WeakMap<
    object,
    {
      hadLabel: boolean
      label: SlotLabel | undefined
      hadOrder: boolean
      order: number | undefined
    }
  >()
  let refreshing = false

  const applyNormalization = (triggerRefresh: boolean) => {
    if (refreshing) return
    let changed = false
    for (const entry of slots.entries!('settings.section')) {
      const id = entry.options?.id ?? ''
      if (isOwnedOrNativeSection(id) || originals.has(entry)) continue
      const hadLabel = Object.prototype.hasOwnProperty.call(entry.options, 'label')
      const originalLabel = entry.options.label
      const hadOrder = Object.prototype.hasOwnProperty.call(entry.options, 'order')
      const originalOrder = entry.options.order
      originals.set(entry, {
        hadLabel,
        label: originalLabel,
        hadOrder,
        order: originalOrder,
      })
      entry.options.label = () =>
        normalizeThirdPartySectionLabel(id, resolveSlotLabel(originalLabel) ?? '')
      const normalizedOrder = normalizeThirdPartySectionOrder(id, originalOrder)
      if (normalizedOrder !== undefined) entry.options.order = normalizedOrder
      changed = true
    }
    if (triggerRefresh && changed && typeof slots.register === 'function') {
      refreshing = true
      try {
        const dispose = slots.register(
          { name: 'settings.section', id: '__opl-section-title-sync', order: 99_999 },
          () => null,
        )
        dispose()
      } catch {
        // Skip forced refresh if settings.section is not yet declared in a unit fixture.
      } finally {
        refreshing = false
      }
    }
  }

  applyNormalization(true)
  const unsubscribe = slots.subscribe('settings.section', () => applyNormalization(true))
  return () => {
    unsubscribe()
    for (const entry of slots.entries!('settings.section')) {
      const saved = originals.get(entry)
      if (!saved) continue
      originals.delete(entry)
      if (saved.hadLabel) entry.options.label = saved.label
      else delete entry.options.label
      if (saved.hadOrder) entry.options.order = saved.order
      else delete entry.options.order
    }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.oplNavigation': keyof typeof SETTINGS_ORDER
  }
}
