/**
 * Official Pi Coding Agent (`pi`) adapter for the OPL execution engine.
 *
 * Pi has no ACP server, so this adapter contributes three things and nothing else: a
 * verified Git-for-Windows shell, a permission tier this product can actually honour, and
 * the exact model identity the bridge must pin. The ACP surface itself is produced by
 * `./pi-bridge.ts`, which projects the official `pi --mode rpc` protocol onto ACP without
 * reimplementing the official agent loop — prompting, tool execution, context management
 * and session persistence all stay inside the `pi` process.
 *
 * **What this adapter never does.** It does not guess an endpoint, does not silently swap
 * a model, does not widen a permission, and does not read a credential from a global user
 * profile. The model route is resolved through the registered model-source owner
 * (`options.modelSources.resolve`) and rejected if the owner's answer does not name this
 * lane's exact model and pinned protocol. The shell is verified by execution and has no
 * PowerShell/CMD/WSL fallback.
 *
 * **Launch-time source freshness.** Preparation is asynchronous (route resolution, CLI
 * lookup, shell probe). A source can be revoked, replaced or re-registered at any point in
 * that window, so the registration identity is captured with a lease *before* the first
 * await and re-checked twice: once after the last asynchronous preflight, and once
 * immediately before returning the launch. Unregistering and re-registering the same
 * source object still fails the check, because the lease binds to the registration, not to
 * a provider name.
 *
 * **Scope of the credentials.** Pi's official `models.json` schema resolves `apiKey`
 * through `$ENV_VAR` interpolation, so the resolved key is placed only in the bridge's
 * launch environment and referenced indirectly by a credential-blind config file. It is
 * never written to a file, an argument vector, or a log, and the real `~/.pi/agent` of
 * the signed-in user is neither read nor modified: the agent directory, session directory
 * and scratch all live under this session's own suite-owned home, reached through Pi's
 * official dedicated profile entry rather than by repointing `HOME`.
 *
 * Integration for the packager is additive and consists of adding this adapter to the
 * adapter registry and to the harness list used for default-harness resolution, and of
 * letting the model source owner authorize this pairing. No new settings page, credential
 * store, or navigation item is required: credentials belong to the model source entry, the
 * program to the execution-engine entry, and the binding to the execution-combination
 * entry.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { executablePath } from '../../harness-registry.ts'
import { acceptVisibleCliResult } from '../visible-result.ts'
import { HarnessConfigurationError } from '../../acp.ts'
import { systemEnvironment } from '../environment.ts'
import { piBashEnvironment } from './pi-bash.ts'
import {
  piApiForProtocol,
  piLaneProtocol,
  piLaneReasoning,
  piThinkingValue,
  isPiCodeModel,
  piLane,
  PI_HARNESS,
  PI_PROVIDER,
  PI_MODEL_OPTION,
  PI_THINKING_OPTION,
} from './pi-models.ts'
import { piPermissionPlan } from './pi-permissions.ts'
import { PI_AGENT_DIR_ENV, PI_SESSION_DIR_ENV, PI_CREDENTIAL_ENV, piStorage } from './pi-config.ts'
import type { ModelRef } from '../../../contracts/catalog.ts'
import type { HarnessSession } from '../../../contracts/sessions.ts'
import type {
  AcpRequestSurface,
  AcpSessionConfigureResult,
  AcpSessionSnapshot,
  AdapterLaunch,
  AdapterOptions,
  HarnessAdapter,
} from '../types.ts'

/**
 * Resolve the exact model id and protocol this session must run, from the registered
 * source.
 *
 * The id is the lane's own id, and the resolved route must agree. Letting a source redirect
 * the id would move the session to a different model than the combination names, which is
 * precisely the silent substitution this adapter refuses — an unknown source, a source that
 * withdrew support while resolving, or a source that answers with a different model or
 * protocol all fail the launch.
 *
 * @throws HarnessConfigurationError when the reference, lane, or resolved route is not
 * this harness's.
 */
