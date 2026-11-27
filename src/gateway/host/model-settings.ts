import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { contextOwner } from '../../compat/host/context-owner.ts'
import { gatewayModelChoices } from '../shared/model-choices.ts'
import { gatewayGroupEnabled } from './group-settings.ts'
/** Models page operations. DSH `opl-suite` profile settings are the single writable catalog. */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { GATEWAY_GROUPS, LEGACY_GATEWAY_PI_AI_PROVIDERS } from '../contracts/groups.ts'
import { gatewayGroupNotGranted } from '../contracts/account.ts'
import {
  DEFAULT_GATEWAY_CHANNELS,
  resolveGatewayChannelProfile,
  type GatewayChannelProfile,
  type GatewayPiAiGroupId,
} from './channel-defaults.ts'
import { DEFAULT_MODELS, toAdapterConfig } from './config.ts'
import type { ModelDraft, GatewayModelSettings } from '../contracts/models.ts'
import {
  displayModelName,
  GATEWAY_ANTIGRAVITY_GEMINI_MODELS,
  isSupersededModelDefault,
  isRetiredModel,
} from '../../shared/models.ts'
import { withGatewayModelInputDefaults } from './model-capabilities.ts'
import {
  gatewayDiscoveryBaseURL,
  gatewayInferenceBaseURL,
  isDefaultGatewayBaseURL,
} from './protocol.ts'
import { gatewayPiAiDiscover } from './pi-ai-bridge.ts'
import {
  clearGatewayCatalogStatus,
  diagnoseGatewayModelFailure,
  gatewayCatalogStatus,
  gatewayModelDiagnostic,
  GatewayModelDiscoveryError,
  isTransientGatewayDiscoveryDiagnostic,
  setGatewayCatalogStatus,
} from './model-diagnostics.ts'

const MAX_DISCOVERY_ATTEMPTS = 3
const DISCOVERY_TOTAL_BUDGET_MS = 20_000
const DISCOVERY_ATTEMPT_TIMEOUT_MS = 10_000
const DISCOVERY_RETRY_DELAYS_MS = [150, 350] as const
const SUITE_NS = 'opl-suite'

const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}

/** Resolve settings for callers whose plugin consumes the service through optional injection. */
function modelSettingsService(ctx: Context): Context['settings'] {
  const settings = ctx.get('settings')
  if (!settings)
    throw Object.assign(new Error('官方模型设置服务尚未就绪'), { code: 'SETTINGS_UNAVAILABLE' })
  return settings
}

function cleanUserChannelModels(models: readonly unknown[]): ModelDraft[] {
  return models.map((model) => {
    const item = record(model)
    if (!Array.isArray(item.input) || item.input.length !== 0)
      return structuredClone(item) as ModelDraft
    const { input: _implicitInput, ...declared } = item
    return structuredClone(declared) as ModelDraft
  })
}

function cleanLegacyChannelProfile(raw: Record<string, any>): GatewayChannelProfile {
  const { defaultInput, models, ...rest } = raw
  return {
    ...structuredClone(rest),
    ...(Array.isArray(defaultInput) ? { defaultInput: [...defaultInput] } : {}),
    ...(Array.isArray(models) ? { models: structuredClone(models) as ModelDraft[] } : {}),
  }
}

/** Preserve saved user-layer model arrays so catalog hashes reflect explicit edits only. */
function savedModelCatalogs(settings: Context['settings']): Record<string, unknown> {
  const suite = settings.describe().find((item) => item.ns === SUITE_NS)
  const user = record(suite?.user)
  const channels = record(user.gatewayChannels)
  return Object.fromEntries(
    GATEWAY_GROUPS.map((group) => {
      const models =
        group.id === 'deepseek' ? record(user.gateway).models : record(channels[group.id]).models
      return [group.id, models]
    }),
  )
}

const copiedCatalogs = new WeakMap<object, Map<string, { fingerprint: string; revision: number }>>()

