/**
 * Official Muse Code (`muse`) adapter.
 *
 * Muse is a separate program with its own model sources, its own session store and
 * its own protocol (MSP). The suite's job here is only to start it correctly and to
 * refuse anything it cannot guarantee:
 *
 *  - Credentials belong to the model source; this adapter never reads, stores or
 *    prompts for one. It passes the resolved route to the CLI through its documented
 *    provider environment.
 *  - The program belongs to the execution-engine entry; there is no second settings
 *    page and no second way to install the CLI.
 *  - The binding belongs to the execution combination; this adapter pins one exact
 *    model id per lane and refuses any other.
 *
 * Three refusals carry most of the weight, and each exists because the alternative is
 * a silent substitution:
 *
 *  1. The source registration is leased before any asynchronous work and re-checked
 *     after the last await, immediately before the launch is returned. A source that
 *     is unloaded mid-read, replaced, or unloaded and re-registered cannot authorize
 *     the launch that was prepared against it.
 *  2. Git Bash is resolved and proven before the CLI starts. The built-in shell is
 *     PowerShell and cannot be redirected into a POSIX shell, so a missing Git Bash is
 *     a launch failure rather than a downgrade.
 *  3. Only `full-access` is advertised. The Bash tool is an MCP server and the CLI
 *     runs MCP servers outside its native sandbox, so no restricted tier could bound
 *     it; claiming one would be claiming a boundary that was never measured.
 *
 * Source endpoints are written through the official endpoint_transport setting.
 * The MSP bridge translates namespaced MCP tools for the OFM Responses listener.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { commandLaunch, executablePath } from '../../harness-registry.ts'
import { HarnessConfigurationError } from '../../acp.ts'
import { systemEnvironment } from '../environment.ts'
import {
  MUSE_BASH_ENV,
  MUSE_MCP_TOOL,
  assertBashToolUsable,
  museBashEnvironment,
  museMcpServer,
  writeMuseSettings,
} from './muse-bash.ts'
import {
  MUSE_COMMAND,
  MUSE_BOUND_BASE_URL,
  MUSE_EFFORTS,
  MUSE_SCHEMA_FINGERPRINT,
  MUSE_SUPPORTS_SOURCE_ENDPOINT,
  MUSE_HARNESS,
  MUSE_PROTOCOL,
  museEffortValue,
  museLane,
} from './muse-models.ts'
import { musePermissionPlan, museSandboxArgs } from './muse-permissions.ts'
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

/** Environment names the bridge reads. Grouped so the bridge contract stays in one place. */
export const MUSE_LAUNCH_ENV = {
  command: 'OPL_MUSE_COMMAND',
  prefix: 'OPL_MUSE_PREFIX',
  verbatim: 'OPL_MUSE_VERBATIM',
  model: 'OPL_MUSE_MODEL',
  baseUrl: 'OPL_MUSE_BASE_URL',
  protocol: 'OPL_MUSE_PROTOCOL',
  effort: 'OPL_MUSE_EFFORT',
  approvalMode: 'OPL_MUSE_APPROVAL_MODE',
  contributorMode: 'OPL_MUSE_CONTRIBUTOR_MODE',
  bashTool: 'OPL_MUSE_BASH_TOOL',
  schemaFingerprint: 'OPL_MUSE_SCHEMA_FINGERPRINT',
} as const

/**
 * The official credential variable the CLI reads.
 *
 * Verified on 1.4.7-R6101.1: with this set to an invalid value the CLI reports
 * `failed to fetch model catalog: authentication failed: your API key from META_API_KEY
 * was rejected — update or unset it`, and with it unset it reports `missing meta
 * credentials: run \`muse login\` or set META_API_KEY, or save credentials at
 * <museHome>/auth.json`. Both messages name this variable, so it is the documented
 * entry rather than an inferred one.
 */
export const MUSE_CREDENTIAL_ENV = 'META_API_KEY'

