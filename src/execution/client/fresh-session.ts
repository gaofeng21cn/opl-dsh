/** Keep an empty edit branch out of the official Workspace's reusable-new-session flow. */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { StopEditState } from '../contracts/stop-edit.ts'

type WorkspaceId = Parameters<UiWorkspace['connectWorkspace']>[0]
type SessionId = Awaited<ReturnType<UiWorkspace['connectWorkspace']>>

/**
 * Guard the public blank-Session resolver without changing direct Session navigation.
 * @param workspace - official Workspace navigation service.
 * @param sessions - official Session creation service.
 * @param read - read the candidate's durable edit source through the OPL Remote.
 * @returns disposer restoring the owned resolver and rejecting pending resolution.
 */
export function protectEditBranchesFromNewSession(
  workspace: Pick<UiWorkspace, 'connectWorkspace'>,
  sessions: Pick<ISessions, 'create'>,
  read: (sessionId: string) => Promise<StopEditState>,
): () => void {
  const original = workspace.connectWorkspace
  const pending = new Map<WorkspaceId, Promise<SessionId>>()
  let disposed = false
  const checkLifetime = () => {
    if (disposed) throw new Error('New Session resolution is no longer available')
  }
  const resolve = async (workspaceId: WorkspaceId): Promise<SessionId> => {
    checkLifetime()
    const candidate = await original.call(workspace, workspaceId)
    checkLifetime()
    const state = await read(candidate)
    checkLifetime()
    if (state.sessionId !== candidate) throw new Error('New Session candidate changed')
    if (state.editSourceSessionId === undefined) return candidate
    // Explicitly omit the candidate identity: create a separate Session and keep its draft intact.
    const fresh = await sessions.create({ workspaceId })
    checkLifetime()
    return fresh
  }
  const guarded = (workspaceId: WorkspaceId): Promise<SessionId> => {
    const existing = pending.get(workspaceId)
    if (existing) return existing
    const attempt = resolve(workspaceId).finally(() => pending.delete(workspaceId))
    pending.set(workspaceId, attempt)
    return attempt
  }
  workspace.connectWorkspace = guarded
  return () => {
    disposed = true
    if (workspace.connectWorkspace === guarded) workspace.connectWorkspace = original
  }
}
