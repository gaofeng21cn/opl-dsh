import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultExecutionCatalog,
  ExecutionCatalogStore,
  normalizeCatalog,
  type ExecutionCatalog,
} from '../../src/execution/host/catalog.ts'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'opl-catalog-'))
  roots.push(dir)
  return dir
}
const neutralProvider = 'neutral-provider'
const neutralModel = 'neutral-chat'
const neutralRef = { provider: neutralProvider, model: neutralModel }
const neutralAutoId = 'auto:' + JSON.stringify([neutralProvider, neutralModel])
const nativeFixture = (models = [{ id: neutralModel, name: 'Neutral Chat' }]) => ({
  get: () => undefined,
  llm: {
    listProviders: () => [{ id: neutralProvider, name: 'Neutral Native Provider' }],
    listConfigurableProviders: () => [
      {
        provider: neutralProvider,
        displayName: 'Neutral Native Provider',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', neutralProvider],
        declared: true,
      },
    ],
    listModels: async () => models,
  },
})
const neutralRoutes = (catalog: ExecutionCatalog, model = neutralModel) =>
  catalog.combinations.filter(
    (item) => item.modelRef.provider === neutralProvider && item.modelRef.model === model,
  )
describe('combination authority', () => {
  it('removes one saved combination without overwriting a concurrent proxy update', async () => {
    const store = new ExecutionCatalogStore(await root())
    const original = await store.get()
    const target = {
      ...original.combinations[0],
      id: 'saved-custom',
      harnessRef: 'opencode',
      isDefault: false,
    }
    await store.set({ ...original, combinations: [...original.combinations, target] })
    const ready = Promise.all([
      store.setProxy('opencode', { mode: 'direct' }),
      store.removeCombination(target.id, () => {}),
    ])
    await ready
    const persisted = JSON.parse(await readFile(store.filename, 'utf8'))
    expect(
      persisted.harnesses.find((item: { id: string }) => item.id === 'opencode').proxy,
    ).toEqual({
      mode: 'direct',
    })
    expect(persisted.combinations).toEqual(original.combinations)
  })
  it('orders the directory around common engines while preserving every adapter', () => {
    const catalog = defaultExecutionCatalog()
    expect(catalog.harnesses.slice(0, 6).map((item) => item.id)).toEqual([
      'dsh',
      'codex',
      'claude',
      'grok-build',
      'antigravity',
      'opencode',
    ])
    expect(new Set(catalog.harnesses.map((item) => item.id)).size).toBe(catalog.harnesses.length)
    expect(catalog.harnesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'minimax-code' }),
        expect.objectContaining({ id: 'kimi-code' }),
        expect.objectContaining({ id: 'mimo-code' }),
        expect.objectContaining({ id: 'pool' }),
        expect.objectContaining({ id: 'step-code' }),
        expect.objectContaining({ id: 'pi' }),
        expect.objectContaining({ id: 'kilo' }),
        expect.objectContaining({ id: 'vibe' }),
      ]),
    )
  })
  it('persists references without a second model catalog', async () => {
    const dir = await root(),
      store = new ExecutionCatalogStore(dir),
      catalog = await store.get()
    catalog.models = [
      { ref: { provider: 'custom', model: 'a' }, name: 'A', source: 'custom', available: true },
    ]
    await store.set(catalog)
    const saved = JSON.parse(await readFile(store.filename, 'utf8'))
    expect(saved.models).toBeUndefined()
    expect(saved.connections).toBeUndefined()
    expect(saved.combinations[0]).not.toHaveProperty('connectionId')
  })
  it('migrates old same-model group references and preserves the original bytes', async () => {
    const dir = await root(),
      file = join(dir, 'profiles/desktop/execution-catalog.json')
    await mkdir(join(dir, 'profiles/desktop'), { recursive: true })
    const old = JSON.stringify({
      connections: [{ id: 'opl-gateway' }],
      models: [
        { id: 'ds', connectionId: 'opl-gateway', modelId: 'deepseek-flash', routeId: 'codex' },
      ],
      harnesses: [{ id: 'dsh', kind: 'dsh', name: 'DSH' }],
      combinations: [
        {
          id: 'custom',
          name: 'Custom',
          modelId: 'ds',
          connectionId: 'opl-gateway',
          harnessId: 'dsh',
          sandbox: 'read-only',
          isDefault: true,
          enabled: true,
        },
      ],
    })
    await writeFile(file, old)
    const catalog = await new ExecutionCatalogStore(dir).get()
    expect(catalog.combinations[0]?.modelRef).toEqual({
      provider: 'opl-gateway',
      model: 'codex::deepseek-flash',
    })
    expect(await readFile(file + '.v1.backup', 'utf8')).toBe(old)
  })
  it('allows defaults per model but rejects competing defaults for the same model', () => {
    const catalog = defaultExecutionCatalog()
    expect(normalizeCatalog(catalog).combinations).toHaveLength(2)
    catalog.combinations.push({ ...catalog.combinations[0]!, id: 'duplicate' })
    expect(() => normalizeCatalog(catalog)).toThrow('默认组合')
  })
  it('preserves the user stop marker across catalog saves', () => {
    const catalog = defaultExecutionCatalog()
    catalog.combinations[0] = {
      ...catalog.combinations[0]!,
      generated: false,
      autoEnabled: false,
      autoEnabledDisabled: true,
    }
    expect(normalizeCatalog(catalog).combinations[0]).toMatchObject({
      generated: false,
      autoEnabled: false,
      autoEnabledDisabled: true,
    })
  })
  it('preserves an explicit MiniMax default change after saving and reloading the catalog', async () => {
    const { ExecutionModelResolver } = await import('../../src/execution/host/execution-models.ts')
    const dir = await root()
    const store = new ExecutionCatalogStore(dir)
    const ctx = {
      get: () => undefined,
      llm: { listProviders: () => [], listConfigurableProviders: () => [] },
    } as never
    const probe = async () => ({ available: true })
    const catalog = await new ExecutionModelResolver(ctx, store, probe).resolve()
    const ref = { provider: 'minimax-official', model: 'MiniMax-M3.1-Flash' }
    const fixed = catalog.combinations.find((item) => item.modelRef.model === ref.model)!
    expect(fixed.isDefault).toBe(true)
    await store.set({
      ...catalog,
      combinations: catalog.combinations.map((item) =>
        item.id === fixed.id ? { ...item, isDefault: false, defaultDisabled: true } : item,
      ),
    })
    const projected = await new ExecutionModelResolver(
      ctx,
      new ExecutionCatalogStore(dir),
      probe,
    ).resolve()
    expect(projected.combinations.find((item) => item.id === fixed.id)).toMatchObject({
      isDefault: false,
      defaultDisabled: true,
      enabled: true,
    })
    expect(projected.combinations.filter((item) => item.modelRef.model === ref.model)).toHaveLength(
      1,
    )
  })
  it('refuses removal of the native Harness', () => {
    const catalog = defaultExecutionCatalog()
    catalog.harnesses = []
    expect(() => normalizeCatalog(catalog)).toThrow('内置 DSH')
  })
})

