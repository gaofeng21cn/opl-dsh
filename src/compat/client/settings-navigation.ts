import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
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
    const labels = new Map<StoredEntry, () => string>()
    const project = () => {
      const entries = ctx.slots.entries('settings.section')
      // Retired entries need no retained component/closure, including hot reloads.
      for (const entry of originals.keys())
        if (!entries.includes(entry)) {
          originals.delete(entry)
          labels.delete(entry)
        }
      for (const entry of entries) {
        const id = entry.options.id
        if (!id || !Object.hasOwn(SETTINGS_ORDER, id)) continue
        const key = id as keyof typeof SETTINGS_ORDER
        if (!originals.has(entry)) {
          originals.set(entry, { ...entry.options })
          labels.set(entry, () => t(key))
        }
        entry.options.order = SETTINGS_ORDER[key]
        entry.options.label = labels.get(entry)!
      }
    }
    project()
    const off = ctx.slots.subscribe('settings.section', project)
    return () => {
      off()
      for (const [entry, original] of originals) {
        if (entry.options.label === labels.get(entry)) {
          if (original.label === undefined) delete entry.options.label
          else entry.options.label = original.label
        }
        const id = entry.options.id as keyof typeof SETTINGS_ORDER
        if (entry.options.order === SETTINGS_ORDER[id]) {
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
