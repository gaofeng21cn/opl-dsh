/** Extend the official provider configuration, retaining its editor and adapter. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import * as official from '@deepseek-ai/dsh-llm-pi-ai'
import {
  HUAWEI_MAAS_CREDENTIAL_REF,
  HUAWEI_MAAS_ENDPOINT,
} from '../../credentials/contracts/huawei-maas.ts'
import {
  HuaweiZcodeModelAdapter,
  HUAWEI_ZCODE_MODEL,
} from '../../execution/host/adapters/zcode-models.ts'
import { migrateHuaweiCredential } from '../../credentials/host/provider.ts'
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
const extraFields = {
  huaweiProviders: z
    .dict(huaweiProfile, z.const(HUAWEI_ZCODE_MODEL.provider))
    .default({})
    .volatile(),
  huaweiKeyringMigrated: z.boolean().default(false).volatile(),
  huaweiCredentialsMigrated: z.boolean().default(false).volatile(),
}
type ExtraConfig = {
  huaweiProviders: Volatile<Record<string, { models: { id: string; name: string }[] }>>
  huaweiKeyringMigrated: Volatile<boolean>
  huaweiCredentialsMigrated: Volatile<boolean>
}

/** The native editor only recognizes official adapter namespaces. Extend the
 * existing public Schema and fiber; never duplicate/replace its loader entry.
 * Keep this compatibility seam removable when native providers support arbitrary families. */
export async function apply(ctx: Context): Promise<void> {
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
      ],
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
  ])
  const adapter = new HuaweiZcodeModelAdapter(
    () => configuration().huaweiProviders.get()[HUAWEI_ZCODE_MODEL.provider]?.models,
  )
  let registration: ReturnType<typeof ctx.llm.registerAdapter> | undefined
  const refresh = () => {
    const routes = configuration().huaweiProviders.get()[HUAWEI_ZCODE_MODEL.provider]
      ? [HUAWEI_ZCODE_MODEL.provider]
      : []
    if (registration) registration.replace(routes)
    else if (routes.length) registration = ctx.llm.registerAdapter(routes, adapter)
  }
  refresh()
  ctx.on('loader/volatile-update', refresh, { global: true })
}
