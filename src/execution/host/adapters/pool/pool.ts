/**
 * Official Poolside Agent CLI (`pool acp`) adapter.
 *
 * The CLI speaks the Agent Client Protocol over stdio and owns its own model
 * catalog, its own endpoint and its own account. The suite contributes three
 * things and nothing else: a pinned tool interpreter, a permission tier mapped
 * onto the CLI's own mode taxonomy, and an exact model pinned over the real ACP
 * config-option methods.
 *
 * **What is pinned, and how it is verified.** `session/new` / `session/load`
 * advertise a `model` and a `mode` config option, and accept `thought_level`
 * only when the endpoint's model rows carry reasoning metadata. Each value
 * written here is written with `session/set_config_option` and then read back
 * from the advertisement the agent returns; a value the agent does not offer, or
 * an advertisement that reports something else afterwards, fails the session
 * before any prompt is sent. `verifySession` re-checks the same advertisement
 * before every prompt, so a session that drifted fails closed.
 *
 * **Nothing is invented.** There is no default model, no default effort and no
 * default mode beyond the permission tier the session already carries. An absent
 * reasoning choice writes nothing and keeps the CLI's own default, because a
 * tier this CLI never advertised is not a control it has.
 *
 * **Isolation is not claimed.** `always-allow` removes the human approval gate
 * and `--sandbox disabled` runs on the host; neither confines the agent to the
 * working directory. See `./pool-permissions.ts`.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { commandLaunch, executablePath } from '../../harness-registry.ts'
import { HarnessConfigurationError } from '../../acp.ts'
import { systemEnvironment } from '../environment.ts'
import { poolSettingsPath, poolShellEnvironment } from './pool-bash.ts'
import { POOL_PERMISSIONS, isPoolMode, poolPermissionPlan } from './pool-permissions.ts'
import {
  POOL_HARNESS,
  POOL_MODE_OPTION,
  POOL_MODEL_OPTION,
  POOL_PROTOCOL,
  POOL_PROVIDER,
  POOL_THOUGHT_OPTION,
  isPoolModel,
  poolThoughtValue,
} from './pool-models.ts'
import type { ModelRef } from '../../../contracts/catalog.ts'
import type { ExternalModelSourceLease, ExternalModelSources } from '../../model-sources.ts'
import type {
  AcpRequestSurface,
  AcpSessionConfigureResult,
  AcpSessionSnapshot,
  HarnessAdapter,
} from '../types.ts'

/** Wire method that writes one config option and returns the fresh advertisement. */
const SET_CONFIG_OPTION = 'session/set_config_option'

/**
 * The official release this adapter was implemented and measured against.
 *
 * The interpreter pin depends on the shell tool's per-call `shell` argument and
 * on the `PreToolUse` `updated_input` rewrite, both verified on 1.0.16. A build
 * outside the verified 1.0.x line is refused instead of being assumed compatible.
 */
export const POOL_VERIFIED_VERSION = '1.0.16'

/** One `select` config option as the official agent advertises it. */
interface AcpConfigOption {
  readonly currentValue: string
  readonly values: readonly string[]
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Read one `select` config option out of an advertised `configOptions` array. */
export function poolConfigOption(configOptions: unknown, id: string): AcpConfigOption | undefined {
  if (!Array.isArray(configOptions)) return undefined
  for (const raw of configOptions) {
    const option = raw as Record<string, any> | null
    if (!option || typeof option !== 'object' || option.id !== id) continue
    const values = Array.isArray(option.options)
      ? option.options
          .map((entry: any) => text(entry?.value))
          .filter((value: string) => value.length > 0)
      : []
    return { currentValue: text(option.currentValue), values }
  }
  return undefined
}

/**
 * Require an agent this adapter was actually implemented against.
 *
 * `initialize` returns `agentInfo: {name, version}`, `loadSession` and a
 * `poolside/sandbox_capability` entry. The name pins the implementation; the
 * version gate refuses a build whose shell tool or hook contract this adapter
 * has not measured, instead of running a pin that may no longer apply.
 *
 * @throws HarnessConfigurationError on an unknown agent name or version.
 */
export function assertPoolAcpVersion(snapshot: AcpSessionSnapshot): void {
  const info = snapshot.agent?.agentInfo as { name?: unknown; version?: unknown } | undefined
  if (text(info?.name) !== 'pool-acp') throw poolFailure('返回的 Agent 不是官方 pool-acp 实现。')
  const version = text(info?.version)
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version)
  if (!parsed) throw poolFailure(`返回的版本无法解析：${version || '空'}。`)
  const [major, minor, patch] = parsed.slice(1).map(Number) as [number, number, number]
  if (major !== 1 || minor !== 0 || patch < 16)
    throw poolFailure(
      `官方版本 ${version} 不在本适配器已验证的 1.0.16+ 1.0.x 范围内，固定解释器所依赖的 shell 参数与钩子契约未实测。`,
    )
}

