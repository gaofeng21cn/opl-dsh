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
