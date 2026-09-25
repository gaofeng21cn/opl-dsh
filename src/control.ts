/** Add waiting to the official Session RPC surface without replacing its controller. */
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

export const inject = ['typertGateway', 'sessions', 'agents', 'sessionProjections', 'connection', 'webServer']
/** Keep admission, model selection, tools and permissions in the official Host.
 * @param ctx - Official Host context.
 */
export function apply(ctx: Context): void {
  installSessionWaitProjection(ctx)
  const gateway = ctx.typertGateway
  const bridge = {
    stream: gateway.stream.bind(gateway),
    invoke: async (request: Parameters<TypertGateway['invoke']>[0]) => {
      if (request.namespace === 'oplSuite' && request.method === 'setupUrl') return ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/#opl-setup`)
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