/**
 * Resolve the exact lane, protocol and route for this session.
 *
 * The id stays this lane's own. A source that answers with a different model, or that
 * is no longer registered, fails the launch rather than moving the session onto
 * whatever the source prefers.
 * @param record - the session whose combination must be honoured.
 * @param options - adapter options carrying the registered sources.
 * @returns the pinned model, protocol and resolved route.
 * @throws HarnessConfigurationError when the reference, the source, or the resolved
 * route is not this harness's.
 */
export async function resolveMuseRoute(
  record: { modelRef: ModelRef },
  options: AdapterOptions,
  supportsSourceEndpoint: boolean = MUSE_SUPPORTS_SOURCE_ENDPOINT,
): Promise<{
  lane: NonNullable<ReturnType<typeof museLane>>
  baseURL: string
  apiKey: string
  protocol: typeof MUSE_PROTOCOL
}> {
  const lane = museLane(record.modelRef)
  if (!lane)
    throw new HarnessConfigurationError(
      '此模型不属于官方 Muse Code 可固定的组合；已停止，未启动 CLI，不会改用其他模型。',
    )
  const sources = options.modelSources
  if (!sources)
    throw new HarnessConfigurationError(
      `模型来源 ${lane.provider} 尚未注册到执行引擎，无法确认此组合的模型与渠道；已停止，未启动 CLI。`,
    )
  const route = await sources.resolve(MUSE_HARNESS, record.modelRef, lane.protocol)
  if (route.model !== lane.model)
    throw new HarnessConfigurationError(
      `模型来源解析出的模型（${route.model}）与所选组合（${lane.model}）不一致；已停止，未改用来源返回的模型。`,
    )
  if (route.protocol !== lane.protocol)
    throw new HarnessConfigurationError(
      `模型来源协议（${route.protocol}）与官方 Muse Code 的渠道（${lane.protocol}）不兼容；已停止，未启动 CLI。`,
    )
  if (!supportsSourceEndpoint)
    throw new HarnessConfigurationError('此 Muse 构建未启用官方端点配置；未启动 CLI。')
  return { lane, baseURL: route.baseURL, apiKey: route.apiKey, protocol: lane.protocol }
}

/** Directories one session owns, all inside the suite home. */
export interface MuseStorage {
  home: string
  configHome: string
  dataHome: string
  projectsHome: string
  scratch: string
}

/**
 * Lay out the session-owned directories.
 *
 * Muse is pointed at its own profile through `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and
 * `MUSE_PROJECTS_HOME`, never through `HOME`/`USERPROFILE`/`CODEX_HOME`: the official
 * `initialize` result reports `museHome` as `<XDG_DATA_HOME>/muse`, so these three are
 * the documented entry points, and leaving the user's own profile variables untouched
 * is what keeps this session out of their stored Muse state.
 * @param home - the suite-owned session root.
 * @returns the created directories.
 */
export async function museStorage(home: string): Promise<MuseStorage> {
  const storage: MuseStorage = {
    home,
    configHome: join(home, 'profile', 'config'),
    dataHome: join(home, 'profile', 'data'),
    projectsHome: join(home, 'profile', 'projects'),
    scratch: join(home, 'tmp'),
  }
  for (const directory of Object.values(storage)) await mkdir(directory, { recursive: true })
  return storage
}

const failure = (message: string): HarnessConfigurationError =>
  new HarnessConfigurationError(`官方 Muse Code：${message}已停止，未发送任务。`)

/**
 * Variables that would point the CLI at somebody else's profile.
 *
 * The suite's environment allowlist copies these from the ambient process, and the
 * Muse binary reads them for foreign-profile discovery — `CODEX_HOME` and
 * `CLAUDE_CONFIG_DIR` appear verbatim in its environment table. This session already
 * has official, session-owned entry points (`XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
 * `MUSE_PROJECTS_HOME`), so these are removed rather than inherited: leaving them in
 * would let a launch read a user's stored Muse state, which is exactly what this
 * adapter promises not to do.
 */
const PROFILE_VARIABLES = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
]

/** Copy an environment without the profile-discovery variables. */
function withoutProfileVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env }
  for (const name of PROFILE_VARIABLES) delete clean[name]
  return clean
}

