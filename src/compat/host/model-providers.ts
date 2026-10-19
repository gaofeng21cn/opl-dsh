/** Extend the official provider configuration, retaining its editor and adapter. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import * as official from '@deepseek-ai/dsh-llm-pi-ai'
import { BAMBOO_STARTLUX_CREDENTIAL_REF } from '../../credentials/contracts/windows-keyring.ts'
import {
  HUAWEI_MAAS_CREDENTIAL_REF,
  HUAWEI_MAAS_ENDPOINT,
} from '../../credentials/contracts/huawei-maas.ts'
import { installProviderKeyringOverlay } from '../../credentials/host/keyring-overlay.ts'
import {
  HuaweiZcodeModelAdapter,
  HUAWEI_ZCODE_MODEL,
} from '../../execution/host/adapters/zcode-models.ts'
import { migrateHuaweiCredential } from '../../credentials/host/provider.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  BambooStartLuxAdapter,
  BAMBOO_STARTLUX_MODEL,
} from '../../execution/host/adapters/bamboo.ts'
import type { Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'

export const inject = ['loader', 'llm', 'settings', 'credentials']
const huaweiProfile = z.object({
  apiKeyEnv: z.const(HUAWEI_MAAS_CREDENTIAL_REF).default(HUAWEI_MAAS_CREDENTIAL_REF),
  baseURL: z.const(HUAWEI_MAAS_ENDPOINT).default(HUAWEI_MAAS_ENDPOINT),
  api: z.const('openai-completions').default('openai-completions'),
  models: z
    .array(z.object({ id: z.const('glm-5.2'), name: z.string().default('GLM-5.2') }))
    .min(1)
    .max(1)
    .default([{ id: 'glm-5.2', name: 'GLM-5.2' }]),
})
const bambooProfile = z.object({
  apiKeyEnv: z.const(BAMBOO_STARTLUX_CREDENTIAL_REF).default(BAMBOO_STARTLUX_CREDENTIAL_REF),
  baseURL: z
    .const('https://api.bamboonode.dev/v1/decisions')
    .default('https://api.bamboonode.dev/v1/decisions'),
  api: z.const('bamboo-decisions').default('bamboo-decisions'),
  models: z
    .array(
      z.object({
        id: z.const('startlux-decision-27b-autothink'),
        name: z.string().default('StartLux Decision 27B AutoThink'),
      }),
    )
    .min(1)
    .max(1)
    .default([{ id: 'startlux-decision-27b-autothink', name: 'StartLux Decision 27B AutoThink' }]),
})
const extraFields = {
  huaweiProviders: z
    .dict(huaweiProfile, z.const(HUAWEI_ZCODE_MODEL.provider))
    .default({})
    .volatile(),
  huaweiKeyringMigrated: z.boolean().default(false).volatile(),
  huaweiCredentialsMigrated: z.boolean().default(false).volatile(),
  bambooProviders: z.dict(bambooProfile, z.const('bamboo-startlux')).default({}).volatile(),
  providerKeyringMigration: z.number().default(0).volatile(),
}
type ExtraConfig = {
  huaweiProviders: Volatile<Record<string, { models: { id: string; name: string }[] }>>
  huaweiKeyringMigrated: Volatile<boolean>
  huaweiCredentialsMigrated: Volatile<boolean>
  bambooProviders: Volatile<
    Record<string, { baseURL: string; models: { id: string; name: string }[] }>
  >
  providerKeyringMigration: Volatile<number>
}

/** The native editor only recognizes official adapter namespaces. Extend the
 * existing public Schema and fiber; never duplicate/replace its loader entry.
 * Keep this compatibility seam removable when native providers support arbitrary families. */
