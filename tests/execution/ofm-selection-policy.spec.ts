import { expect, it } from 'vitest'
import { defaultExecutionCatalog, normalizeCatalog } from '../../src/execution/host/catalog.ts'
import { ExecutionModelResolver } from '../../src/execution/host/execution-models.ts'
import { OFM_CLIENT_REJECTED_MODELS } from '../../src/execution/host/ofm-source/selection-policy.ts'

it('hides rejected OFM lanes and saved combinations after legacy cleanup, without hiding other sources', async () => {
  const stored = defaultExecutionCatalog()
  stored.combinations[0]!.name = 'DeepSeek + DSH'
  for (const provider of ['our-free-model', 'our-free-model-region'])
    for (const model of OFM_CLIENT_REJECTED_MODELS)
      stored.combinations.push({
        id: provider + ':' + model,
        name: model,
        modelRef: { provider, model },
        harnessRef: 'opencode',
        permissionPolicy: 'workspace',
        isDefault: true,
        enabled: true,
      })
  const models = [
    ...OFM_CLIENT_REJECTED_MODELS,
    'stepfun/step-5-preview-free',
    'nvidia/nemotron-3.5-lightning:free',
    'kilo-auto/free',
    'nvidia/nemotron-3.5-super-vl:free',
  ]
  const providers = ['our-free-model', 'our-free-model-region', 'custom']
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => providers.map((id) => ({ id, name: id })),
      listConfigurableProviders: () => [],
      listModels: async () => models.map((id) => ({ id })),
    },
  }
  const store = {
    get: async () => structuredClone(stored),
    cleanLegacyCombinations: async () => {
      const copy = structuredClone(stored)
      copy.combinations[0]!.name = 'DeepSeek'
      return copy
    },
  }
  const resolved = await new ExecutionModelResolver(ctx as never, store as never).resolve()
  for (const provider of providers) {
    const ids = resolved.models.filter((m) => m.ref.provider === provider).map((m) => m.ref.model)
    for (const model of OFM_CLIENT_REJECTED_MODELS)
      expect(ids.includes(model)).toBe(provider === 'custom')
    expect(ids).toContain('stepfun/step-5-preview-free')
    expect(ids).toContain('nvidia/nemotron-3.5-lightning:free')
  }
  expect(
    resolved.combinations
      .filter((c) => c.modelRef.provider.startsWith('our-free-model'))
      .every((c) => !OFM_CLIENT_REJECTED_MODELS.includes(c.modelRef.model)),
  ).toBe(true)
  expect(stored.combinations).toHaveLength(6)
})

it('assigns the new Nemotron Super VL lane to OpenCode instead of native DSH', async () => {
  const catalog = defaultExecutionCatalog()
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
      listConfigurableProviders: () => [],
      listModels: async () => [{ id: 'nvidia/nemotron-3.5-super-vl:free' }],
    },
  }
  const store = {
    get: async () => catalog,
    cleanLegacyCombinations: async () => catalog,
  }
  const resolved = await new ExecutionModelResolver(ctx as never, store as never).resolve()
  expect(resolved.combinations).toContainEqual(
    expect.objectContaining({
      modelRef: { provider: 'our-free-model', model: 'nvidia/nemotron-3.5-super-vl:free' },
      harnessRef: 'opencode',
    }),
  )
  expect(
    resolved.combinations.some(
      (item) =>
        item.modelRef.model === 'nvidia/nemotron-3.5-super-vl:free' && item.harnessRef === 'dsh',
    ),
  ).toBe(false)
  expect(
    resolved.models.find((item) => item.ref.model === 'nvidia/nemotron-3.5-super-vl:free'),
  ).toMatchObject({ source: 'Our Free Model' })
})

it('keeps Nemotron Super VL in the OFM channel while using the OpenCode harness', async () => {
  const { officialOpenCodeModel } = await import(
    '../../src/execution/host/ofm-source/selection-policy.ts'
  )
  expect(
    officialOpenCodeModel({
      provider: 'our-free-model',
      model: 'nvidia/nemotron-3.5-super-vl:free',
    }),
  ).toBeUndefined()
})

it('keeps native DSH combinations for models supplied by the OFM plugin', async () => {
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
      listConfigurableProviders: () => [],
      listModels: async () => [{ id: 'opl-qualification-free' }],
    },
  }
  const catalog = defaultExecutionCatalog()
  const store = {
    get: async () => catalog,
    cleanLegacyCombinations: async () => catalog,
  }
  const resolved = await new ExecutionModelResolver(ctx as never, store as never).resolve()
  expect(resolved.combinations).toContainEqual(
    expect.objectContaining({
      modelRef: { provider: 'our-free-model', model: 'opl-qualification-free' },
      harnessRef: 'dsh',
    }),
  )
})

it('omits empty default harness setups but retains an explicitly configured existing engine', () => {
  const fresh = defaultExecutionCatalog()
  for (const id of ['mimo-code', 'muse-code'])
    expect(fresh.harnesses.some((h) => h.id === id)).toBe(false)
  for (const id of ['opencode', 'step-code', 'pool'])
    expect(fresh.harnesses.some((h) => h.id === id)).toBe(true)
  fresh.harnesses.push({
    id: 'muse-code',
    name: 'Existing Muse',
    kind: 'acp',
    command: 'custom-muse',
  })
  expect(normalizeCatalog(fresh).harnesses.find((h) => h.id === 'muse-code')?.command).toBe(
    'custom-muse',
  )
})