/**
 * Prepare the official process for one session.
 *
 * Ordering is the contract: the permission tier and the model lane are checked first
 * so an unsupported combination writes nothing; then the source is leased and
 * resolved; then the tool's interpreter and script are proven; and only after the last
 * await is the lease re-checked, immediately before the launch is returned.
 * @param ctx - plugin context, unused by this adapter.
 * @param record - the session to launch.
 * @param options - adapter options.
 * @param bridgePath - absolute path to the compiled MSP→ACP bridge.
 * @returns the launch the execution engine spawns.
 */
async function prepareMuseLaunch(
  _ctx: Context,
  record: HarnessSession,
  options: AdapterOptions,
  bridgePath: string,
  supportsSourceEndpoint: boolean,
): Promise<AdapterLaunch> {
  // Permission first: an unsupported tier must leave no state behind and must not
  // touch the credential path at all.
  const permissions = musePermissionPlan(record.sandbox)
  const lane = museLane(record.modelRef)
  if (!lane)
    throw new HarnessConfigurationError(
      '此模型不属于官方 Muse Code 可固定的组合；已停止，未启动 CLI，不会改用其他模型。',
    )
  const effort = museEffortValue(record.reasoningEffort)
  const sources = options.modelSources
  if (!sources)
    throw new HarnessConfigurationError(
      `模型来源 ${lane.provider} 尚未注册到执行引擎，无法确认此组合的模型与渠道；已停止，未启动 CLI。`,
    )
  // Captured before the first await, so a registration that disappears during
  // preparation cannot authorize the launch this call is about to return.
  const lease = sources.lease(MUSE_HARNESS, record.modelRef)
  const route = await resolveMuseRoute(record, options, supportsSourceEndpoint)
  const path = await executablePath(options.command || MUSE_COMMAND)
  if (!path) throw Error('未找到官方 Muse Code CLI（muse），无法启动此组合')
  const bashTool = await museBashEnvironment(systemEnvironment())
  const storage = await museStorage(join(options.home, 'harnesses', record.harnessRef, record.id))
  const serverPath = fileURLToPath(new URL('./muse-bash-mcp.mjs', import.meta.url))
  await assertBashToolUsable(serverPath, process.execPath)
  const server = museMcpServer(process.execPath, serverPath, bashTool.env, bashTool.shell)
  // Written under the session's own config home, so a resumed session keeps the tool
  // without any user profile being read or modified.
  await writeMuseSettings(storage.configHome, server, route.baseURL)

  const serveArgs = [...museSandboxArgs(permissions), '--trust-workspace']
  const started = commandLaunch(path, [
    ...(options.prefix ?? []),
    'serve',
    '--provider',
    'meta',
    '--model',
    route.lane.model,
    '--contributor-mode',
    route.lane.contributorMode,
    ...serveArgs,
  ])
  // Final asynchronous work is done. Re-check the registration identity now, so an
  // unload, a replacement, or an unload followed by a re-registration all refuse the
  // launch. Thrown before the caller can spawn anything.
  lease.assertCurrent()
  return {
    home: storage.home,
    command: process.execPath,
    args: [bridgePath],
    env: {
      ...withoutProfileVariables(bashTool.env),
      ELECTRON_RUN_AS_NODE: '1',
      [MUSE_BASH_ENV]: bashTool.shell,
      [MUSE_LAUNCH_ENV.command]: started.command,
      [MUSE_LAUNCH_ENV.prefix]: JSON.stringify(started.args),
      [MUSE_LAUNCH_ENV.verbatim]: started.windowsVerbatimArguments ? '1' : '',
      [MUSE_LAUNCH_ENV.model]: route.lane.model,
      [MUSE_LAUNCH_ENV.baseUrl]: route.baseURL,
      // The credential reaches the CLI only through its own documented variable. It is
      // never echoed into argv, a settings file, a log line or an error message.
      [MUSE_CREDENTIAL_ENV]: route.apiKey,
      [MUSE_LAUNCH_ENV.protocol]: route.protocol,
      [MUSE_LAUNCH_ENV.effort]: effort ?? '',
      [MUSE_LAUNCH_ENV.approvalMode]: permissions.approvalMode,
      [MUSE_LAUNCH_ENV.contributorMode]: route.lane.contributorMode,
      [MUSE_LAUNCH_ENV.bashTool]: MUSE_MCP_TOOL,
      [MUSE_LAUNCH_ENV.schemaFingerprint]: MUSE_SCHEMA_FINGERPRINT,
      // Muse's own profile entry points. HOME/USERPROFILE/CODEX_HOME are deliberately
      // absent above: the CLI reads foreign profiles through them, and this session
      // must not touch the user's account state.
      XDG_CONFIG_HOME: storage.configHome,
      XDG_DATA_HOME: storage.dataHome,
      MUSE_PROJECTS_HOME: storage.projectsHome,
      TEMP: storage.scratch,
      TMP: storage.scratch,
      TMPDIR: storage.scratch,
    },
  }
}

