import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { sessionPermissions } from '../../src/compat/host/session-permissions.ts'
function fixture(running = false) {
  const session = { id: 's1' }
  const owner = {
    current: vi.fn(() => 'workspace-write'),
    resolve: vi.fn((name: string) => {
      if (name !== 'danger-full-access') throw Error('unknown preset')
    }),
    set: vi.fn(),
    names: ['workspace-write', 'danger-full-access'],
    defaultPreset: 'workspace-write',
  }
  const ctx = {
    get: () => owner,
    sessionController: {
      resolveAgent: vi.fn(async () => ({
        agent: { session, status: running ? 'running' : 'idle' },
      })),
    },
    sessionProjections: { stateOf: () => ({ openTurnStartSeq: running ? 1 : null, lastTurn: 1 }) },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: { overrideOf: () => 'ask', config: {} },
  }
  return { ctx: ctx as unknown as Context, owner, session }
}
it('reads effective official permissions and switches an idle session through its owner', async () => {
  const { ctx, owner, session } = fixture()
  expect(await sessionPermissions(ctx, { sessionId: 's1' }, false)).toMatchObject({
    preset: 'workspace-write',
    sandbox: 'workspace-write',
    approval: 'ask',
    running: false,
  })
  await sessionPermissions(ctx, { sessionId: 's1', preset: 'danger-full-access' }, true)
  expect(owner.set).toHaveBeenCalledWith(session, 'danger-full-access')
})
it('rejects changes during execution and rejects unknown or missing presets before writing', async () => {
  const { ctx, owner } = fixture(true)
  await expect(
    sessionPermissions(ctx, { sessionId: 's1', preset: 'danger-full-access' }, true),
  ).rejects.toThrow('permissions-busy')
  await expect(sessionPermissions(ctx, { sessionId: 's1', preset: 'bad' }, true)).rejects.toThrow(
    'unknown preset',
  )
  await expect(sessionPermissions(ctx, { sessionId: 's1' }, true)).rejects.toThrow(
    'requires preset',
  )
  expect(owner.set).not.toHaveBeenCalled()
})