export async function resolvePiRoute(
  record: { modelRef: ModelRef },
  options: AdapterOptions,
): Promise<{
  model: string
  provider: string
  protocol: string
  api: string
  baseURL: string
  apiKey: string
}> {
  const lane = piLane(record.modelRef)
  if (!lane)
    throw new HarnessConfigurationError(
      '此模型不属于官方 Pi 可固定的组合；已停止，未启动 CLI，不会改用其他模型。',
    )
  const protocol = piLaneProtocol(record.modelRef)
  if (!protocol)
    throw new HarnessConfigurationError(
      `官方 Pi 未为 ${lane.model} 固定执行协议；已停止，未启动 CLI，不会改用其他协议。`,
    )
  const sources = options.modelSources
  if (!sources)
    throw new HarnessConfigurationError(
      `模型来源 ${PI_PROVIDER} 尚未注册到执行引擎，无法确认此组合的模型与渠道；已停止，未启动 CLI。`,
    )
  // Resolving also re-checks the registration after the await, so a source that was
  // replaced or unloaded during the read cannot authorize a launch.
  const route = await sources.resolve(PI_HARNESS, record.modelRef, protocol)
  if (route.model !== lane.model)
    throw new HarnessConfigurationError(
      `模型来源解析出的模型（${route.model}）与所选组合（${lane.model}）不一致；已停止，未改用来源返回的模型。`,
    )
  return {
    model: lane.model,
    provider: lane.provider,
    protocol,
    api: piApiForProtocol(protocol),
    baseURL: route.baseURL,
    apiKey: route.apiKey,
  }
}

/**
 * Read one `select` config option out of an advertised `configOptions` array.
 *
 * A malformed or absent advertisement is treated as absent, so it fails the pinning checks
 * instead of passing them.
 */
export function piConfigOption(
  configOptions: unknown,
  id: string,
): { currentValue: string; values: string[] } | undefined {
  if (!Array.isArray(configOptions)) return undefined
  for (const raw of configOptions) {
    const option = raw as Record<string, any> | null
    if (!option || typeof option !== 'object' || option.id !== id) continue
    const values = Array.isArray(option.options)
      ? option.options
          .map((entry: any) => (typeof entry?.value === 'string' ? entry.value : ''))
          .filter((value: string) => value.length > 0)
      : []
    return {
      currentValue: typeof option.currentValue === 'string' ? option.currentValue : '',
      values,
    }
  }
  return undefined
}

const failure = (message: string): HarnessConfigurationError =>
  new HarnessConfigurationError(`官方 Pi：${message}已停止，未发送任务。`)

/**
 * Assert the advertisement offers the required model (and, when chosen, the tier).
 *
 * Checking before the write lets an unsupported request name the exact offered set instead
 * of failing as an opaque rejection.
 */
function assertAdvertised(configId: string, value: string, configOptions: unknown): void {
  const option = piConfigOption(configOptions, configId)
  if (!option) throw failure(`未广告 ${configId} 配置项，无法确认所需取值 ${value}。`)
  if (!option.values.includes(value))
    throw failure(
      `广告的 ${configId} 不含所需取值 ${value}（实际：${option.values.join('、') || '无'}）。`,
    )
}

/** Require the advertisement to report the pinned value for an option. */
function assertPinned(
  configId: string,
  value: string,
  configOptions: unknown,
  present: boolean,
): void {
  if (!present) return
  const option = piConfigOption(configOptions, configId)
  if (!option) throw failure(`未广告 ${configId} 配置项，无法确认所需取值。`)
  if (option.currentValue !== value)
    throw failure(
      `会话 ${configId} 与要求的 ${value} 不一致（实际 ${option.currentValue || '空'}），未发送任何任务。`,
    )
}

