import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { EngineUpdates } from '../../src/execution/host/engine-updates.ts'

it('checks without installing, skips a busy engine and cancels pending automatic updates when disabled', async () => {
  const home = await mkdtemp(join(tmpdir(), 'engine-maint-'))
  const install = vi.fn(async () => '2.0.0')
  const jobs = {
    list: async () =>
      ['busy', 'idle'].map((id) => ({
        id,
        name: id,
        installed: true,
        runnable: true,
        instructions: '',
        website: '',
      })),
    probe: async (i: { id: string }) => ({
      id: i.id,
      name: i.id,
      current: '1.0.0',
      target: '2.0.0',
      status: 'available' as const,
    }),
    install,
    busy: (id: string) => id === 'busy',
    log: () => {},
  }
  const service = new EngineUpdates(home, jobs)
  try {
    await service.check()
    await vi.waitFor(async () => expect((await service.snapshot()).checking).toBe(false))
    expect(install).not.toHaveBeenCalled()
    await service.settings({ enabled: true, mode: 'auto' })
    await vi.waitFor(async () =>
      expect((await service.snapshot()).items.map((i) => i.status)).toEqual(['waiting', 'updated']),
    )
    await service.settings({ enabled: false, mode: 'notify' })
    expect((await service.snapshot()).items[0]?.status).toBe('available')
    expect(install).toHaveBeenCalledTimes(1)
    const reopened = new EngineUpdates(home, jobs)
    try {
      expect(await reopened.snapshot()).toMatchObject({ enabled: false, mode: 'notify' })
    } finally {
      await reopened.dispose()
    }
  } finally {
    await service.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it('fills three install slots and keeps external installers separate when a job fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'engine-parallel-'))
  const ids = ['claude', 'grok-build', 'opencode', 'pi', 'kilo']
  const gates = new Map(ids.map((id) => [id, Promise.withResolvers<string>()]))
  const calls: string[] = []
  const service = new EngineUpdates(home, {
    list: async () =>
      ids.map((id) => ({
        id,
        name: id,
        installed: true,
        runnable: true,
        instructions: '',
        website: '',
      })),
    probe: async ({ id }) => ({ id, name: id, status: 'available', target: '2.0.0' }),
    busy: () => false,
    install: async ({ id }) => {
      calls.push(id)
      return gates.get(id)!.promise
    },
    log: () => {},
  })
  try {
    await service.check()
    await vi.waitFor(async () => expect((await service.snapshot()).checking).toBe(false))
    const batch = await service.install(ids)
    expect(batch.items.filter((i) => i.status === 'installing').map((i) => i.id)).toEqual([
      'claude',
      'opencode',
      'pi',
    ])
    const first = service.lock('opencode')!
    gates.get('opencode')!.reject(Error('fixture failed'))
    await first
    expect(calls).toEqual(['claude', 'opencode', 'pi', 'kilo'])
    const external = service.lock('claude')!
    gates.get('claude')!.resolve('2.0.0')
    await external
    expect(calls).toEqual(['claude', 'opencode', 'pi', 'kilo', 'grok-build'])
    for (const gate of gates.values()) gate.resolve('2.0.0')
    await Promise.all(ids.map((id) => service.lock(id)))
    expect((await service.snapshot()).items.map((i) => i.status)).toEqual([
      'updated',
      'updated',
      'failed',
      'updated',
      'updated',
    ])
  } finally {
    for (const gate of gates.values()) gate.resolve('2.0.0')
    await service.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