/** Track automatic catalogs written to `opl-suite` so untouched imports keep auto-syncing. */
function modelCatalogState(ctx: Context, settings: Context['settings']) {
  const descriptors = settings.describe()
  const catalogs = savedModelCatalogs(settings)
  const owner = contextOwner(ctx)
  let copied = copiedCatalogs.get(owner)
  if (!copied) copiedCatalogs.set(owner, (copied = new Map()))
  const revision = descriptors.find((item) => item.ns === SUITE_NS)?.revision
  for (const [id, previous] of copied) {
    if (
      revision !== previous.revision ||
      catalogs[id] === undefined ||
      catalogFingerprint(catalogs[id]) !== previous.fingerprint
    )
      copied.delete(id)
  }
  return { descriptors, catalogs, copied }
}

async function mutateSuiteSettings(
  ctx: Context,
  ops: readonly SettingsPathOp[],
  revision: number,
  editedGroup?: string,
): Promise<void> {
  const settings = modelSettingsService(ctx)
  const before = modelCatalogState(ctx, settings)
  const beforeSuite = readSuiteDescriptor(before.descriptors)
  const beforeValue = record(beforeSuite?.value)
  const inherited = GATEWAY_GROUPS.filter(
    (group) =>
      group.id !== editedGroup &&
      (before.catalogs[group.id] === undefined || before.copied.has(group.id)),
  ).flatMap((group) => {
    const prefix = group.id === 'deepseek' ? ['gateway'] : ['gatewayChannels', group.id]
    if (
      ops.some(
        (op) =>
          op.path.length === prefix.length &&
          prefix.every((part, index) => op.path[index] === part),
      )
    )
      return []
    const rawProfile =
      group.id === 'deepseek' ? beforeValue.gateway : record(beforeValue.gatewayChannels)[group.id]
    if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) return []
    const expected = { ...record(rawProfile) }
    for (const op of ops) {
      if (
        op.op === 'set' &&
        op.path.length === prefix.length + 1 &&
        prefix.every((part, index) => op.path[index] === part)
      )
        expected[String(op.path.at(-1))] = op.value
    }
    return [{ group, expected }]
  })
  await settings.mutate(SUITE_NS, ops, revision)
  if (editedGroup) before.copied.delete(editedGroup)
  const after = modelCatalogState(ctx, settings)
  const afterSuite = readSuiteDescriptor(after.descriptors)
  if (afterSuite?.revision === undefined) return
  const afterValue = record(afterSuite.value)
  const afterUser = record(afterSuite.user)
  for (const { group, expected } of inherited) {
    const afterProfile =
      group.id === 'deepseek' ? afterValue.gateway : record(afterValue.gatewayChannels)[group.id]
    const userProfile =
      group.id === 'deepseek'
        ? record(afterUser.gateway)
        : record(record(afterUser.gatewayChannels)[group.id])
    if (
      after.catalogs[group.id] !== undefined &&
      isDeepStrictEqual(afterProfile, expected) &&
      userProfile.defaultInput === undefined
    )
      after.copied.set(group.id, {
        fingerprint: catalogFingerprint(after.catalogs[group.id]),
        revision: afterSuite.revision,
      })
  }
}

function readSuiteDescriptor(
  descriptors: readonly SettingsDescriptor[],
): SettingsDescriptor | undefined {
  return descriptors.find((item) => item.ns === SUITE_NS)
}

const LEGACY_CANONICAL_GEMINI_SETS: readonly (readonly string[])[] = [
  ['gemini-4-carbon', 'gemini-4-hydrogen'],
  ['gemini-4-carbon', 'gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.8-flash'],
  ['gemini-3.1-pro', 'gemini-3.8-flash'],
  ['gemini-4-argon', 'gemini-3.8-flash'],
  ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.1-pro'],
]

const geminiBundleModel = (id: string): ModelDraft => ({
  id,
  name: displayModelName({ provider: 'opl-gateway', model: `gemini::${id}` }, id),
})

