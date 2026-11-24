import type { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import type { AntigravityAccountStatus } from '../../../src/execution/contracts/antigravity-account.ts'
import { AntigravityGoogleModels } from '../../../src/execution/host/adapters/antigravity/google-model-provider.ts'
import { defaultExecutionCatalog } from '../../../src/execution/host/catalog.ts'
import { ExecutionModelResolver } from '../../../src/execution/host/execution-models.ts'
import { ANTIGRAVITY_GOOGLE_PROVIDER as provider } from '../../../src/shared/models.ts'

it('offers only account-advertised routes without requiring a Gateway endpoint or credential', async () => {
  let status: AntigravityAccountStatus = { status: 'signed-out', models: [] }
  const adapter = new AntigravityGoogleModels(() => status)
  const model = 'gemini-4-neon-xhigh'
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [adapter.providerInfo(provider)],
      listModels: () => adapter.listModels(provider),
      listConfigurableProviders: () => [],
    },
  } as unknown as Context
  const resolver = new ExecutionModelResolver(ctx, {
    get: async () => defaultExecutionCatalog(),
  } as never)
  expect(await adapter.listModels(provider)).toEqual([])
  status = { status: 'ready', models: [model] }
  const catalog = await resolver.resolve()
  expect(catalog.combinations.filter((c) => c.modelRef.provider === provider)).toMatchObject([
    {
      modelRef: { provider, model },
      harnessRef: 'antigravity',
      enabled: true,
      isDefault: true,
      permissionPolicy: 'full-access',
    },
  ])
  expect((await adapter.prepareCall(provider, model)).model.id).toBe(model)
  status = { status: 'signed-out', models: [] }
  await expect(adapter.resolveModel(provider, model)).rejects.toThrow()
})
