import { afterEach, expect, it, vi } from 'vitest'
import { installPermissionMemory } from '../../src/compat/host/permission-memory.ts'

type Handler = (...args: any[]) => void

function fixture(lastPermissionPreset: string = 'workspace-write', existingIds: string[] = []) {
  const handlers = new Map<string, Handler>()
  const settings = {
    describe: vi.fn(() => [{ ns: 'opl-suite', value: { lastPermissionPreset }, revision: 4 }]),
    mutate: vi.fn(async () => undefined),
  }
  const permissionPresets = {
    current: vi.fn(() => 'workspace-write'),
    set: vi.fn(),
  }
  const ctx = {
    sessions: { list: () => existingIds.map((id) => ({ id })) },
    settings,
    permissionPresets,
    logger: { warn: vi.fn() },
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    }),
  }
  const dispose = installPermissionMemory(ctx as never)
  return { ctx, settings, permissionPresets, handlers, dispose }
}

afterEach(() => vi.restoreAllMocks())

it('applies the remembered preset only to a new blank Session', () => {
  const f = fixture('danger-full-access')
  const session = {
    id: 'fresh',
    snapshotEvents: () => [{ type: 'permission/preset' }],
  }
  f.handlers.get('session/created')!(session)
  expect(f.permissionPresets.set).toHaveBeenCalledExactlyOnceWith(session, 'danger-full-access')
  f.dispose()
})

it('does not widen an existing or seeded Session', () => {
  const f = fixture('danger-full-access', ['existing'])
  const existing = { id: 'existing', snapshotEvents: () => [{ type: 'permission/preset' }] }
  const seeded = {
    id: 'seeded',
    snapshotEvents: () => [{ type: 'permission/preset' }, { type: 'user/message' }],
  }
  f.handlers.get('session/created')!(existing)
  f.handlers.get('session/created')!(seeded)
  expect(f.permissionPresets.set).not.toHaveBeenCalled()
  f.dispose()
})

it('persists only supported explicit preset events', async () => {
  const f = fixture()
  const session = { id: 'known', snapshotEvents: () => [{ type: 'permission/preset' }] }
  f.handlers.get('session/created')!(session)
  f.handlers.get('session/event')!(session, {
    type: 'permission/preset',
    data: { preset: 'danger-full-access' },
  })
  await Promise.resolve()
  expect(f.settings.mutate).toHaveBeenCalledWith(
    'opl-suite',
    [{ op: 'set', path: ['lastPermissionPreset'], value: 'danger-full-access' }],
    4,
  )
  f.settings.mutate.mockClear()
  f.handlers.get('session/event')!(session, {
    type: 'permission/preset',
    data: { preset: 'auto' },
  })
  await Promise.resolve()
  expect(f.settings.mutate).not.toHaveBeenCalled()
  f.dispose()
})
