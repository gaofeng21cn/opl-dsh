import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { adapterFor, defaultHarness } from '../../src/execution/host/adapters/index.ts'
import {
  defaultExecutionCatalog,
  ExecutionCatalogStore,
  normalizeCatalog,
} from '../../src/execution/host/catalog.ts'
import { ExecutionModelResolver } from '../../src/execution/host/execution-models.ts'
import {
  isHiddenOfmSelection,
  OFM_CLIENT_REJECTED_MODELS,
  OFM_OPENCODE_DIRECTORY_ONLY_MODELS,
  OFM_OPENCODE_OFFICIAL_FREE_MODELS,
  officialOpenCodeModel,
} from '../../src/execution/host/ofm-source/selection-policy.ts'
import { OFM_PINNED_HARNESS_MODELS } from '../../src/execution/host/ofm-source/provider.ts'
import { OPENCODE_OFM_MODELS } from '../../src/execution/host/adapters/opencode/opencode-models.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const workspace = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opl-big-pickle-'))
  roots.push(dir)
  return dir
}

/**
 * The OpenCode free-directory lanes this round could pair: each is published by the owning
 * OFM plugin's live free lane, so an exact `our-free-model` combination exists to bind.
 */
const NEW_OPENCODE_FREE_LANES = ['beam-free', 'nemotron-3.5-super-vl-free', 'glm-5.3-flash-free']

const BIG_PICKLE = { provider: 'our-free-model', model: 'big-pickle' } as const
const BIG_PICKLE_AUTO = 'auto:["our-free-model","big-pickle"]'

it('pins MiniMax Flash free to OpenCode without folding its Kilo lane into the direct route', () => {
  const direct = 'minimax-m3.1-flash-free'
  const kilo = 'minimax/minimax-m3.1-flash:free'
  expect(officialOpenCodeModel({ provider: 'our-free-model', model: direct })).toBe(
    'opencode/' + direct,
  )
  expect(officialOpenCodeModel({ provider: 'our-free-model', model: kilo })).toBeUndefined()
  for (const model of [direct, kilo]) {
    expect(OPENCODE_OFM_MODELS).toContain(model)
    expect(OFM_PINNED_HARNESS_MODELS.opencode).toContain(model)
  }
})
const QUALIFICATION_AUTO = 'auto:["our-free-model","opl-qualification-free"]'

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

it('maps Big Pickle to the official OpenCode lane, pinning table and default Harness', () => {
  // The owning plugin publishes the exact `our-free-model` lane; the official directory
  // serves it as `opencode/big-pickle` on Chat Completions. Nothing is aliased.
  expect(officialOpenCodeModel(BIG_PICKLE)).toBe('opencode/big-pickle')
  expect(OPENCODE_OFM_MODELS).toContain('big-pickle')
  expect(OFM_OPENCODE_OFFICIAL_FREE_MODELS).toContain('big-pickle')
  expect(OFM_PINNED_HARNESS_MODELS.opencode).toContain('big-pickle')
  expect(isHiddenOfmSelection(BIG_PICKLE)).toBe(false)
  // The OpenCode adapter declares it, the automatic Harness resolves to OpenCode, and the
  // account-channel route still has no claim on it.
  expect(adapterFor('opencode', BIG_PICKLE)?.id).toBe('opencode')
  expect(defaultHarness(BIG_PICKLE)).toBe('opencode')
  expect(
    officialOpenCodeModel({ provider: 'our-free-model-region', model: 'big-pickle' }),
  ).toBeUndefined()
})

it('uses OpenCode for Flint through the registered OFM route', () => {
  const ref = { provider: 'our-free-model', model: 'flint-40b-free' }
  expect(officialOpenCodeModel(ref)).toBeUndefined()
  expect(OPENCODE_OFM_MODELS).toContain(ref.model)
  expect(OFM_PINNED_HARNESS_MODELS.opencode).toContain(ref.model)
  expect(isHiddenOfmSelection(ref)).toBe(false)
  expect(defaultHarness(ref)).toBe('opencode')
})

it('binds Big Pickle to OpenCode while keeping the OFM source and its real id', async () => {
  const catalog = defaultExecutionCatalog()
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
      listConfigurableProviders: () => [],
      listModels: async () => [{ id: 'big-pickle' }],
    },
  }
  const store = {
    get: async () => catalog,
    cleanLegacyCombinations: async () => catalog,
  }
  const resolved = await new ExecutionModelResolver(ctx as never, store as never).resolve()
  expect(resolved.models.find((item) => item.ref.model === 'big-pickle')).toMatchObject({
    ref: { provider: 'our-free-model', model: 'big-pickle' },
    source: 'OpenCode 官方免费通道',
    available: true,
  })
  const combinations = resolved.combinations.filter((item) => item.modelRef.model === 'big-pickle')
  expect(combinations).not.toHaveLength(0)
  expect(combinations.every((item) => item.harnessRef === 'opencode')).toBe(true)
  // The default combination is generated for OpenCode; no Big Pickle + DSH default exists.
  expect(
    combinations.some((item) => item.generated && item.isDefault && item.harnessRef === 'opencode'),
  ).toBe(true)
  expect(combinations.some((item) => item.harnessRef === 'dsh')).toBe(false)
})

