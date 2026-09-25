/** OPL account and collaboration contributions for an unmodified DSH Desktop. */
import type { Context } from '@deepseek-ai/cordis'
import * as gateway from './gateway/index.ts'
import * as control from './control.ts'

export const name = 'opl-suite'
export const inject = ['llm', 'typertGateway']

/** Mount account services and publish the authenticated local control binding.
 * @param ctx - Official Host context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(gateway, {})
  ctx.plugin(control)
}
