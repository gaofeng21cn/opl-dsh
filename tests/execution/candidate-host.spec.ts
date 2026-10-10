import { mkdtemp, readFile, rm, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as candidate from '../../src/execution/host/minimax-candidate.ts'
import { HarnessService } from '../../src/execution/host/harness.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanup.length) await cleanup.pop()!()
})

/** Static verification is replaced here; real catalog persistence and admission remain live. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'opl-candidate-host-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const agents: { status: string }[] = []
  const activity = vi.fn(async () => [] as unknown[])
  const ctx = {
    agents: { list: () => agents },
    sessions: { list: () => [{ id: 'other-project' }] },
    get: () => undefined,
    waterfall: activity,
  } as unknown as Context
  const service = new HarnessService(ctx, { home: root })
  cleanup.push(() => service.dispose())
  const prepare = vi
    .spyOn(candidate, 'prepareMiniMaxCandidate')
    .mockImplementation(({ version }) => ({
      command: join(root, version, 'mcode.cmd'),
      manifestSha256: 'manifest',
      launcherSha256: 'launcher',
    }))
  const current = async () =>
    (await service.executionCatalog()).harnesses.find((h) => h.id === 'minimax-code')!
  return { root, service, agents, activity, prepare, current }
}

describe('MiniMax runtime publication', () => {
  it('changes the actual persisted command and retains proxy and other Harness settings', async () => {
    const { root, service, current } = await setup()
    await service.saveHarnessProxy('minimax-code', { mode: 'custom', url: 'http://127.0.0.1:7897' })
    const old = await service.executionCatalog()
    const result = await service.selectMiniMaxCandidate({ version: 'candidate-1' })
    expect(result.previousCommand).toBe('mcode')
    expect(await current()).toMatchObject({
      command: result.command,
      prefix: [],
      proxy: { mode: 'custom', url: 'http://127.0.0.1:7897' },
    })
    expect(
      (await service.executionCatalog()).harnesses.filter((h) => h.id !== 'minimax-code'),
    ).toEqual(old.harnesses.filter((h) => h.id !== 'minimax-code'))
    const persisted = JSON.parse(
      await readFile(join(root, 'profiles/desktop/execution-catalog.json'), 'utf8'),
    )
    expect(persisted.harnesses.find((h: { id: string }) => h.id === 'minimax-code').command).toBe(
      result.command,
    )
  })
  it('refuses work from another project and background activity before candidate verification', async () => {
    const { service, agents, activity, prepare, current } = await setup()
    agents.push({ status: 'running' })
    await expect(service.selectMiniMaxCandidate({ version: 'candidate-1' })).rejects.toThrow(
      '活动任务',
    )
    agents.length = 0
    activity.mockResolvedValue([{ family: 'job' }])
    await expect(service.selectMiniMaxCandidate({ version: 'candidate-1' })).rejects.toThrow(
      '活动任务',
    )
    expect(prepare).not.toHaveBeenCalled()
    expect((await current()).command).toBe('mcode')
  })
  it('holds exclusion while a public activity read is pending', async () => {
    const { service, activity } = await setup()
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((done) => {
      enter = done
    })
    const pending = new Promise<unknown[]>((done) => {
      release = () => done([])
    })
    activity.mockImplementationOnce(() => {
      enter()
      return pending
    })
    const select = service.selectMiniMaxCandidate({ version: 'candidate-1' })
    try {
      await entered
      expect(() => service.assertRuntimeAvailable()).toThrow('切换')
      await expect(service.start({} as never)).rejects.toThrow('切换')
      await expect(service.prompt({} as never)).rejects.toThrow('切换')
      await expect(service.stopEdit({} as never)).rejects.toThrow('切换')
      await expect(service.saveHarnessProxy('minimax-code', { mode: 'direct' })).rejects.toThrow(
        '切换',
      )
    } finally {
      release()
      await select
    }
  })
  it('retains the selected runtime on a failed upgrade and can select the previous version', async () => {
    const { service, prepare, current } = await setup()
    const first = await service.selectMiniMaxCandidate({ version: 'candidate-1' })
    prepare.mockImplementationOnce(() => {
      throw Error('invalid manifest')
    })
    await expect(
      service.selectMiniMaxCandidate({ version: 'candidate-2', source: 'invalid' }),
    ).rejects.toThrow('invalid manifest')
    expect((await current()).command).toBe(first.command)
    const second = await service.selectMiniMaxCandidate({ version: 'candidate-2' })
    expect(second.previousCommand).toBe(first.command)
    await service.selectMiniMaxCandidate({ version: 'candidate-1' })
    expect((await current()).command).toBe(first.command)
  })
  it('retains memory and disk selection when catalog persistence fails', async () => {
    const { root, service, current } = await setup()
    const first = await service.selectMiniMaxCandidate({ version: 'candidate-1' })
    const directory = join(root, 'profiles/desktop')
    await rename(directory, directory + '-kept')
    await writeFile(directory, 'owned write failure')
    try {
      await expect(service.selectMiniMaxCandidate({ version: 'candidate-2' })).rejects.toThrow()
      expect((await current()).command).toBe(first.command)
    } finally {
      await rm(directory)
      await rename(directory + '-kept', directory)
    }
    const persisted = JSON.parse(await readFile(join(directory, 'execution-catalog.json'), 'utf8'))
    expect(persisted.harnesses.find((h: { id: string }) => h.id === 'minimax-code').command).toBe(
      first.command,
    )
    service.assertRuntimeAvailable()
  })
})
