import { installUpdateRuntime } from '../updates/host/runtime-admission.ts'
import { GatewayModelsService } from '../gateway/host/model-service.ts'
import { SetupService } from '../setup/host/index.ts'
import { UpdateService } from '../updates/host/index.ts'
/** OPL account, execution and collaboration enhancements for an unmodified DSH Desktop. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import * as gateway from '../gateway/host/index.ts'
import * as conversationStats from '../conversation-stats/host/index.ts'
import * as suiteControl from '../shared/host/suite-control.ts'
import * as execution from './execution.ts'
import { createMiniMaxCodeModelRegistration } from '../execution/host/adapters/minimax-models.ts'
import { CoordinationService } from '../collaboration/host/settings-service.ts'
import { RoleExecutionService } from '../collaboration/host/roles.ts'
import TaskFeedbackService from '../collaboration/host/feedback/index.ts'
import { OfficialCollaborationBridge } from '../collaboration/host/official-tools.ts'
import { installCollaborationTools } from '../collaboration/host/tools.ts'
import { installExternalCodex } from '../collaboration/host/external-codex.ts'
import { DomainAgentPresetService } from '../collaboration/host/domain-agent-presets.ts'
import { Config, minimaxCodeConfigChanged } from './config.ts'
export { Config } from './config.ts'

export const name = 'opl-suite'
export const inject = [
  'loader',
  'llm',
  'settings',
  'credentials',
  'sessionProjections',
  'agents',
  'sessions',
  'sessionController',
  'agentDefaultModel',
  'typertGateway',
  'webServer',
  'connection',
  'workspaceRegistry',
  'permissionPresets',
  'sandboxPolicy',
  'approval',
  'agentPresets',
]

/** Mount account services and publish the authenticated local control binding.
 * @param ctx - Official Host context.
 * @param config - Suite settings from the profile.
 * @returns Once local control and update services have started.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(gateway, structuredClone(config.gateway.get()) as gateway.OplGatewayConfig)
  await ctx.plugin(conversationStats)
  await ctx.plugin(GatewayModelsService)
  await ctx.plugin(SetupService)
  await ctx.plugin(suiteControl)
  ctx.inject(['sessions', 'agents', 'sessionController', 'settings', 'typertGateway'], (child) => {
    child.provide('oplUpdateRuntime', installUpdateRuntime(child))
  })
  await ctx.plugin(UpdateService)
  const executionEnabled = config.executionEnabled?.get() !== false
  const collaborationEnabled = config.collaborationEnabled?.get() !== false
  if (executionEnabled) {
    const minimaxCodeEnabled = () => config.minimaxCodeEnabled.get()
    const syncMiniMaxCodeModels = createMiniMaxCodeModelRegistration(ctx, minimaxCodeEnabled)
    const runtime = await ctx.plugin(execution, {
      executionLimits: config.executionLimits.get(),
      rememberPermissionPreset: config.rememberPermissionPreset.get(),
      minimaxCodeEnabled: minimaxCodeEnabled(),
    })
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
  }
  if (collaborationEnabled) {
    if (executionEnabled) {
      ctx.inject(
        [
          'oplHarness',
          'settings',
          'agents',
          'typertGateway',
          'connection',
          'webServer',
          'permissionPresets',
          'workspaceRegistry',
          'sessionController',
          'sandboxPolicy',
          'approval',
          'agentPresets',
        ],
        (collab) => {
          collab.provide('oplOfficialCollaboration', new OfficialCollaborationBridge(collab))
          installCollaborationTools(collab, collab.oplHarness)
          installExternalCodex(collab, collab.oplHarness)
          collab.plugin(CoordinationService)
          collab.plugin(DomainAgentPresetService)
          collab.plugin(RoleExecutionService)
          collab.plugin(TaskFeedbackService, {
            wakeTransport: config.wakeTransport.get(),
            wakeExecutable: config.wakeExecutable.get(),
            wakeExecution: config.wakeExecution.get(),
            wakeDistro: config.wakeDistro.get(),
          })
        },
      )
    } else {
      ctx.inject(['settings', 'agents', 'typertGateway', 'connection', 'webServer'], (collab) => {
        collab.plugin(CoordinationService)
        collab.plugin(TaskFeedbackService, {
          wakeTransport: config.wakeTransport.get(),
          wakeExecutable: config.wakeExecutable.get(),
          wakeExecution: config.wakeExecution.get(),
          wakeDistro: config.wakeDistro.get(),
        })
      })
    }
  }
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