it('drops a generated Big Pickle DSH row before it can be persisted', () => {
  const catalog = defaultExecutionCatalog()
  catalog.combinations.push({
    id: BIG_PICKLE_AUTO,
    name: 'Big Pickle + DSH',
    modelRef: { provider: 'our-free-model', model: 'big-pickle' },
    harnessRef: 'dsh',
    permissionPolicy: 'read-only',
    isDefault: false,
    enabled: true,
    generated: true,
  })
  // The normal save/load path never writes a generated row; the persisted stale row is the
  // separate migration case below.
  expect(normalizeCatalog(catalog).combinations.some((item) => item.id === BIG_PICKLE_AUTO)).toBe(
    false,
  )
})

it('migrates a persisted automatic Big Pickle DSH row to the OpenCode combination', async () => {
  const dir = await workspace()
  const store = new ExecutionCatalogStore(dir)
  try {
    const catalog = defaultExecutionCatalog()
    catalog.combinations.push(
      {
        id: BIG_PICKLE_AUTO,
        name: 'Big Pickle + DSH',
        modelRef: { provider: 'our-free-model', model: 'big-pickle' },
        harnessRef: 'dsh',
        // An automatic row that reached disk (edited, or written by an older release)
        // carries no `generated` flag here. It must still be treated as stale.
        permissionPolicy: 'read-only',
        isDefault: true,
        enabled: true,
      },
      {
        id: 'user-big-pickle-dsh',
        name: 'My Big Pickle DSH route',
        modelRef: { provider: 'our-free-model', model: 'big-pickle' },
        harnessRef: 'dsh',
        permissionPolicy: 'workspace',
        isDefault: false,
        enabled: true,
      },
      {
        id: QUALIFICATION_AUTO,
        name: 'Qualification + DSH',
        modelRef: { provider: 'our-free-model', model: 'opl-qualification-free' },
        harnessRef: 'dsh',
        permissionPolicy: 'read-only',
        isDefault: true,
        enabled: true,
      },
    )
    await store.set(catalog)

    const ctx = {
      get: () => undefined,
      llm: {
        listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
        listConfigurableProviders: () => [],
        listModels: async () => [{ id: 'big-pickle' }, { id: 'opl-qualification-free' }],
      },
    }
    const resolved = await new ExecutionModelResolver(ctx as never, store).resolve()
    const bigPickle = resolved.combinations.filter((item) => item.modelRef.model === 'big-pickle')
    expect(bigPickle.some((item) => item.id === BIG_PICKLE_AUTO && item.harnessRef === 'dsh')).toBe(
      false,
    )
    expect(bigPickle.some((item) => item.harnessRef === 'dsh' && item.generated)).toBe(false)
    expect(
      bigPickle.some(
        (item) =>
          item.id === BIG_PICKLE_AUTO &&
          item.harnessRef === 'opencode' &&
          item.generated &&
          item.isDefault,
      ),
    ).toBe(true)
    // A user-created route and another OFM model's automatic row are untouched.
    expect(bigPickle.find((item) => item.id === 'user-big-pickle-dsh')).toMatchObject({
      name: 'My Big Pickle DSH route',
      harnessRef: 'dsh',
      permissionPolicy: 'workspace',
    })
    expect(resolved.combinations.find((item) => item.id === QUALIFICATION_AUTO)).toMatchObject({
      harnessRef: 'dsh',
      isDefault: true,
    })

    // The cleanup persisted the removal, so a restart cannot bring the stale row back.
    const saved = JSON.parse(await readFile(store.filename, 'utf8'))
    expect(saved.combinations.some((item: any) => item.id === BIG_PICKLE_AUTO)).toBe(false)
    expect(saved.combinations.some((item: any) => item.id === 'user-big-pickle-dsh')).toBe(true)
    expect(saved.combinations.some((item: any) => item.id === QUALIFICATION_AUTO)).toBe(true)
  } finally {
    await store.dispose()
  }
})

it('records the remaining directory-only ids as refused instead of inventing an OFM lane', () => {
  // `exo-free` has no live free lane and `ll-alpha-free` is refused upstream for any
  // client that is not OpenCode itself. Big Pickle was reclassified on 2026-10-19 and is
  // asserted through the positive mapping above, not here.
  expect(OFM_OPENCODE_DIRECTORY_ONLY_MODELS).toEqual(['exo-free', 'll-alpha-free'])
  for (const model of OFM_OPENCODE_DIRECTORY_ONLY_MODELS) {
    expect(OPENCODE_OFM_MODELS).not.toContain(model)
    expect(officialOpenCodeModel({ provider: 'our-free-model', model })).toBeUndefined()
    // Not hidden as an OFM exclusion either: the owner withholds the lane, it does not
    // ban the model id.
    expect(isHiddenOfmSelection({ provider: 'our-free-model', model })).toBe(false)
    // A same-named model from another source keeps its own decision.
    expect(officialOpenCodeModel({ provider: 'custom', model })).toBeUndefined()
  }
  // The source's own pinning table must refuse them too, so a later edit to the routing
  // list alone cannot make the lane callable.
  expect(OFM_PINNED_HARNESS_MODELS.opencode).not.toContain('exo-free')
  expect(OFM_PINNED_HARNESS_MODELS.opencode).not.toContain('ll-alpha-free')
})

it('keeps unknown and unavailable ids out of the OpenCode mapping', () => {
  for (const model of ['big-pickle-preview', 'unknown-model', 'exo-free', 'll-alpha-free']) {
    const ref = { provider: 'our-free-model', model }
    expect(officialOpenCodeModel(ref)).toBeUndefined()
    expect(OPENCODE_OFM_MODELS).not.toContain(model)
    expect(adapterFor('opencode', ref, undefined)).toBeUndefined()
    // The fallback is the native DSH loop, never a guessed OpenCode route.
    expect(defaultHarness(ref)).toBe('dsh')
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
