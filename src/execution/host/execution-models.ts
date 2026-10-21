import { invokeHostRemote } from '../../compat/host/remote-invocation.ts'
/** Owns live model/combination projection; persisted catalog stores references only. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  internalGatewayProvider,
  gatewayModelSettings,
} from '../../gateway/host/execution-access.ts'
import { DSH_COMBINATION } from '../contracts/sessions.ts'
import {
  displayModelName,
  displayModelSource,
  isRetiredModel,
  modelRefKey,
  type CombinationDefinition,
  type ModelRef,
} from '../contracts/catalog.ts'
import { ExecutionCatalogStore, type ExecutionCatalog } from './catalog.ts'
import { defaultHarness } from './adapters/index.ts'
import { HUAWEI_ZCODE_MODEL, HUAWEI_ZCODE_COMBINATION } from './adapters/zcode-models.ts'
import {
  minimaxCodeCombinations,
  minimaxCodeModels,
  MINIMAX_CODE_HARNESS,
  MINIMAX_CODE_PROVIDER,
} from './adapters/minimax.ts'
import { isHiddenOfmSelection, officialOpenCodeModel } from './ofm-source/selection-policy.ts'
import { OFM_PROVIDERS } from './ofm-source/provider.ts'
import { BAMBOO_STARTLUX_MODEL } from './adapters/bamboo.ts'
import { JEV_DECISION_MODEL, JEV_TYPESAFE_MODEL } from './adapters/jev.ts'
export class ExecutionModelResolver {
  constructor(
    private readonly ctx: Context,
    private readonly store: ExecutionCatalogStore,
    /**
     * Probes a model that an external official CLI owns. These models bypass the OPL
     * Gateway registry entirely, so their availability must come from the CLI itself
     * (installed, signed in) rather than from a Gateway credential.
     */
    private readonly probeExternal?: (
      ref: ModelRef,
    ) => Promise<{ available: boolean; reason?: string }>,
  ) {}
  async resolve(): Promise<ExecutionCatalog> {
    let catalog = await this.store.get()
    // Remove combinations from old releases before projecting the live model
    // registry. The write is idempotent and keeps the on-disk catalog clean so
    // retired entries cannot return after a restart.
    const retired = catalog.combinations.filter((item) => isRetiredModel(item.modelRef))
    const legacyDefault = catalog.combinations.find(
      (item) => item.id === DSH_COMBINATION && item.name === 'DeepSeek + DSH',
    )
    // An automatic row is generated per model for the default Harness of that model.
    // A persisted `auto:` row whose Harness no longer matches the current default is a
    // stale copy (for example Big Pickle's old `auto:["our-free-model","big-pickle"]`
    // DSH combination, generated when it was still treated as a DSH-only lane). Rows the
    // user created carry their own id, so they are never selected here.
    const staleAutomatic = (item: CombinationDefinition) =>
      item.id.startsWith('auto:') &&
      OFM_PROVIDERS.includes(item.modelRef.provider) &&
      item.harnessRef !== defaultHarness(item.modelRef)
    if (
      retired.length ||
      legacyDefault ||
      catalog.combinations.some((item) => staleAutomatic(item))
    ) {
      catalog = await this.store.cleanLegacyCombinations(staleAutomatic)
    }
    // The store's cleanup persists the removal; this in-memory filter also covers a
    // store double that does not apply the predicate, so the projection is unchanged.
    catalog.combinations = catalog.combinations.filter((item) => !staleAutomatic(item))
    catalog.combinations = catalog.combinations.filter(
      (item) => !isHiddenOfmSelection(item.modelRef),
    )
    const providers = this.ctx.llm?.listProviders() ?? []
    const configurable = this.ctx.llm?.listConfigurableProviders() ?? []
    const settings = this.ctx.get('settings')
    const externalAvailability = new Map<string, Promise<{ available: boolean; reason?: string }>>()
    const probeExternal = (ref: ModelRef) => {
      const model = modelRefKey(ref)
      const existing = externalAvailability.get(model)
      if (existing) return existing
      const pending =
        this.probeExternal?.(ref) ??
        Promise.resolve({ available: false, reason: '外部 Harness 未就绪' })
      externalAvailability.set(model, pending)
      return pending
    }
    const providerModels = await Promise.all(
      providers.map(async (provider) => {
        if (internalGatewayProvider(provider.id)) return []
        const directory = configurable.find((item) => item.provider === provider.id)
        let configured = true
        if (directory && provider.id !== 'opl-gateway') {
          let profile = settings?.describe().find((item) => item.ns === directory.settingsNs)
            ?.value as any
          for (const key of directory.settingsPath) profile = profile?.[key]
          // ZCode owns Huawei readiness and only needs credential presence here;
          // resolving its secret is reserved for the actual request bridge.
          if (profile?.apiKeyEnv && provider.id !== HUAWEI_ZCODE_MODEL.provider)
            configured = !!(
              await this.ctx.get('credentials')?.resolve(credentialRef(profile.apiKeyEnv))
            )?.value
        }
        // The official DeepSeek adapter always exposes its built-in catalog, but
        // that catalog is not a usable connection until a key is configured.
        // A missing descriptor therefore means "not configured", rather than a
        // reason to populate the combination picker with empty models.
        if ((provider.id === 'deepseek-official' || provider.id === 'deepseek') && !directory)
          configured = false
        if (provider.id === 'deepseek-account') {
          try {
            configured =
              (
                (await invokeHostRemote(this.ctx, {
                  namespace: 'account',
                  method: 'getState',
                  args: {},
                })) as { status: string }
              ).status === 'credential-stored'
          } catch {
            configured = false
          }
          // Account model discovery requires a signed-in connection. Saved model
          // references remain visible as unavailable below without making that request.
          if (!configured) return []
        }
        try {
          const models = await this.ctx.llm.listModels(provider.id)
          return await Promise.all(
            models.flatMap((model) => {
              if (provider.id === 'opl-gateway' && model.id === 'codex::codex-auto-review')
                return []
              if (
                provider.id === BAMBOO_STARTLUX_MODEL.provider ||
                provider.id === JEV_DECISION_MODEL.provider ||
                provider.id === JEV_TYPESAFE_MODEL.provider
              )
                return []
              if (isHiddenOfmSelection({ provider: provider.id, model: model.id })) return []
              const ref = { provider: provider.id, model: model.id }
              if (isRetiredModel(ref)) return []
              const external =
                provider.id === MINIMAX_CODE_PROVIDER || provider.id === HUAWEI_ZCODE_MODEL.provider
                  ? probeExternal(ref)
                  : undefined
              const source =
                provider.id === 'deepseek-account'
                  ? 'DeepSeek 官方'
                  : provider.id === 'opl-gateway'
                    ? 'OPL Gateway'
                    : provider.name
              return [
                Promise.resolve(external).then((availability) => ({
                  ref,
                  name: displayModelName(ref, model.name),
                  source: officialOpenCodeModel(ref) ? 'OpenCode 官方免费通道' : source,
                  available: availability?.available ?? configured,
                  ...(availability
                    ? availability.available
                      ? {}
                      : { reason: availability.reason ?? '外部 Harness 未就绪' }
                    : !configured
                      ? { reason: '凭据未配置' }
                      : {}),
                })),
              ]
            }),
          )
        } catch {
          /* Keep saved references visible as unavailable below. */
          return []
        }
      }),
    )
    for (const models of providerModels) catalog.models.push(...models)
    if (this.ctx.get('settings')) {
      const configured = await gatewayModelSettings(this.ctx)
      for (const group of configured.groups)
        for (const model of group.models) {
          const ref = {
            provider: 'opl-gateway',
            model: group.id === 'deepseek' ? model.id : group.id + '::' + model.id,
          }
          if (isRetiredModel(ref)) continue
          if (!catalog.models.some((item) => modelRefKey(item.ref) === modelRefKey(ref)))
            catalog.models.push({
              ref,
              name: displayModelName(ref, model.name),
              source: 'OPL Gateway',
              available: false,
              reason: '分组凭据未就绪',
            })
        }
    }
    // The official MiniMax Code CLI owns its own account and model list, so these two
    // models are never projected from the OPL Gateway provider registry. They are only
    // marked available once the CLI itself is installed and signed in, so a missing
    // Gateway key never hides them and an absent CLI never advertises them.
    for (const model of minimaxCodeModels())
      if (!catalog.models.some((item) => modelRefKey(item.ref) === modelRefKey(model))) {
        const probe = this.probeExternal
          ? await probeExternal(model)
          : { available: false, reason: '尚未安装官方 MiniMax Code CLI' }
        catalog.models.push({
          ref: model,
          name: displayModelName(model),
          source: displayModelSource(model),
          available: probe.available,
          ...(probe.available ? {} : { reason: probe.reason ?? '官方 MiniMax Code 未就绪' }),
        })
      }
    for (const fixed of minimaxCodeCombinations())
      if (!catalog.combinations.some((item) => item.id === fixed.combination))
        catalog.combinations.push({
          id: fixed.combination,
          name: fixed.name,
          modelRef: { provider: MINIMAX_CODE_PROVIDER, model: fixed.model },
          harnessRef: MINIMAX_CODE_HARNESS,
          permissionPolicy: 'full-access',
          isDefault: true,
          enabled: true,
        })
    if (
      providers.some((provider) => provider.id === HUAWEI_ZCODE_MODEL.provider) &&
      !catalog.combinations.some((item) => item.id === HUAWEI_ZCODE_COMBINATION)
    )
      catalog.combinations.push({
        id: HUAWEI_ZCODE_COMBINATION,
        name: 'GLM-5.2 · ZCode',
        modelRef: HUAWEI_ZCODE_MODEL,
        harnessRef: 'zcode',
        permissionPolicy: 'full-access',
        isDefault: true,
        enabled: true,
        generated: true,
      })
    for (const combination of catalog.combinations)
      if (
        !isRetiredModel(combination.modelRef) &&
        !catalog.models.some(
          (model) => modelRefKey(model.ref) === modelRefKey(combination.modelRef),
        )
      )
        catalog.models.push({
          ref: combination.modelRef,
          name: displayModelName(combination.modelRef),
          source: combination.modelRef.provider,
          available: false,
          reason: '模型未配置或分组未授权',
        })
    for (const model of catalog.models) {
      const hasDefault = catalog.combinations.some(
        (item) =>
          !isRetiredModel(item.modelRef) &&
          (item.id === 'auto:' + modelRefKey(model.ref) ||
            (item.enabled &&
              item.isDefault &&
              modelRefKey(item.modelRef) === modelRefKey(model.ref))),
      )
      if (!isRetiredModel(model.ref) && model.available && !hasDefault) {
        const harnessRef = defaultHarness(model.ref),
          harnessName = catalog.harnesses.find((h) => h.id === harnessRef)?.name ?? 'DSH'
        catalog.combinations.push({
          id: 'auto:' + modelRefKey(model.ref),
          name:
            displayModelName(model.ref, model.name) +
            ' + ' +
            harnessName +
            (officialOpenCodeModel(model.ref) ? '（官方免费通道）' : ''),
          modelRef: model.ref,
          harnessRef,
          permissionPolicy: 'read-only',
          isDefault: true,
          enabled: true,
          generated: true,
        })
      }
    }
    return catalog
  }
}
