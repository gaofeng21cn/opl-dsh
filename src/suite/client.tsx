import { isWindowsDesktop } from '../shared/client/windows-desktop.ts'
import { mountRemotes } from '../shared/client/mount-remotes.ts'
/** One browser package, independently mounted feature lifecycles. */
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import * as gateway from '../gateway/client/index.tsx'
import * as setup from '../setup/client/index.tsx'
import type {
  SettingsNavigationTarget,
  TrailingNoticeSource,
} from '../setup/client/AccountLauncher.tsx'
import * as notifications from '../notifications/client/index.tsx'
import * as conversationStats from '../conversation-stats/client/index.tsx'
import * as execution from '../execution/client/index.tsx'
import * as collaboration from '../collaboration/client/index.tsx'
import {
  COLLABORATION_SETTINGS_NAMESPACE,
  collaborationEn,
  collaborationZh,
} from '../collaboration/client/collaboration-locales.ts'
import * as updates from '../updates/client/index.tsx'
import * as oplFlow from '../opl-flow/client/index.tsx'
import * as windowTitle from '../window-title/client/index.tsx'
import { subscribeUpdateWatch } from '../updates/client/watch.ts'
import {
  SuiteFeaturePreferences,
  labels,
  SUITE_FEATURE_NAMESPACE,
  type SuiteFeatureSettings,
} from '../shared/client/FeaturePreferences.tsx'
import { optionalRemote, remoteCall } from '../shared/client/remote-call.ts'
import { NativeShellPreference, nativeShellLabels, type NativeShellApi } from '../shell/client.tsx'
export const inject = ['remote', 'slots', 'locale', 'sessions', 'uiConversation', 'uiWorkspace']
export async function apply(ctx: Context): Promise<void> {
  await mountRemotes(ctx, [
    'oplSetup',
    'oplFlow',
    'oplGatewayAccount',
    'oplGatewayModels',
    'oplUpdates',
    'oplExecution',
    'oplCoordination',
    'oplRoleExecution',
    'taskFeedback',
  ])
  const setupRemote = optionalRemote(ctx, 'oplSetup')
  if (setupRemote && isWindowsDesktop()) {
    ctx.effect(() => ctx.locale.register('settings.oplNativeShell', nativeShellLabels))
    const call = remoteCall(setupRemote)
    const api: NativeShellApi = {
      read: () => call('native-shell'),
      select: (enabled) => call('select-native-shell', enabled),
    }
    ctx.slots.inject('settings.general.item', () =>
      ctx.slots.register(
        {
          name: 'settings.general.item',
          id: 'opl-native-shell-preference',
          order: 35,
          locale: 'settings.oplNativeShell',
          inject: () => ({ api }),
        },
        NativeShellPreference,
      ),
    )
  }
  let openSettings: ((section?: SettingsNavigationTarget) => void) | undefined
  ctx.plugin(gateway, { openGateway: () => openSettings?.('gateway') })
  const executionRemote = optionalRemote(ctx, 'oplExecution')
  const coordinationRemote = optionalRemote(ctx, 'oplCoordination')
  if (executionRemote) {
    const executionCall = remoteCall(executionRemote)
    const coordinationCall = coordinationRemote ? remoteCall(coordinationRemote) : undefined
    const roleRemote = optionalRemote(ctx, 'oplRoleExecution')
    const roleCall = roleRemote ? remoteCall(roleRemote) : undefined
    let collaborationT: ReturnType<typeof ctx.locale.bind<'settings.oplCollaboration'>> | undefined
    if (coordinationCall) {
      ctx.effect(() =>
        ctx.locale.register(COLLABORATION_SETTINGS_NAMESPACE, {
          zh: collaborationZh,
          en: collaborationEn,
        }),
      )
      if (typeof ctx.locale.bind === 'function')
        collaborationT = ctx.locale.bind(COLLABORATION_SETTINGS_NAMESPACE)
    }
    ctx.plugin(
      execution,
      coordinationCall
        ? {
            renderCollaboration: () => (
              <collaboration.CoordinationSection
                embedded
                call={coordinationCall}
                executionCall={executionCall}
                {...(roleCall ? { roleCall } : {})}
                {...(collaborationT ? { t: collaborationT } : {})}
              />
            ),
          }
        : {},
    )
  } else if (coordinationRemote) {
    ctx.plugin(collaboration)
  }
  ctx.plugin(notifications)
  ctx.effect(() => ctx.locale.register(SUITE_FEATURE_NAMESPACE, labels))
  ctx.plugin(conversationStats)
  const oplFlowRemote = optionalRemote(ctx, 'oplFlow')
  if (oplFlowRemote) {
    ctx.plugin(oplFlow, { call: remoteCall(oplFlowRemote) })
  }
  ctx.plugin(windowTitle)
  ctx.inject(['configForms'], (settings) => {
    const suiteSettings = settings.configForms.get<SuiteFeatureSettings>('opl-suite')
    settings.slots.inject('settings.general.item', () =>
      settings.slots.register(
        {
          name: 'settings.general.item',
          id: 'opl-suite-feature-preferences',
          order: 31,
          locale: 'settings.oplSuiteFeatures',
          inject: () => ({ form: suiteSettings }),
        },
        SuiteFeaturePreferences,
      ),
    )
  })
  let inlineNoticeRenderer: ((wide: boolean) => ReactNode) | undefined
  const inlineNoticeListeners = new Set<() => void>()
  const trailingNotice: TrailingNoticeSource = {
    getSnapshot: () => inlineNoticeRenderer,
    subscribe(listener) {
      inlineNoticeListeners.add(listener)
      return () => {
        inlineNoticeListeners.delete(listener)
      }
    },
  }
  const registerInlineNotice = (render: ((wide: boolean) => ReactNode) | undefined) => {
    inlineNoticeRenderer = render
    for (const listener of [...inlineNoticeListeners]) listener()
  }
  const updateRemote = optionalRemote(ctx, 'oplUpdates')
  if (updateRemote) {
    const call = remoteCall(updateRemote)
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    const updateConnection = connection
      ? {
          getSnapshot: () => connection.generation.getSnapshot()?.id,
          subscribe: (listener: () => void) => connection.generation.subscribe(listener),
        }
      : undefined
    ctx.plugin(updates, {
      api: {
        status: () => call('status'),
        check: () => call('check'),
        setAutomatic: (enabled: boolean) => call('automatic', enabled),
        prepare: () => call('prepare'),
        applyNow: () => call('applyNow'),
        cancel: () => call('cancel'),
        setPolicy: (policy) => call('policy', policy),
        postpone: () => call('postpone'),
        activity: () => call('activity'),
      },
      ...(updateConnection ? { connection: updateConnection } : {}),
      subscribe: (listener: () => void) =>
        subscribeUpdateWatch(() => updateRemote.watch(), listener, updateConnection),
      openSettings: (section) => openSettings?.(section),
      registerInlineNotice,
      engineCount: async () => {
        const execution = optionalRemote(ctx, 'oplExecution')
        if (!execution) return 0
        const state = await remoteCall(execution)('engine-updates')
        return state.items.filter((item) => item.status === 'available').length
      },
    })
  }
  ctx.plugin(setup, {
    bindSettingsNavigation: (
      navigate: ((section?: SettingsNavigationTarget) => void) | undefined,
    ) => {
      openSettings = navigate
    },
    trailingNotice,
  })
}
