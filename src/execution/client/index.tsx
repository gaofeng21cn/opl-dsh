import { SETTINGS_ORDER } from '../../shared/client/settings-navigation.ts'
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
import { MessageEditControl, type EditSelection } from './MessageEditControl.tsx'
import {
  installMessageEditViews,
  installMessageEditNavigation,
  messageEditDefinition,
} from './message-edit-view.ts'
import { allowProjectlessSessions, markProjectlessSession } from './fresh-session.ts'
import {
  installProjectlessOfficialComposer,
  PROJECTLESS_COMPOSER_NAMESPACE,
  projectlessComposerZh,
  projectlessComposerEn,
  installProjectlessUngroupedPlus,
} from './ProjectlessOfficialComposer.tsx'
import { HARNESS_TRANSCRIPT_TOOL } from '../contracts/tool-display.ts'
import { remoteCall } from '../../shared/client/remote-call.ts'
export const inject = [
  'slots',
  'locale',
  'sessions',
  'uiConversation',
  'uiWorkspace',
  'remote.oplExecution',
  'remote.session',
]

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
  ctx.effect(() =>
    ctx.locale.register(PROJECTLESS_COMPOSER_NAMESPACE, {
      zh: projectlessComposerZh,
      en: projectlessComposerEn,
    }),
  )
  const composerText = ctx.locale.bind(PROJECTLESS_COMPOSER_NAMESPACE)
  const call = remoteCall(ctx.remote.oplExecution)
  const workspace = ctx.uiWorkspace
  const sessions = ctx.sessions
  ctx.effect(() =>
    allowProjectlessSessions(workspace, async () => {
      // Reserve the projectless path in the OPL Host, then let the official
      // Session Controller create/adopt the exact identity and publish it to
      // the navigator before the Workspace service retains it.
      const result = await call('projectless-session')
      const sessionId = await sessions.create({
        sessionId: result.sessionId as SessionId,
        cwd: result.cwd,
      })
      markProjectlessSession(sessionId)
      return sessionId
    }),
  )
  ctx.effect(() => installMessageEditViews(ctx.uiConversation.views))
  ctx.effect(() => installMessageEditNavigation(ctx))
  ctx.effect(() => ctx.uiConversation.events.register(messageEditDefinition))
  const editors = new Map<
    string,
    { selection: () => EditSelection | undefined; accepted: () => void }
  >()
  const remote = ctx.remote.session
  ctx.effect(() => {
    let owner: object | null = remote
    while (owner && !Object.getOwnPropertyDescriptor(owner, 'prompt'))
      owner = Object.getPrototypeOf(owner) as object | null
    if (!owner) throw Error('Official Session prompt Remote is unavailable')
    const previous = Object.getOwnPropertyDescriptor(owner, 'prompt')!
    const wrapped = function (this: typeof remote) {
      const original = previous.get
        ? (previous.get.call(this) as typeof remote.prompt)
        : (previous.value as typeof remote.prompt)
      const route: typeof remote.prompt = async (prompt, signal) => {
        const editor = editors.get(prompt.sessionId)
        const target = editor?.selection()
        if (!target) return original(prompt, signal)
        if (signal?.aborted) return original(prompt, signal)
        const result = await ctx.remote.oplExecution['message-edit-send']({
          prompt,
          targetSeq: target.seq,
          head: target.head,
        })
        if (result.ok && editors.get(prompt.sessionId) === editor) editor!.accepted()
        return result
      }
      return route
    }
    Object.defineProperty(owner, 'prompt', {
      configurable: true,
      enumerable: previous.enumerable ?? false,
      get: wrapped,
    })
    return () => {
      if (Object.getOwnPropertyDescriptor(owner!, 'prompt')?.get === wrapped)
        Object.defineProperty(owner!, 'prompt', previous)
    }
  })
  const bindPrompt = (
    id: string,
    selection: () => EditSelection | undefined,
    accepted: () => void,
  ) => {
    const editor = { selection, accepted }
    editors.set(id, editor)
    return () => {
      if (editors.get(id) === editor) editors.delete(id)
    }
  }
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
          loadingLabel: composerText('loadingModels'),
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
          bindPrompt,
        }),
      },
      MessageEditControl,
    ),
  )
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'opl-harness-settings',
        order: SETTINGS_ORDER['opl-harness-settings'],
        label: () => '执行引擎',
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
        order: SETTINGS_ORDER['opl-execution'],
        label: () => '执行组合',
        inject: () => ({ call }),
      },
      ExecutionCatalogSection,
    ),
  )
  const slots = ctx.slots
  ctx.slots.inject('sidebar.workspaces', () =>
    installProjectlessUngroupedPlus(
      () => slots.entries('sidebar.workspaces'),
      (listener) => slots.subscribe('sidebar.workspaces', listener),
    ),
  )
  ctx.slots.inject('conversation.composer.bar', () =>
    installProjectlessOfficialComposer(
      () => slots.entries('conversation.composer.bar'),
      (listener) => slots.subscribe('conversation.composer.bar', listener),
      () => composerText('restoring'),
    ),
  )
}