/**
 * Build the official Muse Code adapter.
 * @param bridgePath - absolute path to the compiled MSP→ACP bridge.
 * @returns the adapter for the registry.
 */
export interface MuseAdapterBuild {
  /** Whether the build enables the verified official endpoint_transport setting. */
  supportsSourceEndpoint?: boolean
}

export function createMuseCodeAdapter(
  bridgePath: string,
  build: MuseAdapterBuild = {},
): HarnessAdapter {
  const supportsSourceEndpoint = build.supportsSourceEndpoint ?? MUSE_SUPPORTS_SOURCE_ENDPOINT
  return {
    id: MUSE_HARNESS,
    transport: 'acp',
    capabilities: {
      transport: 'official-sdk',
      authentication: 'api-source',
      // The Meta provider route the official CLI speaks is the Responses API, and the
      // captured request body confirms it. No other protocol is offered.
      protocols: [MUSE_PROTOCOL],
      // Claimed only in proportion to what this build can actually bind; see
      // resolveMuseRoute for the refusal that enforces it.
      customEndpoint: supportsSourceEndpoint,
      // Only full-access: see ./muse-permissions.ts. The other tiers are refused at
      // launch rather than mapped onto a boundary the MCP-hosted tool would escape.
      permissions: ['full-access'],
      // `session/resume` is a documented, implemented MSP method on this build.
      sessionLoad: true,
      // `turn/cancel` is documented and acknowledged on this build.
      cancel: true,
      // Effort is read back from the official `session/setReasoningEffort`
      // acknowledgement rather than assumed from the label.
      reasoning: 'cli-advertised',
      // The official CLI has no review surface the suite can pin; nothing is claimed.
      autoReview: 'unsupported',
    },
    matches: (ref) => museLane(ref) !== undefined,
    async available(_ctx, options) {
      if (!supportsSourceEndpoint)
        return { available: false, reason: '官方 Muse Code 尚不支持模型来源的自定义端点' }
      const path = await executablePath(options.command || MUSE_COMMAND)
      if (!path)
        return {
          available: false,
          reason:
            '未找到官方 Muse Code CLI（muse）。请使用 Muse Code 官方安装方式安装，安装后重新检测；凭据由模型来源入口管理，此组合不要求在此登录。',
        }
      // Git Bash is a launch precondition, so it is reported here instead of letting
      // the first real task fail. This probes the suite's own resolver and never
      // touches an account.
      try {
        await museBashEnvironment(systemEnvironment())
      } catch (error) {
        return { available: false, reason: (error as Error).message }
      }
      return { available: true }
    },
    prepare: (ctx, record, options) =>
      prepareMuseLaunch(ctx, record, options, bridgePath, supportsSourceEndpoint),
    /**
     * The bridge pins model and effort as part of `session/new`, because MSP selects
     * them before the session is handed over rather than through an ACP config option.
     * The read-back therefore lives in the bridge, and this hook re-asserts the same
     * two values against whatever the bridge reported.
     */
    async configureSession(
      _acp: AcpRequestSurface,
      record: HarnessSession,
      snapshot: AcpSessionSnapshot,
    ): Promise<AcpSessionConfigureResult> {
      const lane = museLane(record.modelRef)
      if (!lane) throw failure('此模型不属于官方 Muse Code 可固定的组合，未启动 CLI。')
      const sessionId =
        (typeof snapshot.session?.sessionId === 'string' ? snapshot.session.sessionId : '') ||
        record.acpSessionId
      if (!sessionId) throw failure('未返回会话 ID，无法固定模型与思考档位。')
      const effort = museEffortValue(record.reasoningEffort)
      assertMuseObservation(record, snapshot, effort)
      return {
        configOptions: { modelId: lane.model, ...(effort ? { reasoningEffort: effort } : {}) },
      }
    },
    /**
     * Runs before every prompt. The MSP host is the authority for what the session is
     * actually running, so this re-checks the pinned lane against the last read-back.
     *
     * It fails closed. An absent observation is not evidence: if the bridge has not
     * reported the model, or has not reported the effort the combination names, then
     * this hook cannot say the session is still on the pinned lane, and a prompt sent
     * on that assumption could run on a different model or tier. Refusing is the only
     * answer that keeps the word "verified" honest.
     */
    verifySession(record, snapshot) {
      const lane = museLane(record.modelRef)
      if (!lane) throw failure('此模型不属于官方 Muse Code 可固定的组合，未发送任务。')
      assertMuseObservation(record, snapshot, museEffortValue(record.reasoningEffort))
    },
  }
}

