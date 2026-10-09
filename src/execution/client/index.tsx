import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CombinationSelect } from './CombinationSelect.tsx'
import { HarnessSettings } from './HarnessSettings.tsx'
import { ExecutionCatalogSection } from './ExecutionCatalogSection.tsx'
import { HarnessToolRow } from './HarnessToolRow.tsx'
import { LiveTranscriptRow } from './LiveTranscriptRow.tsx'
import { liveTranscriptDefinition, LIVE_TRANSCRIPT_KIND } from './live-transcript.ts'
import { HARNESS_TRANSCRIPT_TOOL } from '../contracts/tool-display.ts'
import { remoteCall } from '../../shared/client/remote-call.ts'
export const inject = ['slots', 'sessions', 'uiConversation', 'remote.oplExecution']
/**
 * The official durable model selection of one Session.
 *
 * The Host folds `model/selection` and `request/header` events into this
 * projection and pushes every finished value over the Session control stream,
 * so reading it here — rather than polling the OPL RPC — is what keeps the
 * composer current when an external writer changes the model. A Session
 * without a live binding has no face yet; the projection arrives with it.
 */
function modelSelectionFace(ctx: Context, sessionId: string) {
  const binding = ctx.sessions.binding(sessionId as SessionId)
  if (!binding) return undefined
  return binding.session.projections.faceOf('modelSelection') as {
    getSnapshot: () => ModelSelectionProjection | undefined
    subscribe: (listener: () => void) => () => void
  }
}
export function apply(ctx: Context): void {
  const call = remoteCall(ctx.remote.oplExecution)
  ctx.effect(() => ctx.uiConversation.events.register(liveTranscriptDefinition))
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      { name: 'conversation.chat.node', key: LIVE_TRANSCRIPT_KIND, locale: 'chat' },
      LiveTranscriptRow,
    ),
  )
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register(
      { name: 'tool.call.toolview', key: HARNESS_TRANSCRIPT_TOOL },
      HarnessToolRow,
    ),
  )
  ctx.slots.inject('conversation.input.model', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.model',
        priority: -10,
        inject: (sessionId) => ({
          call,
          sessionId,
          available: ctx.sessions.subagentAddress(sessionId as SessionId) === undefined,
          selectionSource: (id: string) => modelSelectionFace(ctx, id),
        }),
      },
      CombinationSelect,
    ),
  )
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'opl-harness-settings',
        order: 11,
        label: () => 'Harness',
        inject: () => ({ call }),
      },
      HarnessSettings,
    ),
  )
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'opl-execution',
        order: 12,
        label: () => '运行配置',
        inject: () => ({ call }),
      },
      ExecutionCatalogSection,
    ),
  )
}