/**
 * Resolve the exact model id this session must run.
 *
 * @throws HarnessConfigurationError when the reference is not this harness's or
 * the source answered with a different model. Letting a source redirect the id
 * would move the session to another model than the combination names.
 */
export function poolPinnedModel(
  record: { modelRef: ModelRef },
  route: { model: string; protocol: string },
): string {
  const model = poolSessionModel(record)
  if (route.model !== model)
    throw poolFailure('模型来源解析出的模型与所选组合不一致；不会改用来源返回的模型。')
  if (route.protocol !== POOL_PROTOCOL)
    throw poolFailure(`模型来源协议为 ${route.protocol}，与本组合固定的 ${POOL_PROTOCOL} 不一致。`)
  return model
}

/**
 * The exact model a session may pin, decided from the record alone.
 *
 * Called before the first ACP request so a record carrying a foreign provider or an
 * unknown id cannot produce configuration writes on a real session: a wrong write
 * is a state change on the user's official CLI, not something to undo afterwards.
 *
 * @throws HarnessConfigurationError when the reference is not this harness's.
 */
export function poolSessionModel(record: { modelRef: ModelRef }): string {
  if (!record.modelRef || !isPoolModel(record.modelRef))
    throw poolFailure('此模型不属于官方 pool 可固定的组合；不会自动改用其他模型。')
  return record.modelRef.model
}

/**
 * Capture the model source before the first asynchronous step of a launch.
 *
 * `ExternalModelSources.lease(harness, ref)` is a required part of the shared
 * contract: it binds the registration *instance* and its declared pairing, so
 * `assertCurrent()` rejects an unload, a replacement, and a same-object
 * re-registration. Adapters call it after their final preflight await, which is the
 * only place a late withdrawal can otherwise slip through.
 *
 * There is deliberately no `supports()` fallback here. A name-level re-check cannot
 * see one provider id being replaced by a different source object, and quietly
 * degrading to it would turn a real generation check into a weaker one that only
 * looks like coverage.
 *
 * @returns a synchronous check bound to the captured registration.
 * @throws HarnessConfigurationError when the registry exposes no lease, or when the
 * pairing is already unsupported.
 */
export function capturePoolSourceGuard(sources: ExternalModelSources, ref: ModelRef): () => void {
  const withLease = sources as ExternalModelSources & {
    lease?: (harness: string, ref: ModelRef) => ExternalModelSourceLease
  }
  if (typeof withLease.lease !== 'function')
    throw new HarnessConfigurationError(
      '官方 pool：模型来源注册表未提供 lease() 代次租约，无法在启动前确认来源未被撤销；' +
        '已停止，未启动 CLI。请由共享装配层接入 ExternalModelSources.lease。',
    )
  let lease: ExternalModelSourceLease
  try {
    lease = withLease.lease(POOL_HARNESS, ref)
  } catch (error) {
    throw new HarnessConfigurationError(
      `官方 pool：无法为 ${POOL_HARNESS} 捕获模型来源租约（${error instanceof Error ? error.message : String(error)}）。` +
        '已停止，未启动 CLI。',
    )
  }
  return () => {
    try {
      lease.assertCurrent()
    } catch (error) {
      throw new HarnessConfigurationError(
        `官方 pool：模型来源在启动准备期间已变更（${error instanceof Error ? error.message : String(error)}）。` +
          '已停止，未启动 CLI，未沿用已读取的端点或凭据。',
      )
    }
  }
}

