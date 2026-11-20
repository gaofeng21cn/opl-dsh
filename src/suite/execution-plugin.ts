import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import * as execution from './execution.ts'
import AutoReviewService from '../auto-review/host/index.ts'
import { Config, minimaxCodeConfigChanged } from '../execution/host/plugin-config.ts'
import { createMiniMaxCodeModelRegistration } from '../execution/host/adapters/minimax-models.ts'
export { Config }
export const inject = [...new Set([...execution.inject, ...AutoReviewService.inject])]
export const name = 'opl-execution'

/** Mount the execution runtime before the reviewer adapter that uses its binding port.
 * @param ctx - Official Host context.
 * @param config - Execution settings from the profile.
 * @returns Once the runtime and reviewer adapter have started.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const minimaxCodeEnabled = () => config.minimaxCodeEnabled.get()
  const syncMiniMaxCodeModels = createMiniMaxCodeModelRegistration(ctx, minimaxCodeEnabled)
  const runtime = await ctx.plugin(execution, {
    executionLimits: config.executionLimits.get(),
    rememberPermissionPreset: config.rememberPermissionPreset.get(),
    minimaxCodeEnabled: minimaxCodeEnabled(),
  })
  // oplHarness is provided inside the child runtime. Reading it from the outer
  // context would bypass Cordis injection and prevent the package from activating.
  const harness = runtime.ctx.get('oplHarness')
  if (!harness) throw new Error('执行服务未提供 oplHarness')
  harness.configureMiniMaxCodeIntegration(minimaxCodeEnabled)
  const syncMiniMaxCodeIntegration = () => {
    syncMiniMaxCodeModels()
    void harness.synchronizeMiniMaxCodeIntegration().catch((error) => {
      ctx.logger.warn(`MiniMax 集成停用后的登录清理未完成：${String(error)}`)
    })
  }
  ctx.on('loader/volatile-update', (paths) => {
    if (minimaxCodeConfigChanged(paths)) syncMiniMaxCodeIntegration()
  })
  syncMiniMaxCodeIntegration()
  await ctx.plugin(AutoReviewService, config.toolAutoReview.get())
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))
}
