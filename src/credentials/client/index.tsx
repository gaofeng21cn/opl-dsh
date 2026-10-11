import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { remoteCall } from '../../shared/client/remote-call.ts'
import { HuaweiMaaSSection } from './HuaweiMaaSSection.tsx'
import { zh, en, type HuaweiMaaSLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.oplHuaweiMaas': HuaweiMaaSLocaleKey
  }
}

export const inject = ['slots', 'locale', 'remote.oplHuaweiMaas']

/** Mount write-only credential configuration in the official settings shell. */
export function apply(ctx: Context): void {
  const ns = 'settings.oplHuaweiMaas'
  const call = remoteCall(ctx.remote.oplHuaweiMaas)
  ctx.effect(() => ctx.locale.register(ns, { zh, en }))
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'opl-huawei-maas',
        order: 10,
        label: () => ctx.locale.bind(ns)('nav'),
        locale: ns,
        inject: () => ({
          readStatus: () => call('status'),
          saveKey: (key: string) => call('saveKey', key),
          clearKey: () => call('clearKey'),
        }),
      },
      HuaweiMaaSSection,
    ),
  )
}