describe('user model choices', () => {
  it('projects third-party models without inventing pairings and preserves custom defaults', async () => {
    const { ExecutionModelResolver } = await import('../../src/execution/host/execution-models.ts')
    const providers = [
      { id: 'our-free-model', name: 'Our Free Model' },
      { id: 'our-free-model-region', name: 'Our Free Model · region-limited' },
      { id: 'minimax', name: 'MiniMax' },
      { id: 'zcode', name: 'ZCode' },
    ]
    const models = ['plugin-model', 'combo:my-route']
    const catalog = defaultExecutionCatalog()
    catalog.combinations.push({
      id: 'user-default',
      name: 'My route',
      modelRef: { provider: 'our-free-model', model: 'plugin-model' },
      harnessRef: 'dsh',
      permissionPolicy: 'workspace',
      isDefault: true,
      enabled: true,
    })
    const ctx = {
      get: () => undefined,
      llm: {
        listProviders: () => providers,
        listConfigurableProviders: () => [],
        listModels: async () => models.map((id) => ({ id, name: id })),
      },
    }
    const projected = await new ExecutionModelResolver(
      ctx as never,
      {
        get: async () => catalog,
      } as never,
    ).resolve()
    for (const provider of providers)
      for (const model of models) {
        const ref = { provider: provider.id, model }
        const projectedModel = projected.models.find(
          (item) => JSON.stringify(item.ref) === JSON.stringify(ref),
        )
        if (
          ['our-free-model', 'our-free-model-region'].includes(provider.id) &&
          model === 'combo:my-route'
        )
          expect(projectedModel).toBeUndefined()
        else expect(projectedModel).toMatchObject({ ref, available: true, source: provider.name })
        const combinations = projected.combinations.filter(
          (item) => JSON.stringify(item.modelRef) === JSON.stringify(ref),
        )
        if (provider.id === 'our-free-model' && model === 'plugin-model')
          expect(combinations).toHaveLength(1)
        else expect(combinations).toEqual([])
      }
    expect(
      projected.combinations.find((item) => item.id === 'user-default')?.permissionPolicy,
    ).toBe('workspace')
  })

  it('generates a DSH fallback for a configured native model without naming a vendor', async () => {
    const { ExecutionModelResolver } = await import('../../src/execution/host/execution-models.ts')
    const projected = await new ExecutionModelResolver(
      nativeFixture() as never,
      { get: async () => defaultExecutionCatalog() } as never,
    ).resolve()
    expect(neutralRoutes(projected)).toEqual([
      expect.objectContaining({
        id: neutralAutoId,
        name: 'Neutral Chat + DSH',
        modelRef: neutralRef,
        harnessRef: 'dsh',
        permissionPolicy: 'read-only',
        isDefault: true,
        enabled: true,
        generated: true,
      }),
    ])
    expect(
      projected.recommendations?.some((item) => item.modelRef.provider === neutralProvider),
    ).toBe(false)
  })

  it('keeps a newly generated native row after a real save and reload without cleanup or rewriting', async () => {
    const { ExecutionModelResolver } = await import('../../src/execution/host/execution-models.ts')
    const dir = await root()
    const store = new ExecutionCatalogStore(dir)
    const initial = await new ExecutionModelResolver(nativeFixture() as never, store).resolve()
    const automatic = neutralRoutes(initial)[0]!
    expect(automatic).toMatchObject({ id: neutralAutoId, generated: true, enabled: true })
    // `generated` is the live projection marker; older persisted automatic rows omit it.
    const { generated: _generated, ...savedAutomatic } = automatic
    await store.set({
      ...initial,
      combinations: initial.combinations.map((item) =>
        item.id === neutralAutoId ? savedAutomatic : item,
      ),
    })
    const savedBytes = await readFile(store.filename, 'utf8')

    for (const current of [store, new ExecutionCatalogStore(dir)]) {
      const clean = vi.spyOn(current, 'cleanLegacyCombinations')
      const set = vi.spyOn(current, 'set')
      const projected = await new ExecutionModelResolver(
        nativeFixture() as never,
        current,
      ).resolve()
      expect(neutralRoutes(projected)).toEqual([
        expect.objectContaining({
          id: neutralAutoId,
          harnessRef: 'dsh',
          enabled: true,
          generated: true,
        }),
      ])
      expect(clean).not.toHaveBeenCalled()
      expect(set).not.toHaveBeenCalled()
      expect(await readFile(current.filename, 'utf8')).toBe(savedBytes)
      await current.dispose()
    }
  })

  it('preserves native explicit stops, custom defaults and defaultDisabled choices', async () => {
    const { ExecutionModelResolver } = await import('../../src/execution/host/execution-models.ts')
    const store = new ExecutionCatalogStore(await root())
    const saved = defaultExecutionCatalog()
    saved.combinations.push(
      {
        id: 'auto:' + JSON.stringify([neutralProvider, 'disabled-model']),
        name: 'Explicitly disabled',
        modelRef: { provider: neutralProvider, model: 'disabled-model' },
        harnessRef: 'dsh',
        permissionPolicy: 'read-only',
        isDefault: true,
        enabled: false,
        generated: false,
        autoEnabled: false,
        autoEnabledDisabled: true,
      },
      {
        id: 'user-native-default',
        name: 'My native default',
        modelRef: { provider: neutralProvider, model: 'default-model' },
        harnessRef: 'dsh',
        permissionPolicy: 'workspace',
        isDefault: true,
        enabled: true,
        autoEnabled: false,
        autoEnabledDisabled: true,
        defaultDisabled: false,
      },
      {
        id: 'auto:' + JSON.stringify([neutralProvider, 'alternative-model']),
        name: 'Automatic native alternative',
        modelRef: { provider: neutralProvider, model: 'alternative-model' },
        harnessRef: 'dsh',
        permissionPolicy: 'workspace',
        isDefault: false,
        enabled: true,
        autoEnabled: true,
        defaultDisabled: true,
      },
    )
    await store.set(saved)
    const clean = vi.spyOn(store, 'cleanLegacyCombinations')
    const set = vi.spyOn(store, 'set')
    const projected = await new ExecutionModelResolver(
      nativeFixture([
        { id: 'disabled-model', name: 'Disabled' },
        { id: 'default-model', name: 'Default' },
        { id: 'alternative-model', name: 'Alternative' },
      ]) as never,
      store,
    ).resolve()
    expect(neutralRoutes(projected, 'disabled-model')).toEqual([
      expect.objectContaining({ enabled: false, generated: false, autoEnabledDisabled: true }),
    ])
    expect(neutralRoutes(projected, 'default-model')).toEqual([
      expect.objectContaining({
        id: 'user-native-default',
        permissionPolicy: 'workspace',
        isDefault: true,
        defaultDisabled: false,
      }),
    ])
    const alternatives = neutralRoutes(projected, 'alternative-model')
    expect(alternatives).toEqual([
      expect.objectContaining({
        id: 'auto:' + JSON.stringify([neutralProvider, 'alternative-model']),
        permissionPolicy: 'workspace',
        isDefault: false,
        defaultDisabled: true,
        generated: true,
      }),
    ])
    expect(alternatives[0]?.autoEnabledDisabled).not.toBe(true)
    expect(clean).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    await store.dispose()
  })

  it('does not replace official pairings or external recommendations with the native fallback', async () => {
    const { ExecutionModelResolver } = await import('../../src/execution/host/execution-models.ts')
    const officialRef = { provider: 'opl-gateway', model: 'codex::gpt-6' }
    const recommendedRef = {
      provider: 'our-free-model',
      model: 'nvidia/nemotron-3.5-super-vl:free',
    }
    const ctx = {
      get: () => undefined,
      llm: {
        listProviders: () => [
          { id: officialRef.provider, name: 'Gateway' },
          { id: recommendedRef.provider, name: 'OFM' },
        ],
        listConfigurableProviders: () =>
          [officialRef, recommendedRef].map((item) => ({
            provider: item.provider,
            displayName: item.provider,
            settingsNs: 'test-models',
            settingsPath: [item.provider],
          })),
        listModels: async (provider: string) =>
          provider === officialRef.provider
            ? [{ id: officialRef.model, name: 'GPT 6' }]
            : [{ id: recommendedRef.model, name: 'Nemotron' }],
      },
    }
    const projected = await new ExecutionModelResolver(
      ctx as never,
      { get: async () => defaultExecutionCatalog() } as never,
    ).resolve()
    expect(
      projected.combinations.filter(
        (item) =>
          item.modelRef.provider === officialRef.provider &&
          item.modelRef.model === officialRef.model,
      ),
    ).toEqual([expect.objectContaining({ harnessRef: 'codex', generated: true, enabled: true })])
    expect(
      projected.combinations.some(
        (item) =>
          item.modelRef.provider === recommendedRef.provider &&
          item.modelRef.model === recommendedRef.model,
      ),
    ).toBe(false)
    expect(projected.recommendations).toContainEqual(
      expect.objectContaining({ modelRef: recommendedRef, harnessRef: 'opencode' }),
    )
  })

  it.each([
    {
      modelRef: { provider: 'opl-gateway', model: 'codex::deepseek-flash' },
      advertised: true,
    },
    {
      modelRef: { provider: 'opl-gateway-openai', model: 'internal-only-model' },
      advertised: false,
    },
    {
      modelRef: { provider: 'our-free-model', model: 'unadapted-ofm-model' },
      advertised: true,
    },
    {
      modelRef: { provider: 'minimax-official', model: 'external-cli-only-model' },
      advertised: true,
    },
  ])(
    'does not treat owned source $modelRef.provider as a native custom fallback',
    async ({ modelRef, advertised }) => {
      const { ExecutionModelResolver } =
        await import('../../src/execution/host/execution-models.ts')
      const ctx = {
        get: () => undefined,
        llm: {
          listProviders: () => [{ id: modelRef.provider, name: modelRef.provider }],
          listConfigurableProviders: () => [
            {
              provider: modelRef.provider,
              displayName: modelRef.provider,
              settingsNs: 'test-models',
              settingsPath: [modelRef.provider],
            },
          ],
          listModels: async () => [{ id: modelRef.model, name: modelRef.model }],
        },
      }
      const projected = await new ExecutionModelResolver(
        ctx as never,
        { get: async () => defaultExecutionCatalog() } as never,
        async () => ({ available: true }),
      ).resolve()
      expect(
        projected.models.some(
          (item) => JSON.stringify(item.ref) === JSON.stringify(modelRef) && item.available,
        ),
      ).toBe(advertised)
      expect(
        projected.combinations.filter(
          (item) => JSON.stringify(item.modelRef) === JSON.stringify(modelRef),
        ),
      ).toEqual([])
    },
  )

  it('excludes unconfigured providers and preserves explicit same-model channels', async () => {
    const { selectableModels } = await import('../../src/execution/contracts/catalog.ts')
    const model = (provider: string, id: string, available = true) => ({
      ref: { provider, model: id },
      name: id,
      source: provider,
      available,
    })
    const all = [
      model('deepseek-official', 'deepseek-flash', false),
      model('opl-gateway', 'codex::deepseek-flash'),
      model('opl-gateway', 'deepseek-flash'),
      model('opl-gateway', 'codex::gpt-current'),
      model('opl-gateway', 'grok::grok-4.7'),
    ]
    expect(selectableModels(all).map((m) => m.ref.model)).toEqual([
      'codex::deepseek-flash',
      'deepseek-flash',
      'codex::gpt-current',
      'grok::grok-4.7',
    ])
    expect(all).toHaveLength(5)
    expect(selectableModels([all[1]!])[0]?.ref.model).toBe('codex::deepseek-flash')
  })
  it('retains identical model names across independently configured providers', async () => {
    const { selectableModels } = await import('../../src/execution/contracts/catalog.ts')
    expect(
      selectableModels(
        ['official', 'custom'].map((provider) => ({
          ref: { provider, model: 'same' },
          name: 'Same',
          source: provider,
          available: true,
        })),
      ),
    ).toHaveLength(2)
  })
})
