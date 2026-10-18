import { expect, it } from 'vitest'
import { defaultExecutionCatalog, normalizeCatalog } from '../../src/execution/host/catalog.ts'
import { ExecutionModelResolver } from '../../src/execution/host/execution-models.ts'
import {
  isHiddenOfmSelection,
  OFM_CLIENT_REJECTED_MODELS,
  OFM_OPENCODE_DIRECTORY_ONLY_MODELS,
  OFM_OPENCODE_OFFICIAL_FREE_MODELS,
  officialOpenCodeModel,
} from '../../src/execution/host/ofm-source/selection-policy.ts'
import { OPENCODE_OFM_MODELS } from '../../src/execution/host/adapters/opencode/opencode-models.ts'

/**
 * The OpenCode free-directory lanes this round could pair: each is published by the owning
 * OFM plugin's live free lane, so an exact `our-free-model` combination exists to bind.
 */
const NEW_OPENCODE_FREE_LANES = ['beam-free', 'nemotron-3.5-super-vl-free', 'glm-5.3-flash-free']

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
  expect(
    officialOpenCodeModel({
      provider: 'our-free-model',
      model: 'nvidia/nemotron-3.5-super-vl:free',
    }),
  ).toBeUndefined()
})

it('routes the new OpenCode free-directory lanes to the CLI free provider, not to an alias', () => {
  for (const model of NEW_OPENCODE_FREE_LANES) {
    // The wire value is the directory's own `opencode/<id>`; the DSH provider stays OFM.
    expect(officialOpenCodeModel({ provider: 'our-free-model', model })).toBe('opencode/' + model)
    expect(officialOpenCodeModel({ provider: 'our-free-model-region', model })).toBeUndefined()
    expect(officialOpenCodeModel({ provider: 'custom', model })).toBeUndefined()
  }
  // The provider-qualified twin is a different route and is never rewritten into the bare
  // free lane; an earlier revision aliased it and the branch deliberately stopped.
  expect(
    officialOpenCodeModel({
      provider: 'our-free-model',
      model: 'nvidia/nemotron-3.5-super-vl:free',
    }),
  ).toBeUndefined()
})

it('routes only lanes the OpenCode adapter itself declares, and keeps them in the picker', () => {
  for (const model of OFM_OPENCODE_OFFICIAL_FREE_MODELS) {
    expect(OPENCODE_OFM_MODELS).toContain(model)
    expect(isHiddenOfmSelection({ provider: 'our-free-model', model })).toBe(false)
  }
  for (const model of NEW_OPENCODE_FREE_LANES) expect(OPENCODE_OFM_MODELS).toContain(model)
})

it('never routes or re-admits an excluded lane through the free-provider mapping', () => {
  for (const model of ['jev-1.13-free', 'nvidia/nemotron-3.5-content-safety:free']) {
    expect(officialOpenCodeModel({ provider: 'our-free-model', model })).toBeUndefined()
    expect(isHiddenOfmSelection({ provider: 'our-free-model', model })).toBe(true)
    expect(OPENCODE_OFM_MODELS).not.toContain(model)
  }
  // GPT-OSS belongs to the Codex pairing only; OpenCode must not claim it either.
  expect(OPENCODE_OFM_MODELS).not.toContain('openai/gpt-oss-20b')
})

it('records the directory-only ids as refused instead of inventing an OFM lane', () => {
  // These exist in the official OpenCode directory but in no `our-free-model` lane — the
  // owning plugin publishes no combination for them — so there is nothing for DSH to
  // bind, pin, or verify. Recording the refusal is the decision; turning a directory id
  // into an adapter id would be guessing availability.
  expect(OFM_OPENCODE_DIRECTORY_ONLY_MODELS).toEqual(['exo-free', 'big-pickle', 'll-alpha-free'])
  for (const model of OFM_OPENCODE_DIRECTORY_ONLY_MODELS) {
    expect(OPENCODE_OFM_MODELS).not.toContain(model)
    expect(officialOpenCodeModel({ provider: 'our-free-model', model })).toBeUndefined()
    // Not hidden as an OFM exclusion either: they are simply unpublished, not banned.
    expect(isHiddenOfmSelection({ provider: 'our-free-model', model })).toBe(false)
    // A same-named model from another source keeps its own decision.
    expect(officialOpenCodeModel({ provider: 'custom', model })).toBeUndefined()
  }
})

it('binds the new free-directory lanes to the OpenCode harness and keeps OFM attribution', async () => {
  const catalog = defaultExecutionCatalog()
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
      listConfigurableProviders: () => [],
      listModels: async () => NEW_OPENCODE_FREE_LANES.map((id) => ({ id })),
    },
  }
  const store = {
    get: async () => catalog,
    cleanLegacyCombinations: async () => catalog,
  }
  const resolved = await new ExecutionModelResolver(ctx as never, store as never).resolve()
  for (const model of NEW_OPENCODE_FREE_LANES) {
    expect(resolved.models.find((item) => item.ref.model === model)).toMatchObject({
      source: 'OpenCode 官方免费通道',
    })
    const bound = resolved.combinations.filter(
      (item) => item.modelRef.provider === 'our-free-model' && item.modelRef.model === model,
    )
    expect(bound).not.toHaveLength(0)
    for (const combination of bound) expect(combination.harnessRef).toBe('opencode')
    expect(
      resolved.combinations.some(
        (item) => item.modelRef.model === model && item.harnessRef === 'dsh',
      ),
    ).toBe(false)
  }
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

it.each(['opencode/glm-5.3-flash-free', 'opencode/deepseek-v4.1-flash-free'])(
  'binds EAC %s to OpenCode while preserving the OFM forwarding route',
  async (model) => {
    const catalog = defaultExecutionCatalog()
    const ctx = {
      get: () => undefined,
      llm: {
        listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
        listConfigurableProviders: () => [],
        listModels: async () => [{ id: model }],
      },
    }
    const store = { get: async () => catalog, cleanLegacyCombinations: async () => catalog }
    const resolved = await new ExecutionModelResolver(ctx as never, store as never).resolve()
    expect(resolved.models.find((item) => item.ref.model === model)).toMatchObject({
      source: 'Our Free Model',
    })
    const combinations = resolved.combinations.filter((item) => item.modelRef.model === model)
    expect(combinations).not.toHaveLength(0)
    expect(combinations.every((item) => item.harnessRef === 'opencode')).toBe(true)
    expect(officialOpenCodeModel({ provider: 'our-free-model', model })).toBeUndefined()
    expect(OPENCODE_OFM_MODELS).toContain(model)
  },
)

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