export async function apply(ctx: Context): Promise<void> {
  const keyringOverlay = installProviderKeyringOverlay(ctx)
  ctx.effect(() => keyringOverlay.dispose)
  const ns = 'llm-pi-ai'
  const entry = [...ctx.loader.entries()].find(
    (item) => item.options.id === ns && item.options.name === '@deepseek-ai/dsh-llm-pi-ai',
  )
  if (!entry?.fiber?.runtime?.Config) throw new Error('官方模型供应商配置实例不可用')
  const schema = entry.fiber.runtime.Config as typeof official.Config
  ctx.effect(() => {
    const previous = new Map(Object.keys(extraFields).map((key) => [key, schema.dict?.[key]]))
    for (const [key, field] of Object.entries(extraFields)) schema.set(key, field)
    return () => {
      for (const [key, field] of Object.entries(extraFields)) {
        if (schema.dict?.[key] !== field) continue
        const old = previous.get(key)
        if (old) schema.set(key, old)
        else delete schema.dict![key]
      }
    }
  })
  // Reparse the same raw config once, so the new fields have official volatile
  // references before settings reads them. No config or package bytes are rewritten.
  await entry.fiber.restart()
  // The official editor probes by namespace and provider, without an endpoint.
  // pi-ai owns this namespace but has no Huawei catalog or per-provider hook.
  ctx.effect(() => {
    const llm = ctx.llm
    const previous = Object.getOwnPropertyDescriptor(llm, 'discoverModels')
    const discover = llm.discoverModels
    const catalog = new HuaweiZcodeModelAdapter()
    const adapted: typeof discover = async function (
      this: Context['llm'],
      settingsNs,
      request,
      signal,
    ) {
      if (settingsNs !== ns || request.provider !== HUAWEI_ZCODE_MODEL.provider)
        return discover.call(this, settingsNs, request, signal)
      signal?.throwIfAborted()
      const models = await catalog.listModels(HUAWEI_ZCODE_MODEL.provider)
      signal?.throwIfAborted()
      return models.map(({ id, name }) => ({ id, name }))
    }
    Object.defineProperty(llm, 'discoverModels', {
      configurable: true,
      writable: true,
      value: adapted,
    })
    return () => {
      if (Object.getOwnPropertyDescriptor(llm, 'discoverModels')?.value !== adapted) return
      if (previous) Object.defineProperty(llm, 'discoverModels', previous)
      else Reflect.deleteProperty(llm, 'discoverModels')
    }
  })
  const configuration = () => entry.fiber!.config as ExtraConfig
  const keyringMigrationNeeded = configuration().providerKeyringMigration.get() < 1
  if (keyringMigrationNeeded) await keyringOverlay.migratePlaintext()
  // Finish the one-time owner write before exposing an editor. Otherwise a
  // slower Windows probe can change the namespace revision under an open draft.
  if (!configuration().huaweiCredentialsMigrated.get()) {
    const oldMigration = configuration().huaweiKeyringMigrated.get()
    const hasProvider = !!configuration().huaweiProviders.get()[HUAWEI_ZCODE_MODEL.provider]
    const imported = await migrateHuaweiCredential(ctx, !oldMigration || hasProvider)
    const view = ctx.settings.describe().find((item) => item.ns === ns)
    if (!view) throw new Error('官方模型供应商设置不可用，凭据迁移状态未保存')
    await ctx.settings.mutate(
      ns,
      [
        ...(imported && !hasProvider
          ? [
              {
                op: 'set' as const,
                path: ['huaweiProviders', HUAWEI_ZCODE_MODEL.provider],
                value: {},
              },
            ]
          : []),
        { op: 'set', path: ['huaweiKeyringMigrated'], value: true },
        { op: 'set', path: ['huaweiCredentialsMigrated'], value: true },
        ...(keyringMigrationNeeded
          ? [{ op: 'set' as const, path: ['providerKeyringMigration'], value: 1 }]
          : []),
      ],
      view.revision,
    )
  }
  if (keyringMigrationNeeded && configuration().huaweiCredentialsMigrated.get()) {
    const view = ctx.settings.describe().find((item) => item.ns === ns)
    if (!view) throw new Error('官方模型供应商设置不可用，Bamboo 凭据迁移状态未保存')
    await ctx.settings.mutate(
      ns,
      [{ op: 'set', path: ['providerKeyringMigration'], value: 1 }],
      view.revision,
    )
  }
  ctx.llm.registerConfigurableProviders([
    {
      provider: HUAWEI_ZCODE_MODEL.provider,
      displayName: '华为云 MaaS',
      settingsNs: ns,
      settingsPath: ['huaweiProviders', HUAWEI_ZCODE_MODEL.provider],
    },
    {
      provider: 'bamboo-startlux',
      displayName: 'BambooNode · StartLux',
      settingsNs: ns,
      settingsPath: ['bambooProviders', 'bamboo-startlux'],
    },
  ])
  const huaweiAdapter = new HuaweiZcodeModelAdapter(
    () => configuration().huaweiProviders.get()[HUAWEI_ZCODE_MODEL.provider]?.models,
  )
  const bambooAdapter = new BambooStartLuxAdapter(
    async () =>
      (await ctx.credentials.resolve(credentialRef(BAMBOO_STARTLUX_CREDENTIAL_REF)))?.value,
  )
  let huaweiRegistration: ReturnType<typeof ctx.llm.registerAdapter> | undefined
  let bambooRegistration: ReturnType<typeof ctx.llm.registerAdapter> | undefined
  const refresh = () => {
    const huaweiRoutes = configuration().huaweiProviders.get()[HUAWEI_ZCODE_MODEL.provider]
      ? [HUAWEI_ZCODE_MODEL.provider]
      : []
    if (huaweiRegistration) huaweiRegistration.replace(huaweiRoutes)
    else if (huaweiRoutes.length)
      huaweiRegistration = ctx.llm.registerAdapter(huaweiRoutes, huaweiAdapter)
    const bambooRoutes = configuration().bambooProviders.get()[BAMBOO_STARTLUX_MODEL.provider]
      ? [BAMBOO_STARTLUX_MODEL.provider]
      : []
    if (bambooRegistration) bambooRegistration.replace(bambooRoutes)
    else if (bambooRoutes.length)
      bambooRegistration = ctx.llm.registerAdapter(bambooRoutes, bambooAdapter)
  }
  refresh()
  ctx.on('loader/volatile-update', refresh, { global: true })
}
