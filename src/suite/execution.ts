import { installExternalCodex } from '../collaboration/host/external-codex.ts'
import { installLegacyHarnessChannel } from '../compat/host/legacy-channel.ts'
import { ExecutionService } from '../execution/host/service.ts'
/** Add waiting to the official Session RPC surface without replacing its controller. */
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Context } from '@deepseek-ai/cordis'
import { installSessionWaitProjection } from '../execution/host/session-wait.ts'
import { createHarnessService } from '../execution/host/harness.ts'
import { MiniMaxCodeModelAdapter } from '../execution/host/adapters/minimax-models.ts'
import { MINIMAX_CODE_PROVIDER } from '../execution/host/adapters/minimax.ts'
import {
  HuaweiZcodeModelAdapter,
  HUAWEI_ZCODE_MODEL,
} from '../execution/host/adapters/zcode-models.ts'
import { installCollaborationTools } from '../collaboration/host/tools.ts'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { modelDefaultEffort } from '../shared/model-reasoning.ts'

export const inject = [
  'llm',
  'typertGateway',
  'sessions',
  'agents',
  'sessionProjections',
  'connection',
  'webServer',
  'settings',
  'credentials',
  'agentDefaultModel',
  'workspaceRegistry',
  'permissionPresets',
  'sessionController',
  'sandboxPolicy',
  'approval',
]
/** Keep admission, model selection, tools and permissions in the official Host.
 * @param ctx - Official Host context.
 */
export function apply(ctx: Context, _config: Record<string, never>): void {
  const harness = createHarnessService(ctx)
  // Apply model defaults on official/custom routes before the request is logged.
  ctx.on('agent/request', async (payload, next) => {
    harness.assertRuntimeAvailable()
    await harness.assertConversationEditable(payload.agent.session.id)
    harness.assertRuntimeAvailable()
    const request = await next()
    harness.assertRuntimeAvailable()
    if (
      request.reasoningEffort !== undefined ||
      (request.model.split('::').at(-1) !== 'deepseek-flash' &&
        !request.model.split('::').at(-1)?.startsWith('gpt-'))
    )
      return request
    const info = await ctx.llm.resolveModelInfo(request.provider, request.model)
    const effort = modelDefaultEffort(request.model, info.reasoning)
    return effort === undefined
      ? request
      : { ...request, reasoningEffort: ReasoningEffortId(effort) }
  })
  ctx.on('llm/stream', (options, next) => harness.conversationStream(options, next))
  // Register the official MiniMax Code account models through the public LLM extension
  // point. Without this the two models exist in the execution catalog but the official
  // session controller cannot list or select them, so no message would ever route.
  ctx.llm.registerAdapter([MINIMAX_CODE_PROVIDER], new MiniMaxCodeModelAdapter())
  ctx.llm.registerAdapter([HUAWEI_ZCODE_MODEL.provider], new HuaweiZcodeModelAdapter())
  new ExecutionService(ctx, harness)
  ctx.effect(() => () => harness.dispose())
  installCollaborationTools(ctx, harness)
  installLegacyHarnessChannel(ctx)
  installSessionWaitProjection(ctx)
  installExternalCodex(ctx, harness)
}
