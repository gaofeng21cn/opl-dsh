import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import { connectDsh } from '../../src/execution/host/adapters/dsh.ts'

function setup(sandbox: HarnessSession['sandbox']) {
  const session = Session.create(SessionId('session-harness-permission'))
  const set = vi.fn()
  const ctx = {
    get: (name: string) => (name === 'permissionPresets' ? { set } : undefined),
    sessions: { get: () => session },
    workspaceRegistry: { create: async () => ({ id: 'project' }) },
    typertGateway: { invoke: vi.fn(async () => ({})) },
  } as unknown as Context
  const record = {
    id: 'harness-permission',
    sandbox,
    cwd: process.cwd(),
    modelRef: {},
    title: 'task',
  } as HarnessSession
  return { ctx, record, session, set }
}
it.each([
  ['full-access', 'danger-full-access'],
  ['workspace', 'workspace-write'],
  ['read-only', 'read-only'],
] as const)(
  'creates a DSH %s task using built-in %s without reducing its access',
  async (sandbox, preset) => {
    const { ctx, record, session, set } = setup(sandbox)
    await connectDsh(ctx, record, async () => {})
    expect(set).toHaveBeenCalledExactlyOnceWith(session, preset)
  },
)
it('does not overwrite a user-selected preset when reconnecting an existing DSH task', async () => {
  const { ctx, record, set } = setup('full-access')
  record.acpSessionId = 'session-harness-permission'
  await connectDsh(ctx, record, async () => {})
  expect(set).not.toHaveBeenCalled()
})
it('refuses missing official permission support before any task can be sent', async () => {
  const { ctx, record } = setup('full-access')
  ctx.get = (() => undefined) as typeof ctx.get
  await expect(connectDsh(ctx, record, async () => {})).rejects.toThrow('permission preset service')
})
