import { sessionPermissions } from '../../compat/host/session-permissions.ts'
/** Optional external Codex transport; shares the internal collaboration owner. */
import type { Context } from '@deepseek-ai/cordis'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { setupStatus, finishSetup } from '../../setup/host/state.ts'
import { waitForSession } from '../../execution/host/session-wait.ts'
import { startControlBridge } from '../../shared/host/control-bridge.ts'
import { HARNESS_NAMESPACE, type HarnessService } from '../../execution/host/harness.ts'
import { invokeExecutionRpc } from '../../compat/host/execution-rpc.ts'
const sessionId = (value: string) => value as SessionId
export function installExternalCodex(ctx: Context, harness: HarnessService) {
  const gateway = ctx.typertGateway
  const bridge = {
    stream: ((...args: Parameters<TypertGateway['stream']>) => {
      if (!harness.cooperationSettings().externalCodex) throw Error('外部 Codex 接入已关闭')
      return gateway.stream(...args)
    }) as TypertGateway['stream'],
    invoke: async (request: Parameters<TypertGateway['invoke']>[0]) => {
      if (request.namespace === 'oplSuite' && request.method === 'setupUrl')
        return ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/#opl-setup`)
      if (request.namespace === 'oplSuite' && request.method === 'setupStatus')
        return setupStatus(ctx)
      if (request.namespace === 'oplSuite' && request.method === 'finishSetup') {
        const state = await setupStatus(ctx)
        const choice = state.choice === 'undecided' ? 'gateway' : state.choice
        await finishSetup(ctx, choice)
        return { completed: true, choice }
      }
      if (!harness.cooperationSettings().externalCodex)
        throw Error('外部 Codex 接入已关闭；内部协作不受影响')
      if (
        request.namespace === 'session' &&
        ['permissions', 'selectPermissions'].includes(request.method)
      )
        return sessionPermissions(
          ctx,
          request.args?.request,
          request.method === 'selectPermissions',
        )
      if (request.namespace === 'session' && request.method === 'create') {
        const input = request.args?.request
        if (typeof input !== 'object' || input === null || Array.isArray(input))
          throw Error('session.create requires request')
        const { permissionPreset, ...nativeRequest } = input as Record<string, unknown>
        if (permissionPreset !== undefined) {
          if (typeof permissionPreset !== 'string') throw Error('permissionPreset must be a string')
          ctx.permissionPresets.resolve(permissionPreset)
        }
        if (typeof nativeRequest.cwd === 'string' && nativeRequest.workspaceId === undefined) {
          const workspace = await ctx.workspaceRegistry.create(nativeRequest.cwd)
          nativeRequest.workspaceId = workspace.id
          delete nativeRequest.cwd
        }
        const created = await gateway.invoke({ ...request, args: { request: nativeRequest } })
        if (permissionPreset === undefined) return created
        if (typeof created !== 'object' || created === null || !('sessionId' in created))
          throw Error('Official session.create did not return sessionId')
        const value = await sessionPermissions(
          ctx,
          { sessionId: created.sessionId, preset: permissionPreset },
          true,
        )
        return { ...created, ...value }
      }
      if (request.namespace === 'session' && request.method === 'wait') {
        const envelope = request.args
        const rawInput = envelope?.request ?? envelope
        if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput))
          throw new Error('session.wait requires request object')
        const input = rawInput as Record<string, unknown>
        if (typeof input?.sessionId !== 'string' || input.sessionId.length === 0)
          throw new Error('session.wait requires sessionId')
        if (
          input.turn !== undefined &&
          (typeof input.turn !== 'number' || !Number.isSafeInteger(input.turn) || input.turn < 0)
        )
          throw new Error('session.wait requires a nonnegative turn')
        return waitForSession(
          ctx,
          {
            sessionId: sessionId(input.sessionId),
            ...(input.turn === undefined ? {} : { turn: input.turn }),
          },
          request.signal ?? new AbortController().signal,
        )
      }
      if (request.namespace === HARNESS_NAMESPACE)
        return invokeExecutionRpc(ctx, request.method, request.args, request.signal)
      return gateway.invoke(request)
    },
  }
  ctx.effect(async () =>
    startControlBridge(bridge, join(dshHomePath(), 'profiles', 'desktop', 'control.json')),
  )
}
