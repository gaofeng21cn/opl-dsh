import type { Context } from '@deepseek-ai/cordis'
import { watchStopEditSession } from './stop-edit-session-watch.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { CombinationSelect } from './CombinationSelect.tsx'
import { HarnessSettings } from './HarnessSettings.tsx'
import { ExecutionCatalogSection } from './ExecutionCatalogSection.tsx'
import { HarnessToolRow } from './HarnessToolRow.tsx'
import { LiveTranscriptRow } from './LiveTranscriptRow.tsx'
import { liveTranscriptDefinition, LIVE_TRANSCRIPT_KIND } from './live-transcript.ts'
import { DeliverAssetsRow } from './DeliverAssetsRow.tsx'
import { deliverAssetsDefinition, DELIVER_ASSETS_KIND } from './deliver-assets.ts'
import { StopEditControl } from './StopEditControl.tsx'
import { protectEditBranchesFromNewSession } from './fresh-session.ts'
import { HARNESS_TRANSCRIPT_TOOL } from '../contracts/tool-display.ts'
import { remoteCall } from '../../shared/client/remote-call.ts'
export const inject = ['slots', 'sessions', 'uiConversation', 'uiWorkspace', 'remote.oplExecution']
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
/**
 * 订阅官方会话控制流，作为入口刷新信号。
 *
 * 控制流是官方公开的每会话推送面：会话新建、消息提交与回退都会推进它。订阅它而不是
 * 定时轮询，既能在新会话首轮之后更新按钮，也不会在用户什么都没做时空转。
 */
function sessionChanges(ctx: Context, sessionId: string, listener: () => void): () => void {
  const binding = ctx.sessions.binding(sessionId as SessionId)
  if (!binding) return () => {}
  const off = watchStopEditSession(binding.session, listener)
  const offModel = modelSelectionFace(ctx, sessionId)?.subscribe(listener)
  return () => {
    off()
    offModel?.()
  }
}

export function apply(ctx: Context): void {
  const call = remoteCall(ctx.remote.oplExecution)
  ctx.effect(() =>
    protectEditBranchesFromNewSession(ctx.uiWorkspace, ctx.sessions, (sessionId) =>
      call('stop-edit-state', { sessionId }),
    ),
  )
  const sessionChangesFor = (sessionId: string, listener: () => void) =>
    sessionChanges(ctx, sessionId, listener)
  ctx.effect(() => ctx.uiConversation.events.register(liveTranscriptDefinition))
  ctx.effect(() => ctx.uiConversation.events.register(deliverAssetsDefinition))
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      { name: 'conversation.chat.node', key: LIVE_TRANSCRIPT_KIND, locale: 'chat' },
      LiveTranscriptRow,
    ),
  )
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      { name: 'conversation.chat.node', key: DELIVER_ASSETS_KIND, locale: 'chat' },
      DeliverAssetsRow,
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
  // 官方 activity 插槽在编辑时让出工具栏宽度，收起附件、权限和模型等普通控件。
  ctx.slots.inject('conversation.input.activity', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.activity',
        inject: (sessionId) => ({
          sessionId,
          call,
          subscribeSession: sessionChangesFor,
          openSession: (id: string) => ctx.uiWorkspace.openSession(id as SessionId),
        }),
      },
      StopEditControl,
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
