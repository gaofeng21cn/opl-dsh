/** Add waiting to the official Session RPC surface without replacing its controller. */
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LoginChoice } from './setup-config.ts'
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

export const inject = ['typertGateway', 'sessions', 'agents', 'sessionProjections', 'connection', 'webServer', 'settings', 'credentials', 'agentDefaultModel']
/** Keep admission, model selection, tools and permissions in the official Host.
 * @param ctx - Official Host context.
 */
export function apply(ctx: Context, config: { choice: () => LoginChoice }): void {
  installSessionWaitProjection(ctx)
  const gateway = ctx.typertGateway
  const officialStatus = async () => {
    const account = await gateway.invoke({ namespace: 'account', method: 'getState', args: {} })
    if (typeof account === 'object' && account !== null && 'status' in account && account.status === 'credential-stored') return 'deepseek-account'
    const settings = await ctx.settings.describe()
    const value = settings.find(item => item.ns === 'llm-deepseek')?.value
    if (value && typeof value === 'object' && 'apiKeyEnv' in value && typeof value.apiKeyEnv === 'string') {
      if (await ctx.credentials.resolve(credentialRef(value.apiKeyEnv))) return 'deepseek-official'
    }
    return undefined
  }
  const bridge = {
    stream: gateway.stream.bind(gateway),
    invoke: async (request: Parameters<TypertGateway['invoke']>[0]) => {
      if (request.namespace === 'oplSuite' && request.method === 'setupUrl') return ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/#opl-setup`)
      if (request.namespace === 'oplSuite' && request.method === 'setupStatus') {
        return { choice: config.choice(), officialProvider: await officialStatus() }
      }
      if (request.namespace === 'oplSuite' && request.method === 'finishSetup') {
        if (config.choice() === 'later') throw new Error('Sign-in was postponed')
        const provider = config.choice() === 'official' ? await officialStatus() : 'opl-gateway'
        if (!provider) throw new Error('Official sign-in is not complete')
        const model = (await ctx.llm.listModels(provider))[0]
        if (!model) throw new Error('The selected account has no available model')
        await ctx.agentDefaultModel.saveSelection({ provider, model: model.id })
        return { provider, model: model.id }
      }
      if (request.namespace === 'session' && request.method === 'wait') {
        const input = request.args
        if (typeof input?.sessionId !== 'string' || input.sessionId.length === 0) throw new Error('session.wait requires sessionId')
        if (input.turn !== undefined && (typeof input.turn !== 'number' || !Number.isSafeInteger(input.turn) || input.turn < 0)) throw new Error('session.wait requires a nonnegative turn')
        return waitForSession(ctx, { sessionId: brandString<SessionId>(input.sessionId), ...(input.turn === undefined ? {} : { turn: input.turn }) }, request.signal ?? new AbortController().signal)
      }
      return gateway.invoke(request)
    },
  }
  ctx.effect(async () => startControlBridge(bridge, join(dshHomePath(), 'profiles', 'desktop', 'control.json')))
}
