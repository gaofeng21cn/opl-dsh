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
import { installCollaborationTools } from '../collaboration/host/tools.ts'
import { installPermissionMemory } from '../compat/host/permission-memory.ts'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { modelDefaultEffort } from '../shared/model-reasoning.ts'
import type { AutoReviewMaintenance } from '../auto-review/contracts/maintenance.ts'
import { EXTERNAL_REVIEW_BINDING_SERVICE } from '../auto-review/host/index.ts'
import { createOfmOwnerApiReader } from '../execution/host/ofm-owner-api.ts'
import {
  applyOfmModelSource,
  createOfmApiConnection,
  OFM_PROVIDER,
} from '../execution/host/ofm-source/index.ts'
import z from '@deepseek-ai/schemastery'

export interface Config {
  ofmConnectionTimeoutMs: number
}
export const Config = z.object({
  ofmConnectionTimeoutMs: z.number().step(1).min(100).max(120_000).default(10_000),
})

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
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => installPermissionMemory(ctx))
  const harness = createHarnessService(ctx)
  ctx.provide('oplExternalModelSources', harness.modelSources)
  const ofmOwner = createOfmOwnerApiReader(ctx, config.ofmConnectionTimeoutMs)
  applyOfmModelSource(ctx, {
    providers: [OFM_PROVIDER],
    connection: createOfmApiConnection(async (request) => {
      if (request.url !== '/api/our-free-model/clients') throw Error('OFM 连接读取路径无效')
      return { status: 200, body: await ofmOwner.read('/clients') }
    }, ''),
  })
  const reviewerMaintenance: AutoReviewMaintenance = {
    change: (operation) => harness.changeReviewerSettings(operation),
  }
  ctx.provide('oplAutoReviewMaintenance', reviewerMaintenance)
  // Bind an external-Harness permission ask to the live ACP connection record.
  // The binding is all-or-nothing: without the exact action, turn, connection
  // generation and authorization the port returns null, and the Auto Review
  // bridge then leaves the ask to the ordinary human approval chain.
  ctx.provide(EXTERNAL_REVIEW_BINDING_SERVICE, {
    bind: (agent: { session: { id: string } }, request: { callId?: string }) =>
      harness.externalApprovalBinding(agent.session.id, request.callId),
  })
  // Apply model defaults on official/custom routes before the request is logged.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'enter')
      await harness.claimMessageEdit(payload.agent, decision.messages, payload.turn, payload.step)
    return decision
  })
  ctx.on('agent/request', async (payload, next) => {
    harness.assertRuntimeAvailable()
    const edited = await harness.commitMessageEdit(
      payload.agent,
      payload.turn,
      payload.step,
      payload.signal,
    )
    await harness.assertConversationEditable(payload.agent.session.id, edited)
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
  new ExecutionService(ctx, harness)
  ctx.effect(() => () => harness.dispose())
  installCollaborationTools(ctx, harness)
  installLegacyHarnessChannel(ctx)
  installSessionWaitProjection(ctx)
  installExternalCodex(ctx, harness)
}
