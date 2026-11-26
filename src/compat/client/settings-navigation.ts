import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import './SettingsNavigation.module.css'
import {
  SETTINGS_NAVIGATION_NS,
  SETTINGS_ORDER,
  settingsNavigationEn,
  settingsNavigationZh,
} from '../../shared/client/settings-navigation.ts'

export const inject = ['slots', 'locale']

/** Official settings currently has no navigation presentation setter. Project only
 * public StoredEntry.options metadata; retain each original entry, component,
 * inject face, child declarations and id. No upstream package bytes are changed.
 * Keep this removable bridge here until the official navigation has a projection seat. */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(SETTINGS_NAVIGATION_NS)
  ctx.effect(() => {
    const originals = new Map<StoredEntry, StoredEntry['options']>()
    const projected = new Map<StoredEntry, StoredEntry['options']>()
    const project = () => {
      const entries = ctx.slots.entries('settings.section')
      // Retired entries need no retained component/closure, including hot reloads.
      for (const entry of originals.keys())
        if (!entries.includes(entry)) {
          originals.delete(entry)
          projected.delete(entry)
        }
      for (const entry of entries) {
        const id = entry.options.id
        if (!id) continue
        const known = Object.hasOwn(SETTINGS_ORDER, id)
        const official =
          entry.registrant?.startsWith('@deepseek-ai/') ||
          entry.locale?.startsWith('settings.') ||
          entry.registrant?.startsWith('@one-person-lab/')
        if (!known && official) continue
        const key = id as keyof typeof SETTINGS_ORDER
        if (!originals.has(entry)) originals.set(entry, { ...entry.options })
        const original = originals.get(entry)!
        const previous = projected.get(entry)
        const order = known ? SETTINGS_ORDER[key] : Math.max(1020, original.order ?? 0)
        const label = known ? (previous?.label ?? (() => t(key))) : (original.label ?? id)
        projected.set(entry, { order, label })
        entry.options.order = order
        entry.options.label = label
      }
    }
    project()
    const off = ctx.slots.subscribe('settings.section', project)
    return () => {
      off()
      for (const [entry, original] of originals) {
        if (entry.options.label === projected.get(entry)?.label) {
          if (original.label === undefined) delete entry.options.label
          else entry.options.label = original.label
        }
        if (entry.options.order === projected.get(entry)?.order) {
          if (original.order === undefined) delete entry.options.order
          else entry.options.order = original.order
        }
      }
    }
  })
  // The locale revision also refreshes a shell that cached its rows before OPL loaded.
  ctx.effect(() =>
    ctx.locale.register(SETTINGS_NAVIGATION_NS, {
      zh: settingsNavigationZh,
      en: settingsNavigationEn,
    }),
  )
}