/** Upgrade only a legacy bundle catalog whose rows still have their shipped metadata. */
function addGeminiBundleModels(
  profile: Record<string, any>,
  models: readonly ModelDraft[],
): ModelDraft[] {
  if (
    profile.api !== 'openai-completions' ||
    profile.apiKeyEnv !== 'OPL_GATEWAY_GEMINI_API_KEY' ||
    profile.defaultInput !== undefined ||
    !isDefaultGatewayBaseURL(profile.baseURL)
  )
    return [...models]
  const matchesLegacy = LEGACY_CANONICAL_GEMINI_SETS.some(
    (set) =>
      set.length === models.length &&
      set.every((id, index) => {
        const model = models[index]
        const expected = geminiBundleModel(id)
        if (isDeepStrictEqual(model, expected)) return true
        return isDeepStrictEqual(model, { ...expected, input: ['text', 'image'] })
      }),
  )
  if (!matchesLegacy) return [...models]
  return GATEWAY_ANTIGRAVITY_GEMINI_MODELS.filter(
    (id) => !isSupersededModelDefault('gemini', id),
  ).map((id) => models.find((model) => model.id === id) ?? geminiBundleModel(id))
}

const CODEX_6_2_MIGRATION_TAG = 'gpt-6.2'

const SUPERSEDED_CODEX_MODELS: Readonly<
  Record<string, { legacyNames: readonly string[]; targetId: 'gpt-6.2-astra' | 'gpt-6.2-sol' }>
> = {
  'gpt-6-astra': { legacyNames: ['GPT-6 Astra'], targetId: 'gpt-6.2-astra' },
  'gpt-6.1-sol': { legacyNames: ['GPT-6.1 Sol'], targetId: 'gpt-6.2-sol' },
  'gpt-6-sol': { legacyNames: ['GPT-6 Sol'], targetId: 'gpt-6.2-sol' },
}

function isPlainEmptyRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      Object.keys(item).length === 0,
  )
}

function isUncustomizedLegacyCodexEntry(
  model: ModelDraft,
  legacyNames: readonly string[],
): boolean {
  const row = model as Record<string, any>
  if (row.custom !== undefined || row.inputModalities !== undefined) return false
  if (typeof row.name !== 'string' || !legacyNames.includes(row.name)) return false
  if (
    row.input !== undefined &&
    !(
      Array.isArray(row.input) &&
      row.input.length === 2 &&
      row.input[0] === 'text' &&
      row.input[1] === 'image'
    )
  )
    return false
  if (row.compat !== undefined && !isPlainEmptyRecord(row.compat)) return false
  return true
}

/**
 * Upgrade uncustomized legacy GPT-6 / GPT-6.1 entries in a default OPL Gateway
 * Codex profile to their canonical GPT-6.2 replacements once.
 */
function upgradeSupersededCodexModels(
  profile: Record<string, any>,
  models: readonly ModelDraft[],
): ModelDraft[] {
  if (
    profile.api !== 'openai-responses' ||
    profile.apiKeyEnv !== 'OPL_GATEWAY_CODEX_API_KEY' ||
    profile.defaultInput !== undefined ||
    !isDefaultGatewayBaseURL(profile.baseURL)
  )
    return [...models]
  const existingIds = new Set(models.map((item) => item.id))
  const emitted = new Set<string>()
  const upgraded: ModelDraft[] = []
  for (const model of models) {
    const rule = SUPERSEDED_CODEX_MODELS[model.id]
    if (!rule || !isUncustomizedLegacyCodexEntry(model, rule.legacyNames)) {
      emitted.add(model.id)
      upgraded.push(model)
      continue
    }
    const replacement = DEFAULT_GATEWAY_CHANNELS.codex.models?.find(
      (candidate) => candidate.id === rule.targetId,
    )
    if (!replacement) {
      emitted.add(model.id)
      upgraded.push(model)
      continue
    }
    if (
      emitted.has(rule.targetId) ||
      (existingIds.has(rule.targetId) && model.id !== rule.targetId)
    )
      continue
    emitted.add(rule.targetId)
    upgraded.push(structuredClone(replacement))
  }
  return upgraded
}

