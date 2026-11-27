/** General settings and an inline sidebar indicator over the same Host update projection. */
import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Config } from './config.ts'
import { UpdateController } from './controller.ts'
import { UpdatesSection } from './UpdatesSection.tsx'
import { UpdateNotice, type UpdateNoticeProps } from './UpdateNotice.tsx'
import { UPDATE_NAMESPACE, zh, en } from './locales.ts'
import { createUpdateNavigation } from './navigation.ts'

export type { Config } from './config.ts'
export const inject = ['slots', 'locale']

type ReactiveLocale = {
  bind?: (ns: string) => UpdateNoticeProps['t']
  subscribe?: (listener: () => void) => () => void
  getSnapshot?: () => unknown
}

const noopSubscribe = () => () => {}
const staticSnapshot = () => null

/** @param ctx - Official Client context. @param config - Suite-owned Remote adapter. */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.locale.register(UPDATE_NAMESPACE, { zh, en }))
  const controller = new UpdateController(config)
  ctx.effect(() => {
    controller.start()
    return () => controller.stop()
  })
  const navigation = createUpdateNavigation()
  ctx.effect(() => navigation.dispose)
  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'opl-updates',
        order: 60,
        locale: UPDATE_NAMESPACE,
        inject: () => ({ controller, navigation }),
      },
      UpdatesSection,
    ),
  )
  const fallbackT = ((key: keyof typeof zh, params?: Record<string, unknown>) =>
    zh[key].replace(/\{(\w+)\}/gu, (_match, name: string) =>
      String(params?.[name] ?? ''),
    )) as UpdateNoticeProps['t']
  function InlineUpdateNotice({ wide }: { wide: boolean }) {
    const locale = ctx.locale as unknown as ReactiveLocale
    useSyncExternalStore(
      typeof locale.subscribe === 'function'
        ? (listener) => locale.subscribe!(listener)
        : noopSubscribe,
      typeof locale.getSnapshot === 'function' ? () => locale.getSnapshot!() : staticSnapshot,
      staticSnapshot,
    )
    const t =
      typeof locale.bind === 'function'
        ? (locale.bind(UPDATE_NAMESPACE) as UpdateNoticeProps['t'])
        : fallbackT
    return (
      <UpdateNotice
        wide={wide}
        controller={controller}
        navigation={navigation}
        t={t}
        {...(config.engineCount ? { engineCount: config.engineCount } : {})}
        {...(config.openSettings ? { openSettings: config.openSettings } : {})}
      />
    )
  }
  ctx.effect(() => {
    config.registerInlineNotice?.((wide) => <InlineUpdateNotice wide={wide} />)
    return () => config.registerInlineNotice?.(undefined)
  })
}
