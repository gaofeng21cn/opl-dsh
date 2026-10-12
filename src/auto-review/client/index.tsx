import { SETTINGS_ORDER } from '../../shared/client/settings-navigation.ts'
/**
 * Client plugin of the Auto Review settings section.
 *
 * The plugin mounts one contribution into the official `settings.section` list
 * slot and registers its own locale namespace; it never edits an official
 * component or resource. The only services it touches are the injected
 * {@link Config.api} and the optional {@link Config.connection} — the wiring
 * owner injects the generated Remote methods and the connection generation
 * source through its own Cordis namespace fiber, so this feature never reaches
 * an unknown `ctx.remote.*` service directly and never calls a Session
 * permission API.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { AutoReviewSection } from './AutoReviewSection.tsx'
import type { Config } from './config.ts'
import { AUTO_REVIEW_NAMESPACE, en, zh } from './locales.ts'

export type { Config } from './config.ts'
export type { AutoReviewReadState, AutoReviewView } from './controller.ts'
export type { AutoReviewSectionProps } from './AutoReviewSection.tsx'

/** Services this plugin reads; nothing may be reached without them. */
export const inject = ['slots', 'locale']

/**
 * Mount the Auto Review settings section.
 * @param ctx - official Client root.
 * @param config - the injected read/save seam and optional connection source (see {@link Config}).
 * @returns nothing.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.locale.register(AUTO_REVIEW_NAMESPACE, { zh, en }))
  const t = ctx.locale.bind(AUTO_REVIEW_NAMESPACE)
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'opl-auto-review',
        order: SETTINGS_ORDER['opl-auto-review'],
        label: () => t('sectionLabel'),
        locale: AUTO_REVIEW_NAMESPACE,
        inject: () => ({
          api: config.api,
          // Kept out of the face entirely when unwired, so a single-generation
          // mount carries exactly the api it was given.
          ...(config.connection === undefined ? {} : { connection: config.connection }),
        }),
      },
      AutoReviewSection,
    ),
  )
}