const migrations = new WeakMap<object, Promise<void>>()

/**
 * Migrate legacy `llm-pi-ai` `opl-gateway-*` overrides into `opl-suite.gatewayChannels`,
 * remove retired hidden providers from `llm-pi-ai`, and normalize bundled defaults idempotently.
 */
export function migrateLegacyGatewaySettings(ctx: Context): Promise<void> {
  const owner = contextOwner(ctx)
  let pending = migrations.get(owner)
  if (!pending) {
    pending = runGatewaySettingsMigration(ctx).finally(() => migrations.delete(owner))
    migrations.set(owner, pending)
  }
  return pending
}

/** @deprecated Kept as alias for existing internal callers during transition. */
export const migrateGatewayProtocolDefaults = migrateLegacyGatewaySettings

async function runGatewaySettingsMigration(ctx: Context): Promise<void> {
  const service = modelSettingsService(ctx)
  let descriptors = service.describe({ redactSecrets: true })
  let suite = readSuiteDescriptor(descriptors)
  if (!suite) return

  // Step 1: Migrate user-owned legacy providers from `llm-pi-ai` into `opl-suite.gatewayChannels`,
  // then unset all `LEGACY_GATEWAY_PI_AI_PROVIDERS` keys (including `opl-gateway-auto-review`)
  // from `llm-pi-ai` so zero hidden Gateway cards survive on upgrade.
  const piAi = descriptors.find((item) => item.ns === 'llm-pi-ai')
  if (piAi) {
    const piAiUserProviders = record(record(piAi.user).providers)
    const piAiValueProviders = record(record(piAi.value).providers)
    const suiteUserChannels = record(record(suite.user).gatewayChannels)
    const migrateOps: SettingsPathOp[] = []

    for (const group of GATEWAY_GROUPS) {
      if (group.id === 'deepseek') continue
      if (!Object.hasOwn(piAiUserProviders, group.provider)) continue
      if (Object.hasOwn(suiteUserChannels, group.id)) continue
      const migrated = cleanLegacyChannelProfile(record(piAiUserProviders[group.provider]))
      migrateOps.push({
        op: 'set',
        path: ['gatewayChannels', group.id],
        value: migrated,
      })
    }

    if (migrateOps.length > 0) {
      await mutateSuiteSettings(ctx, migrateOps, suite.revision)
    }

    const legacyKeysToUnset = LEGACY_GATEWAY_PI_AI_PROVIDERS.filter(
      (key) => Object.hasOwn(piAiUserProviders, key) || Object.hasOwn(piAiValueProviders, key),
    )
    if (legacyKeysToUnset.length > 0) {
      await service.mutate(
        'llm-pi-ai',
        legacyKeysToUnset.map((key) => ({ op: 'unset' as const, path: ['providers', key] })),
        piAi.revision,
      )
    }

    descriptors = service.describe({ redactSecrets: true })
    suite = readSuiteDescriptor(descriptors)
    if (!suite) return
  }

  // Step 2: Normalize bundled defaults on saved user channels in `opl-suite.gatewayChannels`.
  const suiteUserChannels = record(record(suite.user).gatewayChannels)
  const savedCatalogs = savedModelCatalogs(service)
  const hashes = record(record(suite.value).gatewayCatalogHashes)
  const codexAlreadyMigrated =
    record(suite.value).gatewayCodexModelMigration === CODEX_6_2_MIGRATION_TAG
  const ops: SettingsPathOp[] = []
  const ownedHashes: { group: string; models: unknown; previous: string }[] = []

  for (const group of GATEWAY_GROUPS) {
    if (group.id === 'deepseek') continue
    if (!Object.hasOwn(suiteUserChannels, group.id)) continue
    const saved = record(suiteUserChannels[group.id])
    const profile = resolveGatewayChannelProfile(descriptors, group.id)
    if (
      profile.api !== group.api ||
      profile.apiKeyEnv !== group.credential ||
      !isDefaultGatewayBaseURL(profile.baseURL)
    )
      continue

    const baseURL = gatewayInferenceBaseURL(group.api)
    if (group.api === 'anthropic-messages' && profile.baseURL !== baseURL) {
      ops.push({ op: 'set', path: ['gatewayChannels', group.id, 'baseURL'], value: baseURL })
    }

    if (!Array.isArray(saved.models)) continue
    const rawSavedModels = savedModelsList(savedModelsForHash(savedCatalogs[group.id]))
    const automaticCatalog =
      Array.isArray(rawSavedModels) && hashes[group.id] === catalogFingerprint(rawSavedModels)
    const cleanedSavedModels = cleanUserChannelModels(saved.models)
    const adaptiveModels = cleanedSavedModels.map((entry: ModelDraft) => {
      if (
        group.api !== 'anthropic-messages' ||
        !['claude-opus-5-5', 'claude-fable-5-2'].includes(entry.id) ||
        record(entry.compat).forceAdaptiveThinking !== undefined
      )
        return entry
      return { ...entry, compat: { ...record(entry.compat), forceAdaptiveThinking: true } }
    })
    let bundledModels =
      group.id === 'gemini' ? addGeminiBundleModels(profile, adaptiveModels) : adaptiveModels
    if (group.id === 'codex' && !codexAlreadyMigrated) {
      const nextCodexModels = upgradeSupersededCodexModels(profile, bundledModels)
      if (!isDeepStrictEqual(nextCodexModels, bundledModels)) {
        bundledModels = nextCodexModels
        ops.push({
          op: 'set',
          path: ['gatewayCodexModelMigration'],
          value: CODEX_6_2_MIGRATION_TAG,
        })
      }
    }
    const models = withGatewayModelInputDefaults(group.id, profile, bundledModels, {
      refreshAutomaticInputs: automaticCatalog,
    })
    if (isDeepStrictEqual(models, saved.models)) continue
    ops.push({ op: 'set', path: ['gatewayChannels', group.id, 'models'], value: models })
    if (automaticCatalog) ownedHashes.push({ group: group.id, models, previous: hashes[group.id] })
  }

  if (!ops.length) return
  for (const { group, models } of ownedHashes) {
    ops.push({
      op: 'set',
      path: ['gatewayCatalogHashes', group],
      value: catalogFingerprint(models),
    })
  }
  await mutateSuiteSettings(ctx, ops, suite.revision)
}

