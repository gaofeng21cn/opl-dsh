/** Count scope preference over the official activity pill and settings form. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { StatisticsSettings } from './PreferenceRow.tsx'
import { installActivityCounts } from './activity.tsx'

export const inject = ['slots', 'locale', 'configForms']

/** Client selection for the optional OPL count replacement. */
export interface ConversationStatsClientConfig {
  enabled?: boolean
}

/** @param ctx - Official Client context with the shared Host settings mirror. */
export function apply(ctx: Context, config: ConversationStatsClientConfig = {}): void {
  const form = ctx.configForms.get<StatisticsSettings>('opl-suite')
  if (config.enabled === false) return
  ctx.slots.inject('conversation.composer.dock', () =>
    installActivityCounts({
      entries: () => ctx.slots.entriesOfSlot('conversation.composer.dock'),
      subscribe: (listener) => ctx.slots.subscribe('conversation.composer.dock', listener),
      form,
    }),
  )
}
