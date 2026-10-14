import { expect, it, vi } from 'vitest'
import {
  allowProjectlessSessions,
  protectEditBranchesFromNewSession,
} from '../../src/execution/client/fresh-session.ts'
import type { StopEditState } from '../../src/execution/contracts/stop-edit.ts'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'

const workspaceId = 'workspace-1' as Parameters<
  Parameters<typeof protectEditBranchesFromNewSession>[0]['connectWorkspace']
>[0]
const sessionId = (value: string) =>
  value as Awaited<
    ReturnType<Parameters<typeof protectEditBranchesFromNewSession>[0]['connectWorkspace']>
  >

function state(editSourceSessionId?: string): StopEditState {
  return {
    version: 1,
    sessionId: 'blank',
    supported: true,
    busy: false,
    pending: false,
    boundaries: [],
    filesRestored: false,
    ...(editSourceSessionId === undefined ? {} : { editSourceSessionId }),
  }
}

function fixture(read = vi.fn(async () => state())) {
  const original = vi.fn(async () => sessionId('blank'))
  const workspace = { connectWorkspace: original }
  const sessions = { create: vi.fn(async () => sessionId('fresh')) }
  const dispose = protectEditBranchesFromNewSession(workspace, sessions, read)
  return { workspace, sessions, read, original, dispose }
}

it('an empty edit branch starts a separate Session without adopting the branch identity', async () => {
  const f = fixture(vi.fn(async () => state('source')))
  expect(await f.workspace.connectWorkspace(workspaceId)).toBe('fresh')
  expect(f.read).toHaveBeenCalledExactlyOnceWith('blank')
  expect(f.sessions.create).toHaveBeenCalledExactlyOnceWith({ workspaceId })
  f.dispose()
})

it('an ordinary blank Session retains official reuse', async () => {
  const f = fixture()
  expect(await f.workspace.connectWorkspace(workspaceId)).toBe('blank')
  expect(f.sessions.create).not.toHaveBeenCalled()
  f.dispose()
})

it('parallel new-session clicks share one resolution and one fresh creation', async () => {
  const f = fixture(vi.fn(async () => state('source')))
  const first = f.workspace.connectWorkspace(workspaceId)
  const second = f.workspace.connectWorkspace(workspaceId)
  expect(second).toBe(first)
  expect(await first).toBe('fresh')
  expect(f.original).toHaveBeenCalledTimes(1)
  expect(f.sessions.create).toHaveBeenCalledTimes(1)
  f.dispose()
})

it('a failed edit-source read does not navigate to the candidate and a later click can retry', async () => {
  const read = vi.fn(async () => state('source'))
  read.mockRejectedValueOnce(new Error('transport failed'))
  const f = fixture(read)
  await expect(f.workspace.connectWorkspace(workspaceId)).rejects.toThrow('transport failed')
  expect(f.sessions.create).not.toHaveBeenCalled()
  expect(await f.workspace.connectWorkspace(workspaceId)).toBe('fresh')
  f.dispose()
})

it('a result for a different candidate cannot authorize its reuse', async () => {
  const f = fixture(vi.fn(async () => ({ ...state(), sessionId: 'other' })))
  await expect(f.workspace.connectWorkspace(workspaceId)).rejects.toThrow('candidate changed')
  expect(f.sessions.create).not.toHaveBeenCalled()
  f.dispose()
})

it('disposal during the read restores the resolver and prevents fresh creation', async () => {
  let release!: (value: StopEditState) => void
  const pending = new Promise<StopEditState>((resolve) => {
    release = resolve
  })
  const f = fixture(vi.fn(() => pending))
  const result = f.workspace.connectWorkspace(workspaceId)
  await vi.waitFor(() => expect(f.read).toHaveBeenCalled())
  f.dispose()
  release(state('source'))
  await expect(result).rejects.toThrow('no longer available')
  expect(f.sessions.create).not.toHaveBeenCalled()
  expect(f.workspace.connectWorkspace).toBe(f.original)
})

it('a failed fresh creation preserves failure instead of opening the old branch', async () => {
  const f = fixture(vi.fn(async () => state('source')))
  f.sessions.create.mockRejectedValueOnce(new Error('creation refused'))
  await expect(f.workspace.connectWorkspace(workspaceId)).rejects.toThrow('creation refused')
  f.dispose()
})

it('disposal does not overwrite a later service resolver', () => {
  const f = fixture()
  const later = vi.fn(async () => sessionId('later'))
  f.workspace.connectWorkspace = later
  f.dispose()
  expect(f.workspace.connectWorkspace).toBe(later)
})

it('creates an unattached Session for the global new-conversation action', async () => {
  const original = vi.fn()
  const openSession = vi.fn()
  const workspace = { startSession: original, openSession } as Pick<
    UiWorkspace,
    'startSession' | 'openSession'
  >
  const fresh = 'projectless-session' as Awaited<ReturnType<ISessions['create']>>
  const sessions = { create: vi.fn(async () => fresh) } as Pick<ISessions, 'create'>
  const dispose = allowProjectlessSessions(workspace, sessions)
  workspace.startSession()
  await vi.waitFor(() => expect(openSession).toHaveBeenCalledExactlyOnceWith(fresh))
  expect(sessions.create).toHaveBeenCalledExactlyOnceWith({})
  expect(original).not.toHaveBeenCalled()
  dispose()
})

it('leaves workspace-targeted new sessions on the official path', () => {
  const original = vi.fn()
  const workspace = { startSession: original, openSession: vi.fn() } as Pick<
    UiWorkspace,
    'startSession' | 'openSession'
  >
  const sessions = { create: vi.fn() } as Pick<ISessions, 'create'>
  const dispose = allowProjectlessSessions(workspace, sessions)
  const workspaceId = 'workspace-1' as Parameters<UiWorkspace['startSession']>[0]
  workspace.startSession(workspaceId)
  expect(original).toHaveBeenCalledExactlyOnceWith(workspaceId, undefined)
  expect(sessions.create).not.toHaveBeenCalled()
  dispose()
})
