/** One browser package, independently mounted feature lifecycles. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import './Conversation.module.css'
import remote from '../generated/remote.mjs'
import * as gateway from '../gateway/client/index.tsx'
import * as execution from '../execution/client/index.tsx'
import * as collaboration from '../collaboration/client/index.tsx'
import * as setup from '../setup/client/index.tsx'
import * as huaweiMaas from '../credentials/client/index.tsx'
import * as notifications from '../notifications/client/index.tsx'
import * as contextBudget from '../context-budget/client/index.tsx'
import * as autoReview from '../auto-review/client/index.tsx'
import * as todoStatus from '../todo-status/client/index.tsx'
import * as settingsNavigation from '../compat/client/settings-navigation.ts'
import { remoteCall } from '../shared/client/remote-call.ts'
export const inject = ['remote', 'slots', 'locale']
export async function apply(ctx: Context): Promise<void> {
  const dispose = await ctx.remote.$mount(remote)
  ctx.effect(() => dispose)
  ctx.plugin(settingsNavigation)
  let openModels: (() => void) | undefined
  ctx.plugin(gateway, { openModels: () => openModels?.() })
  ctx.plugin(execution)
  ctx.plugin(huaweiMaas)
  ctx.plugin(collaboration)
  ctx.plugin(notifications)
  ctx.plugin(todoStatus)
  ctx.plugin({
    name: 'opl-auto-review-client',
    inject: ['remote.oplAutoReview', 'connection'],
    apply(scope: Context) {
      const call = remoteCall(scope.remote.oplAutoReview)
      // rc.2 exports this handle without a Cordis Context augmentation.
      const connection = (scope as Context & { connection: ConnectionHandle }).connection
      scope.plugin(autoReview, {
        connection: {
          getSnapshot: () => connection.generation.getSnapshot()?.id,
          subscribe: (listener) => connection.generation.subscribe(listener),
        },
        api: {
          read: () => call('read'),
          save: (request) => call('save', request),
        },
      })
    },
  })
  ctx.plugin({
    name: 'opl-context-budget-client',
    inject: ['remote.oplContextBudget'],
    apply(scope: Context) {
      const readBudget = remoteCall(scope.remote.oplContextBudget)
      scope.plugin(contextBudget, { read: (sessionId) => readBudget('read', { sessionId }) })
    },
  })
  ctx.plugin(setup, {
    bindModelNavigation: (navigate: (() => void) | undefined) => {
      openModels = navigate
    },
  })
}