/** Fail with a controlled message that never echoes agent-controlled text. */
function poolFailure(message: string): HarnessConfigurationError {
  return new HarnessConfigurationError(`官方 pool：${message}已停止，未发送任务。`)
}

/** Read the session id the adapter should address. */
function poolSessionId(record: { acpSessionId?: string }, snapshot: AcpSessionSnapshot): string {
  const id = text(snapshot.session?.sessionId) || text(record.acpSessionId)
  if (!id) throw poolFailure('未返回会话 ID，无法固定模型与权限。')
  return id
}

/**
 * Write one option and return the advertisement the agent produced afterwards.
 *
 * The agent's own rejection text is deliberately not echoed: it is
 * provider-controlled and can carry account material.
 */
async function applyOption(
  acp: AcpRequestSurface,
  sessionId: string,
  configId: string,
  value: string,
): Promise<unknown> {
  let result: Record<string, any>
  try {
    result = (await acp.request(SET_CONFIG_OPTION, { sessionId, configId, value })) as Record<
      string,
      any
    >
  } catch {
    throw poolFailure(`拒绝设置 ${configId}=${value}（官方 CLI 未接受该配置）。`)
  }
  return result?.configOptions
}

/** Require the agent to report exactly one value for a pinned option. */
function assertPinned(configId: string, value: string, configOptions: unknown): void {
  const option = poolConfigOption(configOptions, configId)
  if (!option) throw poolFailure(`未广告 ${configId} 配置项，无法确认所需取值，已停止。`)
  if (option.currentValue !== value)
    throw poolFailure(`会话 ${configId} 与要求的 ${value} 不一致，未发送任何任务。`)
}

/**
 * Require the live advertisement to exist and to offer every value this session
 * pins, before the first configuration write.
 *
 * The public contract is that a value is chosen *after* seeing the advertisement.
 * Reading the advertisement back out of a write response is not the same thing: a
 * session that starts without one could be written to first and only then appear to
 * agree, which turns a missing capability into a real state change on the user's
 * official CLI. An absent advertisement, an absent arm, or an unadvertised value
 * therefore all fail before `session/set_config_option` is ever sent.
 *
 * @throws HarnessConfigurationError when the advertisement is missing or incomplete.
 */
function assertStartupAdvertisement(
  configOptions: unknown,
  required: readonly { configId: string; value: string }[],
): void {
  if (!Array.isArray(configOptions))
    throw poolFailure(
      '会话未广告配置项，无法在写入前确认模型、权限与思考档位；已停止，未写入任何配置。',
    )
  for (const { configId, value } of required) {
    const option = poolConfigOption(configOptions, configId)
    if (!option)
      throw poolFailure(
        `启动广告中缺少 ${configId} 配置项，无法确认所需取值；已停止，未写入任何配置。`,
      )
    if (!option.values.includes(value))
      throw poolFailure(`启动广告的 ${configId} 不含所需取值 ${value}；已停止，未写入任何配置。`)
  }
}

