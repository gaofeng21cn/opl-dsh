/**
 * The chief review's four negatives, kept as owned tests so they cannot regress.
 *
 * Each one describes a failure that produced real configuration writes or a startable
 * launch on the user's official session. The chief's spec is preserved at
 * `ofm-harness-adaptation/pool/chief-negatives.spec.ts`; this file restates the same
 * behaviour through the owned fixtures so it runs in the repository suite.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessConfigurationError } from '../../../src/execution/host/acp.ts'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import {
  POOL_HARNESS,
  POOL_LAGUNA_S,
  POOL_LAGUNA_XS,
  POOL_MODE_OPTION,
  POOL_MODEL_OPTION,
  capturePoolSourceGuard,
  poolAdapter,
} from '../../../src/execution/host/adapters/pool/index.ts'
import {
  ctx,
  owner,
  poolRecord,
  poolRef,
  poolSource,
  poolSources,
  route,
  scratchRoot,
} from './fixtures/records.ts'
import type {
  AdapterOptions,
  AcpSessionSnapshot,
} from '../../../src/execution/host/adapters/types.ts'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

const snapshot = (model = POOL_LAGUNA_S, mode = 'default'): AcpSessionSnapshot =>
  ({
    agent: { agentInfo: { name: 'pool-acp', version: '1.0.16' } },
    session: { sessionId: 'acp-1' },
    configOptions: [
      {
        id: POOL_MODEL_OPTION,
        currentValue: model,
        options: [{ value: POOL_LAGUNA_S }, { value: POOL_LAGUNA_XS }],
      },
      {
        id: POOL_MODE_OPTION,
        currentValue: mode,
        options: [{ value: 'default' }, { value: 'always-allow' }],
      },
    ],
  }) as unknown as AcpSessionSnapshot

describe('chief negative 1: a session that stops advertising its pinned values', () => {
  it('refuses to send the next prompt when the advertisement is missing', () => {
    expect(() =>
      poolAdapter.verifySession!(poolRecord(), { ...snapshot(), configOptions: undefined }),
    ).toThrow(HarnessConfigurationError)
  })

  it('refuses when the advertisement is present but carries no select options', () => {
    expect(() =>
      poolAdapter.verifySession!(poolRecord(), { ...snapshot(), configOptions: {} }),
    ).toThrow(/未广告配置项/u)
  })

  it('still refuses a drifted value, so the missing advertisement is not a special case', () => {
    expect(() => poolAdapter.verifySession!(poolRecord(), snapshot(POOL_LAGUNA_XS))).toThrow(
      /会话 model 与要求的/u,
    )
    expect(() =>
      poolAdapter.verifySession!(poolRecord(), snapshot(POOL_LAGUNA_S, 'default')),
    ).toThrow(/会话 mode 与要求的/u)
  })
})

describe('chief negative 2: a record this harness does not own', () => {
  it('writes nothing when the provider is foreign, even with the same model id', async () => {
    const request = vi.fn(async () => ({
      configOptions: snapshot(POOL_LAGUNA_S, 'always-allow').configOptions,
    }))
    const record = poolRecord({ modelRef: { provider: 'other-provider', model: POOL_LAGUNA_S } })
    await expect(poolAdapter.configureSession!({ request }, record, snapshot())).rejects.toThrow(
      HarnessConfigurationError,
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('writes nothing when the id is this provider but not a pinned pool model', async () => {
    const request = vi.fn(async () => ({ configOptions: snapshot().configOptions }))
    const record = poolRecord({ modelRef: poolRef('poolside/laguna-s-2.1') })
    await expect(poolAdapter.configureSession!({ request }, record, snapshot())).rejects.toThrow(
      /不属于官方 pool 可固定的组合/u,
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses the same foreign record in verifySession before any prompt', () => {
    const record = poolRecord({ modelRef: { provider: 'other-provider', model: POOL_LAGUNA_S } })
    expect(() => poolAdapter.verifySession!(record, snapshot())).toThrow(HarnessConfigurationError)
  })
})

describe('chief negative 3: the last write quietly changes another pinned value', () => {
  it('refuses when the mode reply reports a different model', async () => {
    const request = vi.fn(async (_method: string, params: any) => ({
      configOptions:
        params.configId === POOL_MODE_OPTION
          ? snapshot(POOL_LAGUNA_XS, 'always-allow').configOptions
          : snapshot().configOptions,
    }))
    await expect(
      poolAdapter.configureSession!({ request }, poolRecord(), snapshot()),
    ).rejects.toThrow(/会话 model 与要求的/u)
  })

  it('refuses when the model reply silently drops the permission mode', async () => {
    const request = vi.fn(async (_method: string, params: any) => ({
      configOptions:
        params.configId === POOL_MODEL_OPTION
          ? [snapshot().configOptions[0]]
          : snapshot(POOL_LAGUNA_S, 'always-allow').configOptions,
    }))
    await expect(
      poolAdapter.configureSession!({ request }, poolRecord(), snapshot()),
    ).rejects.toThrow(/未广告 mode 配置项/u)
  })

  it('re-checks a pinned thought level after the final mode write', async () => {
    const withThought = {
      ...snapshot(),
      configOptions: [
        ...snapshot().configOptions,
        {
          id: 'thought_level',
          currentValue: 'none',
          options: [{ value: 'none' }, { value: 'high' }],
        },
      ],
    } as unknown as AcpSessionSnapshot
    const request = vi.fn(async (_method: string, params: any) => ({
      configOptions:
        params.configId === POOL_MODE_OPTION
          ? (withThought.configOptions as any[]).map((option) =>
              option.id === 'thought_level' ? { ...option, currentValue: 'none' } : option,
            )
          : (withThought.configOptions as any[]).map((option) =>
              option.id === 'thought_level' ? { ...option, currentValue: 'high' } : option,
            ),
    }))
    const record = poolRecord({ reasoningEffort: 'high' })
    await expect(poolAdapter.configureSession!({ request }, record, withThought)).rejects.toThrow(
      /会话 thought_level 与要求的/u,
    )
  })
})

describe('chief negative 4: source generation, checked against the real registry', () => {
  it('refuses a lease after the registration is unloaded', () => {
    const sources = new ExternalModelSources(ctx)
    const dispose = sources.register(owner, poolSource(route()))
    const assertCurrent = capturePoolSourceGuard(sources, poolRef(POOL_LAGUNA_S))
    expect(() => assertCurrent()).not.toThrow()
    dispose()
    expect(() => assertCurrent()).toThrow(/模型来源在启动准备期间已变更/u)
  })

  it('refuses a lease whose registration was replaced by a different source', () => {
    const sources = new ExternalModelSources(ctx)
    const disposeFirst = sources.register(owner, poolSource(route()))
    const assertCurrent = capturePoolSourceGuard(sources, poolRef(POOL_LAGUNA_S))
    disposeFirst()
    sources.register(owner, poolSource(route({ apiKey: 'replacement' })))
    expect(() => assertCurrent()).toThrow(/模型来源在启动准备期间已变更/u)
  })

  it('refuses a lease after the very same source object is unregistered and re-registered', () => {
    // Same provider name and same source instance: only a captured generation sees
    // that the registration was replaced, which a `supports()` check cannot.
    const sources = new ExternalModelSources(ctx)
    const same = poolSource(route())
    const disposeFirst = sources.register(owner, same)
    const assertCurrent = capturePoolSourceGuard(sources, poolRef(POOL_LAGUNA_S))
    disposeFirst()
    sources.register(owner, same)
    expect(() => assertCurrent()).toThrow(/模型来源在启动准备期间已变更/u)
  })

  it('refuses when the re-registered source no longer declares the pairing', () => {
    const sources = new ExternalModelSources(ctx)
    const disposeFirst = sources.register(owner, poolSource(route()))
    const assertCurrent = capturePoolSourceGuard(sources, poolRef(POOL_LAGUNA_S))
    disposeFirst()
    sources.register(owner, {
      ...poolSource(route()),
      supports: () => false,
    })
    expect(() => assertCurrent()).toThrow(/模型来源在启动准备期间已变更/u)
  })

  it('accepts a lease that is still current', () => {
    const sources = poolSources(poolSource(route()))
    expect(() => capturePoolSourceGuard(sources, poolRef(POOL_LAGUNA_S))()).not.toThrow()
  })

  it('refuses to capture a pairing the registry does not declare', () => {
    const sources = poolSources(poolSource(route({ model: POOL_LAGUNA_XS })))
    expect(() => capturePoolSourceGuard(sources, poolRef(POOL_LAGUNA_S))).toThrow(
      /尚未适配此 Harness/u,
    )
  })

  it('refuses a registry that does not expose the required lease contract', () => {
    const legacy = {
      supports: () => true,
      resolve: async () => route(),
    } as unknown as ExternalModelSources
    // No silent degradation to a weaker name-level check.
    expect(() => capturePoolSourceGuard(legacy, poolRef(POOL_LAGUNA_S))).toThrow(
      /未提供 lease\(\) 代次租约/u,
    )
  })

  it('returns no launch when the source unregisters itself while resolving', async () => {
    const home = join(scratchRoot(), 'opl-pool-withdrawn')
    const sources = new ExternalModelSources(ctx)
    const dispose = sources.register(owner, {
      provider: 'our-free-model',
      supports: (harness: string, ref: { model: string }) =>
        harness === POOL_HARNESS && ref.model === POOL_LAGUNA_S,
      resolve: async () => {
        dispose()
        return route()
      },
    })
    await expect(
      poolAdapter.prepare!(ctx, poolRecord(), {
        home,
        grokCommand: 'unused',
        nativeBridgePath: 'unused',
        command: process.env.OPL_POOL_TEST_BIN ?? 'pool',
        modelSources: sources,
      } as unknown as AdapterOptions),
    ).rejects.toThrow(/模型来源已变更/u)
    await rm(home, { recursive: true, force: true })
  })
})

describe('chief admission gate: the startup advertisement before any write', () => {
  it('writes nothing when the session starts without an advertisement', async () => {
    const request = vi.fn(async () => ({
      configOptions: [
        { id: POOL_MODEL_OPTION, currentValue: POOL_LAGUNA_S, options: [{ value: POOL_LAGUNA_S }] },
        {
          id: POOL_MODE_OPTION,
          currentValue: 'always-allow',
          options: [{ value: 'always-allow' }],
        },
      ],
    }))
    const missing = { ...snapshot(), configOptions: undefined } as unknown as AcpSessionSnapshot
    await expect(poolAdapter.configureSession!({ request }, poolRecord(), missing)).rejects.toThrow(
      /未广告配置项/u,
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('writes nothing when the startup advertisement lacks the model arm', async () => {
    const request = vi.fn(async () => ({ configOptions: snapshot().configOptions }))
    const onlyMode = {
      ...snapshot(),
      configOptions: [snapshot().configOptions[1]],
    } as unknown as AcpSessionSnapshot
    await expect(
      poolAdapter.configureSession!({ request }, poolRecord(), onlyMode),
    ).rejects.toThrow(/缺少 model 配置项/u)
    expect(request).not.toHaveBeenCalled()
  })

  it('writes nothing when the startup advertisement lacks the permission mode arm', async () => {
    const request = vi.fn(async () => ({ configOptions: snapshot().configOptions }))
    const onlyModel = {
      ...snapshot(),
      configOptions: [snapshot().configOptions[0]],
    } as unknown as AcpSessionSnapshot
    await expect(
      poolAdapter.configureSession!({ request }, poolRecord(), onlyModel),
    ).rejects.toThrow(/缺少 mode 配置项/u)
    expect(request).not.toHaveBeenCalled()
  })

  it('writes nothing when the startup advertisement does not offer the chosen model', async () => {
    // The write reply agrees with the request, but the startup advertisement does not
    // list the requested id, so the write must never have been sent at all.
    const request = vi.fn(async () => ({
      configOptions: [
        { id: POOL_MODEL_OPTION, currentValue: POOL_LAGUNA_S, options: [{ value: POOL_LAGUNA_S }] },
        {
          id: POOL_MODE_OPTION,
          currentValue: 'always-allow',
          options: [{ value: 'always-allow' }],
        },
      ],
    }))
    const narrow = {
      ...snapshot(),
      configOptions: [
        {
          id: POOL_MODEL_OPTION,
          currentValue: POOL_LAGUNA_XS,
          options: [{ value: POOL_LAGUNA_XS }],
        },
        snapshot().configOptions[1],
      ],
    } as unknown as AcpSessionSnapshot
    await expect(poolAdapter.configureSession!({ request }, poolRecord(), narrow)).rejects.toThrow(
      /不含所需取值/u,
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('writes nothing when an explicit thought level is not advertised up front', async () => {
    const request = vi.fn(async () => ({ configOptions: snapshot().configOptions }))
    await expect(
      poolAdapter.configureSession!(
        { request },
        poolRecord({ reasoningEffort: 'high' }),
        snapshot(),
      ),
    ).rejects.toThrow(/缺少 thought_level 配置项/u)
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses the same missing advertisement before the next prompt', () => {
    expect(() =>
      poolAdapter.verifySession!(poolRecord(), { ...snapshot(), configOptions: undefined }),
    ).toThrow(/未广告配置项/u)
    expect(() =>
      poolAdapter.verifySession!(poolRecord(), { ...snapshot(), configOptions: {} }),
    ).toThrow(/未广告配置项/u)
  })
})