/**
 * Require the bridge's read-back to actually carry the pinned model, and the pinned
 * effort whenever the combination names one.
 *
 * Absence is reported as its own failure, separate from a mismatch, because the two
 * mean different things: a mismatch is a known drift, while an absence means the
 * session state was never observed and nothing can be claimed about it.
 * @param record - the session whose combination must hold.
 * @param snapshot - the ACP session and config advertisement the bridge produced.
 * @param effort - the official effort tier this session pinned, if any.
 * @throws HarnessConfigurationError when either observation is missing or disagrees.
 */
function assertMuseObservation(
  record: HarnessSession,
  snapshot: AcpSessionSnapshot,
  effort: string | undefined,
): void {
  const lane = museLane(record.modelRef)!
  const reportedModel = snapshot.session?.models?.currentModelId
  if (typeof reportedModel !== 'string' || reportedModel === '')
    throw failure(
      '未取得会话当前模型的回读，无法确认此组合的模型仍被固定；未发送任何任务，也不会在未复核的情况下发送。',
    )
  if (reportedModel !== lane.model)
    throw failure(`会话模型 ${reportedModel} 与所选组合 ${lane.model} 不一致，未发送任何任务。`)

  const advertised = snapshot.configOptions as Record<string, unknown> | undefined
  const advertisedModel = advertised?.modelId
  if (typeof advertisedModel === 'string' && advertisedModel !== lane.model)
    throw failure(`广告的模型 ${advertisedModel} 与所选组合 ${lane.model} 不一致，未发送任务。`)

  if (effort === undefined) return
  const reportedEffort = advertised?.reasoningEffort
  if (typeof reportedEffort !== 'string' || reportedEffort === '')
    throw failure(
      `未取得思考档位的回读，无法确认此组合的 ${effort} 仍被固定；未发送任何任务，也不会在未复核的情况下发送。`,
    )
  if (reportedEffort !== effort)
    throw failure(`会话思考档位 ${reportedEffort} 与要求的 ${effort} 不一致，未发送任何任务。`)
}

/**
 * Adapter used when the packager supplies the bridge path at module scope.
 *
 * `fileURLToPath` rather than `URL.pathname`: the latter yields `/C:/…` on Windows,
 * which is not a path the spawn can resolve.
 */
export const museCodeAdapter: HarnessAdapter = createMuseCodeAdapter(
  fileURLToPath(new URL('./muse-bridge.mjs', import.meta.url)),
)
