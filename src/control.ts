import { installSetupChannel, setupStatus, finishSetup } from './setup-service.ts'
/** Add waiting to the official Session RPC surface without replacing its controller. */
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Context } from '@deepseek-ai/cordis'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { installSessionWaitProjection, waitForSession } from './coordination/wait.ts'
import { startControlBridge } from './coordination/control-bridge.ts'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createHarnessService, HARNESS_NAMESPACE } from './coordination/harness.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

export const inject = ['typertGateway', 'sessions', 'agents', 'sessionProjections', 'connection', 'webServer', 'settings', 'credentials', 'agentDefaultModel', 'oplGatewayAccount']
/** Keep admission, model selection, tools and permissions in the official Host.
 * @param ctx - Official Host context.
 */
export function apply(ctx: Context, _config: Record<string, never>): void {
  const harness = createHarnessService(ctx)
  ctx.effect(() => () => harness.dispose())
  // Tools belong to each official Agent scope. Host startup must not wait on
  // an agent-scoped tool registry that does not exist until a conversation opens.
  const install = (agent: import('@deepseek-ai/dsh-agent').Agent) => agent.ctx.inject(['tools'], scope => {
    scope.tools.register(defineTool({
      name: 'delegate_to_harness',
      description: '在同一项目创建或继续关联的模型 + 官方 Harness 子对话，执行明确任务并返回结果。Grok 使用 grok-build/grok-4.7；DeepSeek 使用 dsh/deepseek-flash。',
      parameters: {
        combination: { type: 'string', enum: ['grok-build/grok-4.7','dsh/deepseek-flash'], required: true },
        task: { type: 'string', required: true },
        taskId: { type: 'string', description: '同一个子任务保持稳定 ID。', required: true },
        operationId: { type: 'string', description: '相同指令重试使用原 ID；后续新指令用新 ID。', required: true },
        sessionId: { type: 'string', description: '继续已存在的组合会话。' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{type:'text',text:JSON.stringify(value)}],
      },
      execute: async (args, exec) => {
        const cwd = agent.session.header.cwd
        if (!cwd) throw Error('请先选择项目目录，再派发组合任务')
        const policy = agent.ctx.get('sandboxPolicy')?.resolve({session:agent.session})
        const sandbox = policy?.mode === 'read-only' ? 'read-only' : 'workspace'
        const started = await harness.start({combination:args.combination,cwd,taskId:args.taskId,
          origin:{kind:'dsh',sessionId:agent.id},sandbox,
          ...(args.sessionId?{existingSessionId:args.sessionId}:{})})
        const cancel = () => { void harness.cancel({sessionId:started.id}) }
        exec.signal.addEventListener('abort',cancel,{once:true})
        try {
          exec.signal.throwIfAborted()
          await harness.prompt({sessionId:started.id,text:args.task,operationId:args.operationId})
          const result=await harness.wait({sessionId:started.id,operationId:args.operationId},exec.signal)
          const turn=result.turns.find(t=>t.operationId===args.operationId)
          return {sessionId:result.id,combination:result.combination,cwd:result.cwd,state:turn?.state??result.state,
            text:turn?.text??'',approvalRequired:result.approvals.length>0,
            note:result.approvals.length?'请在执行组合面板确认权限，之后读取原会话；不要重派任务。':''}
        } finally {exec.signal.removeEventListener('abort',cancel)}
      },
    }))
  })
  ctx.on('agent/created', ({agent}) => { install(agent) })
  for (const agent of ctx.agents.list()) install(agent)
  installSetupChannel(ctx, (method, input) => harness.invoke(method, input))
  installSessionWaitProjection(ctx)
  const gateway = ctx.typertGateway
  const bridge = {
    stream: gateway.stream.bind(gateway),
    invoke: async (request: Parameters<TypertGateway['invoke']>[0]) => {
      if (request.namespace === 'oplSuite' && request.method === 'setupUrl') return ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/#opl-setup`)
      if (request.namespace === 'oplSuite' && request.method === 'setupStatus') return setupStatus(ctx)
      if (request.namespace === 'oplSuite' && request.method === 'finishSetup') {
        const state = await setupStatus(ctx)
        const choice = state.choice === 'undecided' ? 'gateway' : state.choice
        await finishSetup(ctx, choice)
        return { completed: true, choice }
      }
      if (request.namespace === 'session' && request.method === 'wait') {
        const input = request.args
        if (typeof input?.sessionId !== 'string' || input.sessionId.length === 0) throw new Error('session.wait requires sessionId')
        if (input.turn !== undefined && (typeof input.turn !== 'number' || !Number.isSafeInteger(input.turn) || input.turn < 0)) throw new Error('session.wait requires a nonnegative turn')
        return waitForSession(ctx, { sessionId: brandString<SessionId>(input.sessionId), ...(input.turn === undefined ? {} : { turn: input.turn }) }, request.signal ?? new AbortController().signal)
      }
      if (request.namespace === HARNESS_NAMESPACE) return harness.invoke(request.method, request.args, request.signal)
      return gateway.invoke(request)
    },
  }
  ctx.effect(async () => startControlBridge(bridge, join(dshHomePath(), 'profiles', 'desktop', 'control.json')))
}
