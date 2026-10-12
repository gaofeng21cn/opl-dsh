/**
 * Client context-budget view: one compact entry in the official composer
 * control row (`conversation.input.left`) rendering the read-only observations
 * returned by {@link Config.read}. The plugin owns no transport — the wiring
 * supplies the read seam. A local, default-off preference controls display and
 * reading without changing Host configuration or context policy.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Config } from './config.ts'
import { OptionalBudgetControl } from './ContextBudgetControl.tsx'
import { ContextBudgetSection } from './ContextBudgetSection.tsx'
import { BudgetPreference } from './preference.ts'
import { BUDGET_NAMESPACE, en, zh } from './locales.ts'
import { watchBudgetSession } from './session-signals.ts'

export type { Config } from './config.ts'
export type { BudgetStatus, BudgetView } from './controller.ts'

/** Services this plugin reads; nothing may be reached without them. */
export const inject = ['slots', 'sessions', 'connection', 'locale']

/**
 * Mount the read-only context-budget entry.
 * @param ctx - official Client root.
 * @param config - the injected read seam (see {@link Config}).
 * @returns nothing.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.locale.register(BUDGET_NAMESPACE, { zh, en }))
  // rc.2 exports the Client connection handle but omits its Cordis Context augmentation.
  const connection = (ctx as Context & { connection: ConnectionHandle }).connection
  const preference = new BudgetPreference({
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  })
  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'opl-context-budget',
        order: 40,
        locale: BUDGET_NAMESPACE,
        inject: () => ({ preference }),
      },
      ContextBudgetSection,
    ),
  )
  /** Refresh on official Session lifecycle transitions, without polling or stream deltas. */
  const sessionChanges = (sessionId: string, listener: () => void): (() => void) => {
    const binding = ctx.sessions.binding(sessionId as SessionId)
    if (!binding) return () => {}
    return watchBudgetSession(binding.session, listener)
  }
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'opl-context-budget',
        order: 21,
        locale: BUDGET_NAMESPACE,
        inject: (sessionId: string) => ({
          preference,
          sessionId,
          read: (id: string) => config.read(id),
          subscribeSession: sessionChanges,
          subscribeConnection: (listener: () => void) => connection.generation.subscribe(listener),
        }),
      },
      OptionalBudgetControl,
    ),
  )
}