function savedModelsForHash(value: unknown): unknown {
  return Array.isArray(value) ? value : undefined
}

function savedModelsList(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

export async function gatewayModelSettings(ctx: Context): Promise<GatewayModelSettings> {
  const settings = modelSettingsService(ctx).describe({ redactSecrets: true })
  const suite = readSuiteDescriptor(settings)
  const suiteValue = record(suite?.value)
  const account = await ctx.get('oplGatewayAccount')?.status()
  return {
    groups: GATEWAY_GROUPS.filter(
      (group) => !gatewayGroupNotGranted(account?.groups?.find((item) => item.id === group.id)),
    ).map((group) => {
      const profile =
        group.id === 'deepseek'
          ? record(suiteValue.gateway)
          : resolveGatewayChannelProfile(settings, group.id)
      const rawModels = profile.models ?? (group.id === 'deepseek' ? DEFAULT_MODELS : [])
      const models = Array.isArray(rawModels)
        ? rawModels.filter(
            (model: any) =>
              !isRetiredModel({
                provider: 'opl-gateway',
                model:
                  group.id === 'deepseek'
                    ? String(model?.id ?? '')
                    : `${group.id}::${String(model?.id ?? '')}`,
              }),
          )
        : []
      const status = account?.groups?.find((item) => item.id === group.id)
      return {
        enabled: gatewayGroupEnabled(ctx, group.id),
        ...(status?.rateMultiplier !== undefined ? { rateMultiplier: status.rateMultiplier } : {}),
        id: group.id,
        name: group.name,
        api: String(profile.api ?? group.api),
        models,
        catalog: gatewayCatalogStatus(ctx, group.id),
        state: account?.groups?.find((item) => item.id === group.id)?.state ?? 'unconfigured',
        ready:
          gatewayGroupEnabled(ctx, group.id) &&
          (account?.groups?.some((item) => item.id === group.id && item.state === 'ready') ??
            false),
        revision: suite?.revision ?? 0,
      }
    }),
  }
}

export async function editGatewayModels(
  ctx: Context,
  input: unknown,
): Promise<GatewayModelSettings> {
  const args = record(input),
    group = GATEWAY_GROUPS.find((item) => item.id === args.group)
  if (!group || !Array.isArray(args.models) || !Number.isSafeInteger(args.revision))
    throw Error('模型配置无效，请重新打开模型页')
  const settings = modelSettingsService(ctx)
  const ids = new Set<string>()
  const models = args.models.map((value: unknown) => {
    const item = record(value)
    if (
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      item.id.includes('::') ||
      ids.has(item.id)
    )
      throw Error('模型 ID 为空、重复或包含保留分隔符')
    ids.add(item.id)
    if (
      item.contextWindow !== undefined &&
      (!Number.isSafeInteger(item.contextWindow) || item.contextWindow < 1)
    )
      throw Error('上下文长度必须为正整数')
    return item
  })
  const activeModels = models.filter(
    (model) =>
      !isRetiredModel({
        provider: 'opl-gateway',
        model: group.id === 'deepseek' ? String(model.id) : `${group.id}::${String(model.id)}`,
      }),
  )
  if (group.id === 'deepseek') {
    await mutateSuiteSettings(
      ctx,
      [{ op: 'set', path: ['gateway', 'models'], value: activeModels }],
      args.revision,
      group.id,
    )
  } else {
    if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(args.api))
      throw Error('不支持的模型协议')
    const descriptors = settings.describe({ redactSecrets: true })
    const suite = readSuiteDescriptor(descriptors)
    const userChannel = record(record(record(suite?.user).gatewayChannels)[group.id])
    const resolved = resolveGatewayChannelProfile(descriptors, group.id)
    const defaultChannel = DEFAULT_GATEWAY_CHANNELS[group.id]
    const updateBaseURL =
      userChannel.baseURL === undefined ||
      (resolved.apiKeyEnv === group.credential && isDefaultGatewayBaseURL(resolved.baseURL))
    const targetBaseURL = updateBaseURL
      ? gatewayInferenceBaseURL(args.api)
      : (resolved.baseURL ?? defaultChannel.baseURL)
    const nextChannel: GatewayChannelProfile = {
      ...resolved,
      displayName: resolved.displayName ?? `OPL Gateway · ${group.name}`,
      api: args.api,
      ...(targetBaseURL !== undefined ? { baseURL: targetBaseURL } : {}),
      apiKeyEnv: resolved.apiKeyEnv ?? group.credential,
    }
    const completeModels = withGatewayModelInputDefaults(
      group.id,
      nextChannel,
      activeModels as ModelDraft[],
    )
    nextChannel.models = completeModels
    await mutateSuiteSettings(
      ctx,
      [{ op: 'set', path: ['gatewayChannels', group.id], value: nextChannel }],
      args.revision,
      group.id,
    )
  }
  if (gatewayCatalogStatus(ctx, group.id).state === 'error')
    clearGatewayCatalogStatus(ctx, group.id)
  return gatewayModelSettings(ctx)
}