export const poolAdapter: HarnessAdapter = {
  id: POOL_HARNESS,
  transport: 'acp',
  capabilities: {
    transport: 'acp',
    authentication: 'api-source',
    protocols: [POOL_PROTOCOL],
    // The route comes from the registered source, so the CLI is started against
    // an explicit OpenAI-compatible endpoint instead of any default account.
    customEndpoint: true,
    // `read-only` and `workspace` are absent on purpose: the official boundary
    // is a Docker sandbox whose tools run inside the container, which this host
    // has not measured, so those tiers are refused at launch.
    permissions: [...POOL_PERMISSIONS],
    sessionLoad: true,
    cancel: true,
    reasoning: 'cli-advertised',
    autoReview: 'unsupported',
  },
  matches: isPoolModel,
  async available(_ctx, options) {
    const path = await executablePath(options.command || POOL_HARNESS)
    if (!path)
      return {
        available: false,
        reason:
          '未找到官方 Poolside Agent CLI（pool）。请使用 Poolside 官方安装方式安装，安装后重新检测；此组合只经模型来源使用官方 CLI。',
      }
    // The pinned interpreter is a launch precondition, so report it here rather
    // than letting the first real task fail.
    try {
      await poolShellEnvironment({
        home: join(options.home, 'harnesses', POOL_HARNESS, 'availability'),
        env: systemEnvironment(),
      })
    } catch (error) {
      return { available: false, reason: (error as Error).message }
    }
    return { available: true }
  },
  async prepare(ctx, record, options) {
    // Resolved first: an unsupported permission tier must leave no state behind
    // and must not touch the credential path at all.
    const permissions = poolPermissionPlan(record.sandbox)
    if (!isPoolMode(permissions.mode)) throw poolFailure('权限档位映射结果不是官方模式。')
    poolSessionModel(record)
    const sources = options.modelSources
    if (!sources)
      throw new HarnessConfigurationError(
        `模型来源 ${POOL_PROVIDER} 尚未注册到执行引擎，无法确认此组合的模型与渠道；已停止，未启动 CLI。`,
      )
    // Resolving also re-checks the registration after the await, so a source that
    // was replaced or unloaded during the read cannot authorize a launch.
    // Captured before the first await, so a withdrawal that lands during route
    // resolution or during the shell preflight is still detected afterwards.
    const assertSourceCurrent = capturePoolSourceGuard(sources, record.modelRef)
    const route = await sources.resolve(POOL_HARNESS, record.modelRef, POOL_PROTOCOL)
    poolPinnedModel(record, route)
    const path = await executablePath(options.command || POOL_HARNESS)
    if (!path) throw Error('未找到官方 Poolside Agent CLI（pool），无法启动此组合')
    const home = join(options.home, 'harnesses', POOL_HARNESS, record.id)
    await mkdir(home, { recursive: true, mode: 0o700 })
    // Verified launch environment: the pinned interpreter, the hook audit path and
    // the PATH entry that makes the registered hook command resolvable.
    const shell = await poolShellEnvironment({ home, env: systemEnvironment() })
    // The shell preflight is the last await in this function, so the captured source is
    // re-checked here and once more immediately before the launch leaves.
    assertSourceCurrent()
    const started = commandLaunch(path, [
      ...(options.prefix ?? []),
      'acp',
      '--sandbox',
      permissions.sandbox,
      '--settings',
      poolSettingsPath(home),
    ])
    assertSourceCurrent()
    return {
      home,
      command: started.command,
      args: started.args,
      env: {
        ...shell,
        // Endpoint, credential and model travel as launch environment so the
        // settings file can hold nothing but the interpreter pin.
        POOLSIDE_API_KEY: route.apiKey,
        POOLSIDE_STANDALONE_BASE_URL: route.baseURL,
        POOLSIDE_STANDALONE_MODEL: route.model,
        // Measured profile options on Windows: with only `USERPROFILE` and `APPDATA`
        // redirected and `HOME` left untouched, official pool 1.0.16 created its whole
        // `poolside` tree under `<USERPROFILE>\AppData\Local\poolside` and wrote
        // nothing into the real user profile. `LOCALAPPDATA` changes nothing, because
        // the CLI resolves that local directory from `APPDATA`, so it is not set here.
        // `HOME` is deliberately never rewritten again: the earlier probe that did so
        // stays in `evidence/` as recorded history and is not repeated.
        USERPROFILE: join(home, 'profile'),
        APPDATA: join(home, 'profile', 'appdata'),
      },
      ...(started.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    }
  },
  async configureSession(acp, record, snapshot): Promise<AcpSessionConfigureResult> {
    assertPoolAcpVersion(snapshot)
    // Ownership before the first request: a record carrying a foreign provider or an
    // id this harness does not own must not produce configuration writes on a real
    // official session, because such a write is a state change the user would see.
    const model = poolSessionModel(record)
    const sessionId = poolSessionId(record, snapshot)
    const thinking = poolThoughtValue(record.reasoningEffort)
    const { mode } = poolPermissionPlan(record.sandbox)
    // The live advertisement has to exist and offer the chosen values before the first
    // write, including an explicitly chosen thought level.
    assertStartupAdvertisement(snapshot.configOptions, [
      { configId: POOL_MODEL_OPTION, value: model },
      { configId: POOL_MODE_OPTION, value: mode },
      ...(thinking === undefined ? [] : [{ configId: POOL_THOUGHT_OPTION, value: thinking }]),
    ])
    // Model first and always: it is the authoritative read-back, and the thought
    // arm, when the endpoint offers one, belongs to the selected model.
    let configOptions = await applyOption(acp, sessionId, POOL_MODEL_OPTION, model)
    assertPinned(POOL_MODEL_OPTION, model, configOptions)
    if (thinking !== undefined) {
      const option = poolConfigOption(configOptions, POOL_THOUGHT_OPTION)
      if (!option)
        throw poolFailure(
          `已选择 ${model}，但未广告 ${POOL_THOUGHT_OPTION} 配置项，无法设置 ${thinking} 思考档位；不会改用其他档位。`,
        )
      if (!option.values.includes(thinking))
        throw poolFailure(
          `广告的 ${POOL_THOUGHT_OPTION} 不含所选取值 ${thinking}，未发送任何任务。`,
        )
      if (option.currentValue !== thinking)
        configOptions = await applyOption(acp, sessionId, POOL_THOUGHT_OPTION, thinking)
      assertPinned(POOL_THOUGHT_OPTION, thinking, configOptions)
    }
    const modeOption = poolConfigOption(configOptions, POOL_MODE_OPTION)
    if (!modeOption) throw poolFailure(`未广告 ${POOL_MODE_OPTION} 配置项，无法确认权限档位。`)
    if (!modeOption.values.includes(mode))
      throw poolFailure(`广告的 ${POOL_MODE_OPTION} 不含所需取值 ${mode}，未发送任何任务。`)
    if (modeOption.currentValue !== mode)
      configOptions = await applyOption(acp, sessionId, POOL_MODE_OPTION, mode)
    // Re-check every pinned value against the last reply, not only the one just
    // written: an agent that answers the final write with a different model, mode or
    // thought level has changed the session in a way no single read-back covers.
    assertPinned(POOL_MODEL_OPTION, model, configOptions)
    if (thinking !== undefined) assertPinned(POOL_THOUGHT_OPTION, thinking, configOptions)
    assertPinned(POOL_MODE_OPTION, mode, configOptions)
    return { configOptions }
  },
  verifySession(record, snapshot) {
    assertPoolAcpVersion(snapshot)
    const model = poolSessionModel(record)
    const { mode } = poolPermissionPlan(record.sandbox)
    const thinking = poolThoughtValue(record.reasoningEffort)
    // Same gate as before a write: a session whose advertisement disappeared, lost an
    // arm, or reports a different value fails before the next prompt is sent.
    assertStartupAdvertisement(snapshot.configOptions, [
      { configId: POOL_MODEL_OPTION, value: model },
      { configId: POOL_MODE_OPTION, value: mode },
      ...(thinking === undefined ? [] : [{ configId: POOL_THOUGHT_OPTION, value: thinking }]),
    ])
    assertPinned(POOL_MODEL_OPTION, model, snapshot.configOptions)
    assertPinned(POOL_MODE_OPTION, mode, snapshot.configOptions)
    if (thinking !== undefined) assertPinned(POOL_THOUGHT_OPTION, thinking, snapshot.configOptions)
  },
}

/** Export the launcher so tests can assert the real argument vector. */
export const poolAcpLaunch = (path: string, settings: string, prefix: readonly string[] = []) =>
  commandLaunch(path, [...prefix, 'acp', '--sandbox', 'disabled', '--settings', settings])
