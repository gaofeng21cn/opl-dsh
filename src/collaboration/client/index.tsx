import {
  SETTINGS_NAVIGATION_NS,
  SETTINGS_ORDER,
  settingsNavigationEn,
  settingsNavigationZh,
} from '../../shared/client/settings-navigation.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Context } from '@deepseek-ai/cordis'
import { CoordinationSection } from './CoordinationSection.tsx'
import { remoteCall, optionalRemote } from '../../shared/client/remote-call.ts'
export { CoordinationSection }
export const inject = ['slots', 'locale', 'remote.oplCoordination']
export function apply(ctx: Context): void {
  ctx.effect(() =>
    ctx.locale.register(SETTINGS_NAVIGATION_NS, {
      zh: settingsNavigationZh,
      en: settingsNavigationEn,
    }),
  )
  const call = remoteCall(ctx.remote.oplCoordination)
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'opl-codex',
        order: SETTINGS_ORDER['opl-codex'],
        label: () => ctx.locale.bind(SETTINGS_NAVIGATION_NS)('opl-codex'),
        inject: () => {
          // Optional execution settings must not block Skill/install settings.
          const execution = optionalRemote(ctx, 'oplExecution')
          const roles = optionalRemote(ctx, 'oplRoleExecution')
          return {
            call,
            ...(execution ? { executionCall: remoteCall(execution) } : {}),
            ...(roles ? { roleCall: remoteCall(roles) } : {}),
          }
        },
      },
      CoordinationSection,
    ),
  )
}
