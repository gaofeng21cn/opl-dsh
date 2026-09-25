/** OPL account and collaboration contributions for an unmodified DSH Desktop. */
import type { Context } from '@deepseek-ai/cordis'
import * as gateway from './gateway/index.ts'
import * as control from './control.ts'
import { Config } from './setup-config.ts'
export { Config } from './setup-config.ts'

export const name = 'opl-suite'
export const inject = ['llm', 'typertGateway']

/** Mount account services and publish the authenticated local control binding.
 * @param ctx - Official Host context.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(gateway, {})
  ctx.plugin(control, {})
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
