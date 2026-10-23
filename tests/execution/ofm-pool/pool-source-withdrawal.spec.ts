/**
 * A model source withdrawn while the shell preflight is still awaiting.
 *
 * This is the chief's fourth negative, restated against the required contract: the
 * shared registry exposes `lease()`, and the adapter captures it before the first
 * await and re-checks it after the last one. Only the shell preflight is stubbed, so
 * the moment of withdrawal is controlled; the registry, the lease and the launch
 * vector are the real shared code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import { POOL_HARNESS, POOL_LAGUNA_S } from '../../../src/execution/host/adapters/pool/index.ts'
import { ctx, owner, poolRecord, poolRef, scratchRoot } from './fixtures/records.ts'
import type { AdapterOptions } from '../../../src/execution/host/adapters/types.ts'

const gate = vi.hoisted(() => ({
  entered: undefined as undefined | (() => void),
  release: undefined as undefined | (() => void),
}))

vi.mock('../../../src/execution/host/adapters/pool/pool-bash.ts', () => ({
  poolSettingsPath: (home: string) => join(home, 'settings.yaml'),
  poolShellEnvironment: async () => {
    gate.entered?.()
    await new Promise<void>((resolve) => {
      gate.release = resolve
    })
    return {}
  },
}))

// Imported after the mock so `prepare` binds to the stubbed preflight.
const { poolAdapter } = await import('../../../src/execution/host/adapters/pool/pool.ts')

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

const suiteHome = () => {
  const home = join(scratchRoot(), 'opl-pool-withdrawal')
  homes.push(home)
  return home
}

const options = (modelSources: ExternalModelSources, home: string) =>
  ({
    home,
    // Any existing executable proves the launch vector; the point of this test is the
    // withdrawal, not the binary, so the Host's own runtime stands in for the CLI.
    command: process.execPath,
    grokCommand: 'unused',
    nativeBridgePath: 'unused',
    modelSources,
  }) as unknown as AdapterOptions

describe('source withdrawn while the shell preflight is awaiting', () => {
  it('returns no launch, even though the route was resolved before the withdrawal', async () => {
    const sources = new ExternalModelSources(ctx)
    const dispose = sources.register(owner, {
      provider: 'our-free-model',
      supports: (harness: string, ref: { model: string }) =>
        harness === POOL_HARNESS && ref.model === POOL_LAGUNA_S,
      resolve: async () => ({
        baseURL: 'https://ofm.example.test/v1',
        model: POOL_LAGUNA_S,
        apiKey: 'fixture-only',
        protocol: 'chat',
      }),
    })
    const entered = new Promise<void>((resolve) => {
      gate.entered = resolve
    })
    const pending = poolAdapter.prepare!(ctx, poolRecord(), options(sources, suiteHome()))
    await entered
    // The pairing disappears after the route was read and after the lease was
    // captured, while the adapter is still inside its last await.
    dispose()
    gate.release!()
    await expect(pending).rejects.toThrow(/模型来源在启动准备期间已变更/u)
  })

  it('still returns a launch when nothing was withdrawn', async () => {
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, {
      provider: 'our-free-model',
      supports: (harness: string, ref: { model: string }) =>
        harness === POOL_HARNESS && ref.model === POOL_LAGUNA_S,
      resolve: async () => ({
        baseURL: 'https://ofm.example.test/v1',
        model: POOL_LAGUNA_S,
        apiKey: 'fixture-only',
        protocol: 'chat',
      }),
    })
    const entered = new Promise<void>((resolve) => {
      gate.entered = resolve
    })
    const pending = poolAdapter.prepare!(ctx, poolRecord(), options(sources, suiteHome()))
    await entered
    gate.release!()
    const launch = await pending
    expect(launch.args.some((arg) => arg.startsWith('--settings='))).toBe(true)
    expect(launch.env.POOLSIDE_STANDALONE_MODEL).toBe(POOL_LAGUNA_S)
  })

  it('refuses a registry without the required lease instead of degrading', async () => {
    const legacy = {
      supports: () => true,
      resolve: async () => ({
        baseURL: 'https://ofm.example.test/v1',
        model: POOL_LAGUNA_S,
        apiKey: 'fixture-only',
        protocol: 'chat',
      }),
    }
    const entered = new Promise<void>((resolve) => {
      gate.entered = resolve
    })
    const pending = poolAdapter.prepare!(ctx, poolRecord(), options(legacy as never, suiteHome()))
    await Promise.race([entered, pending.catch(() => undefined)])
    await expect(pending).rejects.toThrow(/lease/u)
  })

  it('names the exact pairing it refused to capture', async () => {
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, {
      provider: 'our-free-model',
      supports: () => false,
      resolve: async () => ({
        baseURL: 'https://ofm.example.test/v1',
        model: POOL_LAGUNA_S,
        apiKey: 'x',
        protocol: 'chat',
      }),
    })
    const pending = poolAdapter.prepare!(
      ctx,
      poolRecord({ modelRef: poolRef(POOL_LAGUNA_S) }),
      options(sources, suiteHome()),
    )
    await expect(pending).rejects.toThrow(/尚未适配此 Harness|不属于官方 pool/u)
  })
})
