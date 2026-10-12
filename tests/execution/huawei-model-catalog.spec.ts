import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { ExecutionCatalogStore } from '../../src/execution/host/catalog.ts'
import { ExecutionModelResolver } from '../../src/execution/host/execution-models.ts'
import { defaultHarness } from '../../src/execution/host/adapters/index.ts'
import { HuaweiZcodeModelAdapter } from '../../src/execution/host/adapters/zcode-models.ts'
import { withZcodePermissions } from '../../src/execution/host/adapters/zcode-permissions.ts'
import type { HarnessAdapter } from '../../src/execution/host/adapters/types.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import * as keyring from '../../src/credentials/host/windows-keyring.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Huawei ZCode model selection', () => {
  it('reports a missing CLI without starting a keyring helper', async () => {
    const describeKey = vi.spyOn(keyring, 'describeHuaweiMaaSApiKey')
    const installation = { available: false, reason: 'ZCode fixture is not installed' }
    const wrapped = withZcodePermissions({
      id: 'zcode',
      available: async () => installation,
    } as unknown as HarnessAdapter)
    expect(
      await wrapped.available({} as Context, { home: '', grokCommand: '', nativeBridgePath: '' }),
    ).toEqual(installation)
    expect(describeKey).not.toHaveBeenCalled()
  })
  it.each([
    { available: false, configured: false, expected: false },
    { available: true, configured: false, expected: false },
    { available: true, configured: true, expected: true },
  ])(
    'checks keyring readiness after finding the CLI: %j',
    async ({ available, configured, expected }) => {
      const describeKey = vi
        .spyOn(keyring, 'describeHuaweiMaaSApiKey')
        .mockResolvedValue({ available, configured } as never)
      const wrapped = withZcodePermissions({
        id: 'zcode',
        available: async () => ({ available: true }),
      } as unknown as HarnessAdapter)
      const status = await wrapped.available({} as Context, {
        home: '',
        grokCommand: '',
        nativeBridgePath: '',
      })
      expect(status.available).toBe(expected)
      expect(describeKey).toHaveBeenCalledOnce()
    },
  )
  it('exposes GLM-5.2 through the official LLM registry and rejects unknown models', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const release = ctx.llm.registerAdapter(['huawei-maas'], new HuaweiZcodeModelAdapter())
    try {
      expect(await ctx.llm.listModels('huawei-maas')).toEqual([
        expect.objectContaining({ id: 'glm-5.2', name: 'GLM-5.2' }),
      ])
      expect(await ctx.llm.resolveModelInfo('huawei-maas', 'glm-5.2')).toMatchObject({
        provider: 'huawei-maas',
        id: 'glm-5.2',
        name: 'GLM-5.2',
      })
      await expect(ctx.llm.resolveModelInfo('huawei-maas', 'gpt-6.1-sol')).rejects.toThrow()
      expect(defaultHarness({ provider: 'huawei-maas', model: 'glm-5.2' })).toBe('zcode')
      expect(defaultHarness({ provider: 'opl-gateway', model: 'glm-5.2' })).toBe('dsh')
    } finally {
      release()
      await ctx.fiber.dispose()
    }
  })

  it.each([false, true])(
    'projects Key/CLI availability %s without a Gateway credential',
    async (available) => {
      const home = await mkdtemp(join(tmpdir(), 'opl-huawei-catalog-'))
      roots.push(home)
      const store = new ExecutionCatalogStore(home)
      const resolveCredential = vi.fn()
      const settings = {
        describe: () => [
          {
            ns: 'llm-pi-ai',
            value: { huaweiProviders: { 'huawei-maas': { apiKeyEnv: 'HUAWEI_MAAS_API_KEY' } } },
          },
        ],
      }
      const ctx = {
        settings,
        llm: {
          listProviders: () => [{ id: 'huawei-maas', name: '华为云 MaaS' }],
          listConfigurableProviders: () => [
            {
              provider: 'huawei-maas',
              settingsNs: 'llm-pi-ai',
              settingsPath: ['huaweiProviders', 'huawei-maas'],
            },
          ],
          listModels: () => new HuaweiZcodeModelAdapter().listModels('huawei-maas'),
        },
        get: (name: string) =>
          name === 'settings'
            ? settings
            : name === 'credentials'
              ? { resolve: resolveCredential }
              : undefined,
      } as unknown as Context
      const catalog = await new ExecutionModelResolver(ctx, store, async (ref) => ({
        available: ref.provider === 'huawei-maas' && available,
        reason: 'test readiness',
      })).resolve()
      expect(catalog.models.find((m) => m.ref.provider === 'huawei-maas')).toMatchObject({
        ref: { provider: 'huawei-maas', model: 'glm-5.2' },
        available,
      })
      expect(catalog.combinations.filter((c) => c.modelRef.provider === 'huawei-maas')).toEqual([
        expect.objectContaining({
          id: 'zcode/glm-5.2',
          harnessRef: 'zcode',
          permissionPolicy: 'full-access',
          generated: true,
        }),
      ])
      expect(resolveCredential).not.toHaveBeenCalled()
      await store.dispose()
    },
  )

  it('removes automatic Huawei models and combinations with the provider, preserving saved user references without probing the keyring', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opl-huawei-remove-'))
    roots.push(home)
    const store = new ExecutionCatalogStore(home)
    let enabled = true
    const ctx = {
      llm: {
        listProviders: () => (enabled ? [{ id: 'huawei-maas', name: '华为云 MaaS' }] : []),
        listConfigurableProviders: () => [],
        listModels: () => new HuaweiZcodeModelAdapter().listModels('huawei-maas'),
      },
      get: () => undefined,
    } as unknown as Context
    const probe = vi.fn(async (_ref: { provider: string }) => ({ available: false }))
    const resolver = new ExecutionModelResolver(ctx, store, probe)
    const added = await resolver.resolve()
    added.combinations.push({
      id: 'user-huawei',
      name: '用户组合',
      modelRef: { provider: 'huawei-maas', model: 'glm-5.2' },
      harnessRef: 'zcode',
      permissionPolicy: 'full-access',
      isDefault: false,
      enabled: true,
    })
    await store.set(added)
    enabled = false
    probe.mockClear()
    const removed = await resolver.resolve()
    expect(removed.combinations.some((item) => item.id === 'zcode/glm-5.2')).toBe(false)
    expect(removed.combinations.some((item) => item.id === 'user-huawei')).toBe(true)
    expect(removed.models.find((item) => item.ref.provider === 'huawei-maas')).toMatchObject({
      available: false,
    })
    expect(probe.mock.calls.some(([ref]) => ref.provider === 'huawei-maas')).toBe(false)
    await store.dispose()
  })

  it('refuses restricted access before launching the official CLI', async () => {
    const prepare = vi.fn()
    const wrapped = withZcodePermissions({ id: 'zcode', prepare } as unknown as HarnessAdapter)
    for (const sandbox of ['read-only', 'workspace'])
      await expect(
        wrapped.prepare!(undefined as unknown as Context, { sandbox } as HarnessSession, {
          home: '',
          grokCommand: '',
          nativeBridgePath: '',
        }),
      ).rejects.toThrow('full-access')
    expect(prepare).not.toHaveBeenCalled()
  })

  it('preserves the installed CLI bundle argument across catalog saves', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opl-zcode-prefix-'))
    roots.push(home)
    const store = new ExecutionCatalogStore(home)
    const catalog = await store.get()
    const harness = catalog.harnesses.find((h) => h.id === 'zcode')!
    harness.command = 'C:/Program Files/nodejs/node.exe'
    harness.prefix = ['C:/Program Files/ZCode/resources/glm/zcode.cjs']
    await store.set(catalog)
    const loaded = new ExecutionCatalogStore(home)
    expect((await loaded.get()).harnesses.find((h) => h.id === 'zcode')).toMatchObject(harness)
    for (const prefix of [['bad\nargument'], [5], 'not-an-array'])
      await expect(
        store.set({
          ...catalog,
          harnesses: catalog.harnesses.map((h) => (h.id === 'zcode' ? { ...h, prefix } : h)),
        }),
      ).rejects.toThrow('启动参数')
    await loaded.dispose()
    await store.dispose()
  })
})
