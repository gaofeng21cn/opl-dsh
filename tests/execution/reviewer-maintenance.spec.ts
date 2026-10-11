import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessService } from '../../src/execution/host/harness.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'opl-reviewer-maintenance-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const agents: { status: string }[] = []
  const activity = vi.fn(async () => [] as unknown[])
  const ctx = {
    agents: { list: () => agents },
    sessions: { list: () => [{ id: 'another-project' }] },
    get: () => undefined,
    waterfall: activity,
  } as unknown as Context
  const service = new HarnessService(ctx, { home: root })
  cleanup.push(() => service.dispose())
  return { service, agents, activity }
}

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('reviewer settings publication', () => {
  it('refuses a native agent and public workspace activity before publishing', async () => {
    const { service, agents, activity } = await setup()
    const publish = vi.fn(async () => 'saved')
    agents.push({ status: 'running' })
    await expect(service.changeReviewerSettings(publish)).rejects.toThrow('活动任务')
    agents.length = 0
    activity.mockResolvedValue([{ family: 'job' }])
    await expect(service.changeReviewerSettings(publish)).rejects.toThrow('活动任务')
    expect(publish).not.toHaveBeenCalled()
  })

  it('rejects activity appearing while the public workspace check is pending', async () => {
    const { service, agents, activity } = await setup()
    const entered = barrier(),
      pending = barrier()
    activity.mockImplementationOnce(async () => {
      entered.release()
      await pending.promise
      return []
    })
    const publish = vi.fn(async () => 'saved')
    const change = service.changeReviewerSettings(publish)
    const outcome = expect(change).rejects.toThrow('活动任务')
    await entered.promise
    agents.push({ status: 'running' })
    pending.release()
    await outcome
    expect(publish).not.toHaveBeenCalled()
  })

  it('holds native and external admission exclusion until the settings write settles', async () => {
    const { service } = await setup()
    const entered = barrier(),
      pending = barrier()
    const change = service.changeReviewerSettings(async () => {
      entered.release()
      await pending.promise
      return 'saved'
    })
    try {
      await entered.promise
      expect(() => service.assertRuntimeAvailable()).toThrow('切换')
      await expect(service.start({} as never)).rejects.toThrow('切换')
      await expect(service.prompt({} as never)).rejects.toThrow('切换')
      await expect(service.changeReviewerSettings(async () => 'second')).rejects.toThrow('切换')
    } finally {
      pending.release()
      expect(await change).toBe('saved')
    }
    expect(() => service.assertRuntimeAvailable()).not.toThrow()
  })

  it('releases exclusion on failed publication and refuses an unreadable activity source', async () => {
    const { service, activity } = await setup()
    await expect(
      service.changeReviewerSettings(async () => {
        throw Error('owned publication failure')
      }),
    ).rejects.toThrow('owned publication failure')
    expect(() => service.assertRuntimeAvailable()).not.toThrow()
    activity.mockRejectedValue(Error('owned activity read failure'))
    const publish = vi.fn(async () => 'saved')
    await expect(service.changeReviewerSettings(publish)).rejects.toThrow(
      'owned activity read failure',
    )
    expect(publish).not.toHaveBeenCalled()
    expect(() => service.assertRuntimeAvailable()).not.toThrow()
  })
})