/** List candidates using the configured endpoint and credential reference, without saving models. */
export async function discoverGatewayModels(ctx: Context, input: unknown): Promise<ModelDraft[]> {
  const group = GATEWAY_GROUPS.find((item) => item.id === record(input).group)
  if (!group) throw Error('未知分组')
  let signal: AbortSignal | undefined
  const fail: (code: import('../contracts/models.ts').GatewayModelDiagnostic['code']) => never = (
    code,
  ) => {
    throw new GatewayModelDiscoveryError(group.id, group.name, gatewayModelDiagnostic(code))
  }
  try {
    if (!gatewayGroupEnabled(ctx, group.id)) fail('disabled')
    const settings = modelSettingsService(ctx)
    const credentials = ctx.get('credentials')
    const isolatedDiscover = gatewayPiAiDiscover(ctx)
    const llm = ctx.get('llm')
    if (!credentials || (!isolatedDiscover && !llm)) fail('service_unavailable')
    const descriptors = settings.describe({ redactSecrets: true })
    const suite = readSuiteDescriptor(descriptors)
    if (!suite) fail('service_unavailable')
    const suiteValue = record(suite.value)
    const profile: Record<string, any> =
      group.id === 'deepseek'
        ? record(suiteValue.gateway)
        : resolveGatewayChannelProfile(descriptors, group.id)
    const deepseek = group.id === 'deepseek' ? toAdapterConfig(profile) : undefined
    const api = group.id === 'deepseek' ? group.api : (profile.api ?? group.api)
    const ref = (deepseek ? deepseek.apiKeyEnv : profile.apiKeyEnv) ?? group.credential
    if (typeof api !== 'string' || typeof ref !== 'string' || !ref.trim()) fail('configuration')
    let baseURL: string
    try {
      baseURL = gatewayDiscoveryBaseURL(
        (deepseek ? deepseek.baseURL : profile.baseURL) ?? gatewayInferenceBaseURL(api),
        api,
      )
    } catch {
      fail('configuration')
    }
    let key: string | undefined
    try {
      key = (await credentials.resolve(ref as import('@deepseek-ai/dsh-credentials').CredentialRef))
        ?.value
    } catch {
      fail('service_unavailable')
    }
    if (!key) fail('missing_credentials')
    const deadline = Date.now() + DISCOVERY_TOTAL_BUDGET_MS
    let models!: readonly {
      id: string
      name?: string
      contextWindow?: number
      maxTokens?: number
    }[]
    for (let attempt = 0; attempt < MAX_DISCOVERY_ATTEMPTS; attempt++) {
      const remaining = deadline - Date.now()
      signal = AbortSignal.timeout(Math.max(1, Math.min(DISCOVERY_ATTEMPT_TIMEOUT_MS, remaining)))
      try {
        const discoveryRequest = {
          ...(group.id === 'deepseek' ? {} : { provider: group.provider }),
          baseURL,
          api: 'openai-completions',
          apiKey: key,
        }
        models = isolatedDiscover
          ? await isolatedDiscover(discoveryRequest, signal)
          : await llm!.discoverModels('llm-pi-ai', discoveryRequest, signal)
        break
      } catch (error) {
        const diagnostic = diagnoseGatewayModelFailure(error, signal)
        const delayMs = DISCOVERY_RETRY_DELAYS_MS[attempt] ?? 350
        const timeLeft = deadline - Date.now()
        if (
          attempt + 1 < MAX_DISCOVERY_ATTEMPTS &&
          isTransientGatewayDiscoveryDiagnostic(diagnostic) &&
          timeLeft > delayMs + 2_000
        ) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          continue
        }
        setGatewayCatalogStatus(ctx, group.id, { state: 'error', diagnostic })
        throw new GatewayModelDiscoveryError(group.id, group.name, diagnostic)
      }
    }
    const configured: ModelDraft[] =
      profile.models ?? (group.id === 'deepseek' ? DEFAULT_MODELS : [])
    const offered = new Set(models.map((model) => model.id))
    const choices = gatewayModelChoices(
      models.map((model) => ({ ...model })),
      configured,
    ).filter(
      (model) =>
        offered.has(model.id) &&
        !isRetiredModel({
          provider: 'opl-gateway',
          model: group.id === 'deepseek' ? model.id : `${group.id}::${model.id}`,
        }),
    )
    const candidates = withGatewayModelInputDefaults(
      group.id,
      { ...profile, api, apiKeyEnv: ref, baseURL: profile.baseURL ?? gatewayInferenceBaseURL(api) },
      choices,
    )
    setGatewayCatalogStatus(ctx, group.id, {
      state: candidates.length ? 'ready' : 'empty',
      count: candidates.length,
    })
    return candidates
  } catch (error) {
    const diagnostic = diagnoseGatewayModelFailure(error, signal)
    setGatewayCatalogStatus(ctx, group.id, { state: 'error', diagnostic })
    throw new GatewayModelDiscoveryError(group.id, group.name, diagnostic)
  }
}