async function preparePiLaunch(
  _ctx: Context,
  record: HarnessSession,
  options: AdapterOptions,
  bridgePath: string,
): Promise<AdapterLaunch> {
  // Permission first: an unsupported tier must leave no state behind and must not touch the
  // credential path at all.
  const permissions = piPermissionPlan(record.sandbox)
  if (!isPiCodeModel(record.modelRef))
    throw new HarnessConfigurationError(
      '此模型不属于官方 Pi 可固定的组合；已停止，未启动 CLI，不会改用其他模型。',
    )

  // The registration identity is captured *before* the first await. A lease taken later
  // could bind to a registration that already replaced the one this launch began with.
  const sources = options.modelSources
  if (!sources)
    throw new HarnessConfigurationError(
      `模型来源 ${PI_PROVIDER} 尚未注册到执行引擎，无法确认此组合的模型与渠道；已停止，未启动 CLI。`,
    )
  const lease = sources.lease(PI_HARNESS, record.modelRef)

  const route = await resolvePiRoute(record, options)
  const path = await executablePath(options.command || PI_HARNESS)
  if (!path) throw Error('未找到官方 Pi CLI（pi），无法启动此组合')
  const shell = await piBashEnvironment(systemEnvironment())

  // Everything asynchronous is finished here. A source revoked or replaced during the
  // awaits above must not authorize this launch.
  lease.assertCurrent()

  const home = join(options.home, 'harnesses', record.harnessRef, record.id)
  await mkdir(home, { recursive: true })
  const storage = piStorage(home)
  await mkdir(storage.agentDir, { recursive: true })
  await mkdir(storage.sessionDir, { recursive: true })
  await mkdir(storage.scratchDir, { recursive: true })

  const thinking = piThinkingValue(record.reasoningEffort) ?? ''

  // Re-checked immediately before the launch is returned, with no suspension point between
  // the check and the return. This is what refuses a source that was unregistered and then
  // registered again as a different object during preparation.
  lease.assertCurrent()

  return {
    home,
    command: process.execPath,
    args: [bridgePath],
    env: {
      ...shell.env,
      ELECTRON_RUN_AS_NODE: '1',
      OPL_PI_COMMAND: path,
      OPL_PI_PREFIX: JSON.stringify(options.prefix ?? []),
      OPL_PI_AGENT_DIR: storage.agentDir,
      OPL_PI_SESSION_DIR: storage.sessionDir,
      OPL_PI_SESSION_INDEX_DIR: storage.sessionIndexDir,
      OPL_PI_PROVIDER: route.provider,
      OPL_PI_MODEL: route.model,
      OPL_PI_BASE_URL: route.baseURL,
      OPL_PI_API: route.api,
      OPL_PI_REASONING: piLaneReasoning(record.modelRef) ? '1' : '0',
      OPL_PI_PROTOCOL: route.protocol,
      OPL_PI_THINKING: thinking,
      OPL_PI_PERMISSION_TIER: permissions.tier,
      OPL_PI_SHELL_PATH: shell.shell ?? '',
      // The credential reaches the CLI only through its own environment, referenced by the
      // official `$ENV_VAR` interpolation in a credential-blind `models.json`.
      [PI_CREDENTIAL_ENV]: route.apiKey,
      [PI_AGENT_DIR_ENV]: storage.agentDir,
      [PI_SESSION_DIR_ENV]: storage.sessionDir,
      TEMP: storage.scratchDir,
      TMP: storage.scratchDir,
    },
  }
}

/**
 * Build the official Pi adapter.
 *
 * @param bridgePath - absolute path to the compiled RPC→ACP bridge. The packager supplies
 * this the same way it supplies the other external bridges, because `AdapterOptions` is a
 * shared contract this adapter must not modify.
 * @returns the adapter for the registry.
 */
export function createPiAdapter(bridgePath: string): HarnessAdapter {
  return {
    id: PI_HARNESS,
    transport: 'acp',
    capabilities: {
      transport: 'official-sdk',
      authentication: 'api-source',
      protocols: ['chat', 'responses', 'messages'],
      customEndpoint: true,
      // `read-only` and `workspace` are absent on purpose: the official product has no
      // approval gate and no filesystem boundary (see ./pi-permissions.ts), so those
      // tiers are refused at launch rather than advertised and mapped.
      permissions: ['full-access'],
      sessionLoad: true,
      cancel: true,
      reasoning: 'cli-advertised',
      autoReview: 'unsupported',
    },
    matches: isPiCodeModel,
    acceptResult: acceptVisibleCliResult,
    async available(_ctx, options) {
      const path = await executablePath(options.command || PI_HARNESS)
      if (!path)
        return {
          available: false,
          reason:
            '未找到官方 Pi Coding Agent CLI（pi）。请使用官方安装方式安装，安装后重新检测；此组合不依赖 OPL Gateway 的凭据。',
        }
      // The Windows shell is a launch precondition, so report it here rather than letting
      // the first real task fail. This probes the suite's own provider and never touches
      // an account.
      try {
        await piBashEnvironment(systemEnvironment())
      } catch (error) {
        return { available: false, reason: (error as Error).message }
      }
      return { available: true }
    },
    prepare: (ctx, record, options) => preparePiLaunch(ctx, record, options, bridgePath),
    async configureSession(
      acp: AcpRequestSurface,
      record: HarnessSession,
      snapshot: AcpSessionSnapshot,
    ): Promise<AcpSessionConfigureResult> {
      const lane = piLane(record.modelRef)
      if (!lane) throw failure('此模型不属于官方 Pi 可固定的组合，未启动 CLI。')
      const sessionId =
        (typeof snapshot.session?.sessionId === 'string' ? snapshot.session.sessionId : '') ||
        record.acpSessionId
      if (!sessionId) throw failure('未返回会话 ID，无法固定模型与思考档位。')
      const model = lane.model
      const thinking = piThinkingValue(record.reasoningEffort)
      const advertised = snapshot.configOptions !== undefined

      // Model first and always: it is the authoritative read-back, and a tier only becomes
      // meaningful once the model that owns it is selected.
      if (advertised) assertAdvertised(PI_MODEL_OPTION, model, snapshot.configOptions)
      let configOptions = await applyConfigOption(acp, sessionId, PI_MODEL_OPTION, model)
      assertPinned(PI_MODEL_OPTION, model, configOptions, true)
      if (thinking !== undefined) {
        const option = piConfigOption(configOptions, PI_THINKING_OPTION)
        if (!option)
          throw failure(
            `已选择 ${model}，但未广告 ${PI_THINKING_OPTION} 配置项，无法设置 ${thinking} 思考档位。`,
          )
        if (!option.values.includes(thinking))
          throw failure(
            `广告的 ${PI_THINKING_OPTION} 不含所选取值 ${thinking}（实际：${option.values.join('、') || '无'}）。`,
          )
        if (option.currentValue !== thinking)
          configOptions = await applyConfigOption(acp, sessionId, PI_THINKING_OPTION, thinking)
        assertPinned(PI_THINKING_OPTION, thinking, configOptions, true)
      }
      return { configOptions }
    },
    verifySession(record, snapshot) {
      const lane = piLane(record.modelRef)
      if (!lane) throw failure('此模型不属于官方 Pi 可固定的组合，未发送任务。')
      const present = snapshot.configOptions !== undefined
      assertPinned(PI_MODEL_OPTION, lane.model, snapshot.configOptions, present)
      const thinking = piThinkingValue(record.reasoningEffort)
      if (thinking !== undefined)
        assertPinned(PI_THINKING_OPTION, thinking, snapshot.configOptions, present)
    },
  }
}

/**
 * Write one pinned config option over ACP and return the fresh advertisement.
 *
 * The bridge rejects a value that is not this combination's, so a silent downgrade is
 * impossible; the agent's own rejection text is not echoed because it is
 * provider-controlled.
 */
async function applyConfigOption(
  acp: AcpRequestSurface,
  sessionId: string,
  configId: string,
  value: string,
): Promise<unknown> {
  let result: Record<string, any>
  try {
    result = (await acp.request('session/set_config_option', {
      sessionId,
      configId,
      value,
    })) as Record<string, any>
  } catch {
    throw failure(`拒绝设置 ${configId}=${value}（官方 Pi 未接受该配置）。`)
  }
  return result?.configOptions
}

/**
 * Adapter used when the packager supplies the bridge path at module scope.
 *
 * `fileURLToPath` rather than `URL.pathname`: the latter yields `/C:/…` on Windows, which
 * is not a path the spawn can resolve.
 */
export const piAdapter: HarnessAdapter = createPiAdapter(
  fileURLToPath(new URL('./pi-bridge.mjs', import.meta.url)),
)