/** Refresh only catalogs whose user layer still equals the last automatic import. */
export async function syncGatewayModels(ctx: Context): Promise<void> {
  await migrateLegacyGatewaySettings(ctx)
  const service = modelSettingsService(ctx)
  const account = await ctx.get('oplGatewayAccount')?.status()
  for (const group of GATEWAY_GROUPS) {
    if (gatewayGroupNotGranted(account?.groups?.find((item) => item.id === group.id))) {
      clearGatewayCatalogStatus(ctx, group.id)
      continue
    }
    if (!gatewayGroupEnabled(ctx, group.id)) continue
    try {
      const descriptors = service.describe({ redactSecrets: true })
      const suite = readSuiteDescriptor(descriptors)
      if (!suite)
        throw new GatewayModelDiscoveryError(
          group.id,
          group.name,
          gatewayModelDiagnostic('service_unavailable'),
        )
      const { catalogs, copied } = modelCatalogState(ctx, service)
      const savedModels = catalogs[group.id]
      const hashes = record(record(suite.value).gatewayCatalogHashes)
      // A pre-existing user model list is always preserved unless we can prove ownership.
      if (
        savedModels !== undefined &&
        hashes[group.id] !== catalogFingerprint(savedModels) &&
        !copied.has(group.id)
      ) {
        if (gatewayCatalogStatus(ctx, group.id).state === 'error')
          clearGatewayCatalogStatus(ctx, group.id)
        continue
      }
      let candidates = (await discoverGatewayModels(ctx, { group: group.id })).filter(
        (model) => !isSupersededModelDefault(group.id, model.id),
      )
      // Do not make the default DeepSeek Flash route depend on the optional
      // OpenAI-protocol group. A user can still explicitly add this channel
      // from the Gateway page, which is the durable opt-in boundary.
      if (group.id === 'codex' && (savedModels === undefined || copied.has(group.id)))
        candidates = candidates.filter((model) => model.id !== 'deepseek-flash')
      if (!candidates.length) continue
      const snapshot = await gatewayModelSettings(ctx),
        current = snapshot.groups.find((item) => item.id === group.id)!
      const models = candidates.map((candidate) => {
        const known = current.models.find((model) => model.id === candidate.id)
        return { ...known, ...candidate, ...(known?.name ? { name: known.name } : {}) }
      })
      // The captured revision prevents a concurrent manual edit from being overwritten.
      await editGatewayModels(ctx, {
        group: group.id,
        models,
        api: current.api,
        revision: suite.revision,
      })
      const updated = readSuiteDescriptor(service.describe({ redactSecrets: true }))!
      await mutateSuiteSettings(
        ctx,
        [
          {
            op: 'set',
            path: ['gatewayCatalogHashes', group.id],
            value: catalogFingerprint(models),
          },
        ],
        updated.revision,
      )
    } catch (error) {
      const diagnostic = diagnoseGatewayModelFailure(error)
      setGatewayCatalogStatus(ctx, group.id, { state: 'error', diagnostic })
      if (diagnostic.code !== 'missing_credentials')
        ctx.logger.warn(`OPL Gateway ${group.name} [${diagnostic.code}]: ${diagnostic.message}`)
    }
  }
}

export function catalogFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export type { GatewayPiAiGroupId }
