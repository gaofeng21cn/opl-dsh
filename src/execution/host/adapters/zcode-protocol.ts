import type { Socket } from 'node:net'

/** Official ZCode Protocol constants and the pure projection onto ACP updates.
 *
 * Every name in this file is taken from the official ZCode source, not inferred:
 * `packages/shared/src/zcode-protocol/index.ts` (ZCODE_PROTOCOL_NAME/VERSION and
 * `zcodeProtocolMethods`), `zcode-protocol-legacy-types.ts` (message parts, tool
 * states, permission response) and `packages/provider/src/config/provider-data-schema.ts`
 * plus the shipped `config/provider/zcode-builtin.json` (provider config file shape).
 * This file owns no agent loop, model request or tool execution.
 */

/** Official protocol identity, quoted from packages/shared/src/zcode-protocol/index.ts. */
export const ZCODE_PROTOCOL_NAME = 'ZCode Protocol'
export const ZCODE_PROTOCOL_VERSION = 1

export const ZCODE_HARNESS = 'zcode'
export const HUAWEI_MAAS_BASE_URL = 'https://api.modelarts-maas.com/openai/v1'
/**
 * Non-secret stand-in written into the provider config.
 *
 * The runtime authenticates with this static value, and the relay replaces it with the
 * real credential in memory. It is not a credential, grants nothing on its own, and is
 * not the Huawei key under any encoding.
 */
export const HUAWEI_RELAY_PLACEHOLDER_KEY = 'opl-relay-placeholder'
/** The relay binds loopback only; it is never reachable from another host. */
export const HUAWEI_RELAY_HOST = '127.0.0.1'
/** Header carrying the per-session relay ticket. Not a credential. */
export const HUAWEI_RELAY_TICKET_HEADER = 'x-opl-relay-ticket'
/**
 * The only upstream paths the relay will forward. Anything else is refused, so the
 * relay cannot be used to reach an arbitrary target.
 */
export const HUAWEI_RELAY_ALLOWED_PATHS = ['/openai/v1/chat/completions'] as const
/** Full upstream origin the relay is pinned to. */
export const HUAWEI_RELAY_UPSTREAM_ORIGIN = 'https://api.modelarts-maas.com'
/** Upper bound on a buffered request body, so the relay cannot be used to exhaust memory. */
export const HUAWEI_RELAY_MAX_BODY_BYTES = 32 * 1024 * 1024
export const HUAWEI_MAAS_PROVIDER_ID = 'huawei-maas'
export const HUAWEI_MAAS_MODEL = 'glm-5.2'
/**
 * Reference to the stored Huawei credential.
 *
 * This is the Windows Credential Manager target owned by the credentials host
 * (`HUAWEI_MAAS_KEYRING_TARGET`), re-exported here only so a settings surface can
 * record a reference without holding a value. There is deliberately no second name
 * for this credential and no `credentials.yml` / `.env` fallback: the OPL Gateway
 * account service cannot satisfy a Huawei key, or the reverse.
 */
export { HUAWEI_MAAS_KEYRING_TARGET as HUAWEI_MAAS_API_KEY_REF } from '../../../credentials/contracts/windows-keyring.ts'

/**
 * Official launch vector. `apps/zcode-cli/packages/cli/src/arguments.ts` routes on
 * `positionals[0]` only, so `app-server` is the subcommand; `--stdio` is a registered
 * boolean flag that the router never reads and is therefore not sent.
 */
export const ZCODE_APP_SERVER_ARGS: readonly string[] = ['app-server']

/** `zcodeProtocolMethods` members this bridge actually drives. */
export const ZCODE_METHODS = {
  runtimeCapabilities: 'runtime/capabilities',
  sessionCreate: 'session/create',
  sessionResume: 'session/resume',
  sessionSubscribe: 'session/subscribe',
  sessionSend: 'session/send',
  sessionStop: 'session/stop',
  sessionRequestRuntimePreferences: 'session/requestRuntimePreferences',
} as const

/**
 * `session/requestRuntimePreferences` scopes (`zcodeSessionRuntimePreferencesScopeSchema`).
 */
export const ZCODE_RUNTIME_PREFERENCE_SCOPES = [
  'runtime-materialization',
  'user-execution',
] as const

/**
 * Runtime preferences this bridge reports.
 *
 * The official host default is `askUserQuestionAutoResolutionEnabled: true`, which lets
 * the CLI answer its own questions without a human. OPL must never do that: an approval
 * is answered by the user through DSH. So auto-resolution is explicitly disabled here.
 */
export const ZCODE_RUNTIME_PREFERENCES = {
  // Auto-resolution must be off: an approval is answered by the user through DSH, never
  // by the CLI answering its own question.
  askUserQuestionAutoResolutionEnabled: false,
  nativeSearchEnhancementsEnabled: true,
  memoryEnabled: false,
  modelContextBudgetStrategy: 'preflight-v1',
} as const

/** Agent-initiated requests the bridge must answer as a ZCode Protocol client. */
export const ZCODE_CLIENT_REQUESTS = {
  requestPermission: 'interaction/requestPermission',
  requestUserInput: 'interaction/requestUserInput',
} as const

/** Notification the agent uses for live session events (services reads `session/event`). */
export const ZCODE_EVENT_NOTIFICATION = 'session/event'

/**
 * Environment variable the official CLI reads to locate a provider config file
 * (`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV` in packages/provider-node/src/runtime-paths.ts).
 * It selects the provider file for this process only and never rewrites the provider
 * file a user configured for their own official ZCode account.
 */
export const ZCODE_PROVIDER_CONFIG_FILE_ENV = 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE'

/** ZCode permission decisions, from `zcodePermissionResponseSchema`. */
export type ZcodePermissionDecision = 'allow' | 'deny' | 'escalate' | 'modify'
export interface ZcodePermissionResponse {
  decision: ZcodePermissionDecision
  reason?: string
  modifiedInput?: unknown
}
export interface ZcodePermissionOption {
  optionId: string
  kind: string
  name: string
  description?: string
  response: ZcodePermissionResponse
}
export interface ZcodePermissionRequest {
  requestId: string
  sessionId: string
  turnId?: string
  toolCallId: string
  toolName: string
  reason: string
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  input: unknown
  options: ZcodePermissionOption[]
}

export type ZcodeToolStatus = 'pending' | 'running' | 'completed' | 'error'
export interface ZcodeToolPart {
  type: 'tool'
  partId: string
  sessionId: string
  messageId: string
  callId: string
  tool: string
  state: { status: ZcodeToolStatus } & Record<string, unknown>
}
export interface ZcodeTextPart {
  type: 'text' | 'reasoning'
  partId: string
  sessionId: string
  messageId: string
  text: string
}
export type ZcodePart = ZcodeToolPart | ZcodeTextPart | { type: string; partId: string }

/** `zcodeEventEnvelopeSchema` plus the `payload` added by the session event union. */
export interface ZcodeEvent {
  eventId: string
  sessionId: string
  turnId?: string
  seq: number
  timestamp: number
  type: string
  payload?: Record<string, unknown>
}

export interface AcpUpdate {
  sessionUpdate: string
  [key: string]: unknown
}

const streamableFields = new Set(['text', 'reasoning'])

/**
 * Turn one ZCode session event into zero or more ACP `session/update` payloads.
 *
 * Released app-servers stream text and reasoning through `model.streaming` and
 * tools through `tool.updated`. Message-part events are also supported; full parts
 * are projected only when their text has not already streamed.
 *
 * @param event - a validated `session/event` notification params.
 * @param streamed - part ids that already produced a delta; mutated in place.
 */
export function acpUpdatesForEvent(event: ZcodeEvent, streamed: Set<string>): AcpUpdate[] {
  const payload = event.payload ?? {}
  // The released app-server emits model.streaming and tool.updated; part events
  // are also accepted for clients that receive the message-part projection.
  if (event.type === 'model.streaming') {
    if (payload.kind !== 'text_delta' && payload.kind !== 'reasoning_delta') return []
    if (typeof payload.delta !== 'string' || !payload.delta) return []
    if (typeof payload.partId === 'string') streamed.add(payload.partId)
    return [
      {
        sessionUpdate:
          payload.kind === 'reasoning_delta' ? 'agent_thought_chunk' : 'agent_message_chunk',
        content: { type: 'text', text: payload.delta },
      },
    ]
  }
  if (event.type === 'tool.updated') {
    if (typeof payload.toolCallId !== 'string') return []
    const common = {
      toolCallId: payload.toolCallId,
      ...(typeof payload.toolName === 'string' ? { title: payload.toolName } : {}),
      kind: payload.toolName === 'Bash' ? 'execute' : 'other',
    }
    switch (payload.kind) {
      case 'scheduled':
      case 'started':
        return [
          {
            ...common,
            sessionUpdate: 'tool_call',
            status: 'in_progress',
            ...(payload.input === undefined ? {} : { rawInput: payload.input }),
          },
        ]
      case 'result':
        return [
          {
            ...common,
            sessionUpdate: 'tool_call_update',
            status: 'completed',
            rawOutput: payload.result,
          },
        ]
      case 'error':
        return [
          {
            ...common,
            sessionUpdate: 'tool_call_update',
            status: 'failed',
            rawOutput: payload.error,
          },
        ]
      default:
        return []
    }
  }
  if (event.type === 'session.titleUpdated' && typeof payload.title === 'string')
    return [{ sessionUpdate: 'session_info_update', title: payload.title }]
  if (event.type === 'part.delta') {
    const field = typeof payload.field === 'string' ? payload.field : 'text'
    const delta = typeof payload.delta === 'string' ? payload.delta : ''
    const partId = typeof payload.partId === 'string' ? payload.partId : ''
    // `input`/`output` deltas are tool IO, not agent prose, and have no ACP projection.
    if (!streamableFields.has(field) || !delta || !partId) return []
    streamed.add(partId)
    return field === 'reasoning'
      ? [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: delta } }]
      : [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } }]
  }
  if (event.type === 'part.upserted' || event.type === 'part.started') {
    const part = payload.part as ZcodePart | undefined
    if (!part || typeof part !== 'object') return []
    if (part.type === 'text' || part.type === 'reasoning') {
      if (streamed.has(part.partId)) return []
      const text = (part as ZcodeTextPart).text
      if (!text) return []
      streamed.add(part.partId)
      return part.type === 'reasoning'
        ? [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }]
        : [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }]
    }
    if (part.type === 'tool') {
      const tool = part as ZcodeToolPart
      const status = tool.state?.status
      if (status === 'pending' || status === 'running')
        return [
          {
            sessionUpdate: 'tool_call',
            toolCallId: tool.callId,
            title: tool.tool,
            kind: 'other',
            status: 'in_progress',
          },
        ]
      if (status === 'completed' || status === 'error')
        return [
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: tool.callId,
            kind: 'other',
            status: status === 'error' ? 'failed' : 'completed',
          },
        ]
      return []
    }
    return []
  }
  return []
}

/**
 * Project the ZCode permission options onto ACP permission options.
 *
 * ACP only models allow/reject per-invocation. `escalate` and `modify` have no ACP
 * equivalent, so they are dropped rather than silently reported as a plain rejection.
 * A request that keeps no allow option is still offered, because a deny-only list is
 * the honest fail-closed projection.
 */
export function acpPermissionOptions(
  options: readonly ZcodePermissionOption[],
): { optionId: string; name: string; kind: 'allow_once' | 'reject_once' }[] {
  const mapped: { optionId: string; name: string; kind: 'allow_once' | 'reject_once' }[] = []
  for (const option of options) {
    if (option.response?.decision === 'allow')
      mapped.push({ optionId: option.optionId, name: option.name, kind: 'allow_once' })
    else if (option.response?.decision === 'deny')
      mapped.push({ optionId: option.optionId, name: option.name, kind: 'reject_once' })
  }
  return mapped
}

/**
 * Resolve the host's answer back to the ZCode response to send.
 *
 * An unknown, absent or non-allow answer falls back to a deny option so a session that
 * was never authorized cannot proceed on an unmatched identifier.
 */
export function resolvePermissionResponse(
  options: readonly ZcodePermissionOption[],
  chosenOptionId: string | undefined,
): ZcodePermissionResponse {
  const chosen = options.find((option) => option.optionId === chosenOptionId)
  if (chosen) return chosen.response
  const denied = options.find((option) => option.response?.decision === 'deny')
  if (denied) return denied.response
  return { decision: 'deny', reason: '未选择有效的授权选项' }
}

/**
 * Model capabilities for the Huawei route.
 *
 * Huawei's model list documents 1M context and text/function calls for glm-5.2.
 * Unsupported input modalities and native search are not advertised.
 */
export const HUAWEI_MODEL_PROPERTIES = {
  requiresMfjsToolSchema: false,
  contextWindow: 1000000,
  inputFormat: {
    supportsText: true,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
  },
  outputFormat: { supportsText: true },
  supportsToolCall: true,
  supportsJsonSchemaOutput: false,
  supportsNativeWebSearch: false,
  supportsMidConversationSystem: false,
} as const

export const HUAWEI_REASONING_LEVELS = ['disabled', 'enabled'] as const

/** Huawei documents thinking enabled by default; no user-facing effort tiers are invented. */
export const HUAWEI_DEFAULT_REASONING_LEVEL = 'enabled'

/**
 * Personal provider config.
 *
 * Shape is the official personal layer, not a builtin release:
 * `providerConfigRules.providerRules` is an **array** (a map fails to parse and the whole
 * layer falls back), `modelConfigRules` requires **both** `providerModelRules` and
 * `manualProviderModelRules`, `builtinModelIds` is omitted because the personal schema
 * strips it, and there is **no `revision`** key because the personal schema rejects it.
 *
 * `enabled: true` matters: the resolver compares `modelConfig.enabled === true` strictly,
 * so an omitted flag leaves the model non-executable and the provider unpublished.
 */
export function buildPersonalProviderConfig(input: {
  providerId: string
  providerName: string
  baseUrl: string
  modelId: string
  reasoningLevel?: string
  headers?: Record<string, string>
}): unknown {
  return {
    schemaVersion: 1,
    config: {
      providerOrder: [input.providerId],
      providerConfigRules: {
        providerRules: [
          {
            providerId: input.providerId,
            providerName: input.providerName,
            enabled: true,
            config: {
              group: 'standard-personal',
              access: {
                type: 'api-key',
                // A fixed non-secret placeholder. The runtime sends this literal as the
                // Bearer token on every request, which is exactly why the relay must
                // replace it in memory rather than trust it.
                apiKey: HUAWEI_RELAY_PLACEHOLDER_KEY,
                apiKeyManagementUrl: null,
              },
              api: {
                type: 'openai-chat-completions',
                baseUrl: input.baseUrl,
                ...(input.headers ? { headers: input.headers } : {}),
              },
              personalModelIds: [input.modelId],
              visibility: 'visible',
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          {
            providerId: input.providerId,
            modelId: input.modelId,
            config: {
              enabled: true,
              properties: HUAWEI_MODEL_PROPERTIES,
              optionSpecs: {
                reasoningLevel: {
                  values: [...HUAWEI_REASONING_LEVELS],
                  map: "{'chat_template_kwargs': {'thinking': reasoningLevel == 'enabled'}}",
                },
                maxOutputTokens: { max: 128000, map: "{'max_completion_tokens': maxOutputTokens}" },
              },
            },
          },
        ],
        manualProviderModelRules: [],
      },
      defaultModelSelection: {
        providerId: input.providerId,
        modelId: input.modelId,
        options: { reasoningLevel: input.reasoningLevel ?? HUAWEI_DEFAULT_REASONING_LEVEL },
      },
    },
  }
}

/**
 * Builtin provider config.
 *
 * The builtin layer forbids the personal vocabulary (`standard-personal`,
 * `personalModelIds`, `modelOrder`) and requires `revision`, so it carries only the
 * official built-in surface and contributes nothing to this route. It is written only
 * because the CLI expects the builtin and personal variables as a pair; leaving the
 * builtin unset is not a supported combination.
 */
export function buildBuiltinProviderConfig(input: { revision?: number } = {}): unknown {
  return {
    schemaVersion: 1,
    revision: input.revision ?? 1,
    config: {
      providerConfigRules: { templateRules: [], providerRules: [] },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  }
}

/**
 * Confirm the session really is running the requested model.
 *
 * A combination that silently landed on another model is never acceptable, so this
 * throws rather than returning a degraded session. `snapshot.settings.model.current` is
 * the official current-selection projection on the create/resume snapshot.
 */
export function assertProtocolIdentity(snapshot: unknown): void {
  const protocol = (snapshot as any)?.protocol
  if (!protocol || typeof protocol !== 'object')
    throw Error('ZCode 会话快照缺少 protocol，无法核对协议身份')
  if (protocol.name !== ZCODE_PROTOCOL_NAME || protocol.version !== ZCODE_PROTOCOL_VERSION)
    throw Error(
      `ZCode 协议身份为 ${String(protocol.name)}/${String(protocol.version)}，` +
        `与预期 ${ZCODE_PROTOCOL_NAME}/${ZCODE_PROTOCOL_VERSION} 不一致`,
    )
}

export function assertModelSelection(snapshot: unknown, providerId: string, modelId: string): void {
  const current = (snapshot as any)?.settings?.model?.current
  if (!current || typeof current !== 'object') throw Error('ZCode 未返回当前模型，无法确认路由')
  if (current.providerId !== providerId || current.modelId !== modelId)
    throw Error(
      `ZCode 会话绑定的是 ${String(current.providerId)}/${String(current.modelId)}，` +
        `与所选的 ${providerId}/${modelId} 不一致`,
    )
}

/**
 * Confirm the session really carries the permission mode the task authorized.
 *
 * The authoritative fields are `settings.permission.mode` and `settings.mode.current`
 * (`zcodeSessionSettingsStateSchema`); `session.mode` is a session-info field and is NOT
 * consulted. `settings.permission` is optional, so a snapshot that reports neither is
 * treated as a drift and fails closed rather than being assumed acceptable.
 */
export function assertSessionMode(snapshot: unknown, expected: string): void {
  const settings = (snapshot as any)?.settings
  const mode = settings?.permission?.mode ?? settings?.mode?.current
  if (mode !== expected)
    throw Error(`ZCode 会话权限模式是 ${String(mode)}，与授权的 ${expected} 不一致`)
}

/**
 * The `model` selection accepted by `session/create` and `session/send`.
 */
export function modelSelection(providerId: string, modelId: string, reasoningLevel?: string) {
  // The official runtime rejects a selection for a model that declares reasoning levels
  // when `options.reasoningLevel` is missing ("Reasoning level is required for ..."), and
  // `modelSelectionSchema` is strict, so the level is always sent explicitly.
  return {
    providerId,
    modelId,
    options: { reasoningLevel: reasoningLevel ?? HUAWEI_DEFAULT_REASONING_LEVEL },
  }
}

/**
 * Full-access session mode.
 *
 * `zcodeSessionModeSchema` offers plan/build/edit/yolo/auto, but `auto` is reserved and
 * fails closed in `permission/service.ts` ("Auto mode is reserved but not implemented
 * yet"), so it is never a valid target. `yolo` is the mode the official
 * `grantPermissionFullAccess` receipt sets for a full-access task.
 */
export const ZCODE_FULL_ACCESS_MODE = 'yolo'
/** Read-only mode; plan also auto-passes read-only tools. */
export const ZCODE_READ_ONLY_MODE = 'plan'
export const ZCODE_SESSION_MODES = ['plan', 'build', 'edit', 'yolo', 'auto'] as const

/**
 * NOT USED — `session/send` also accepts `modelExecution.requestAuth.apiKey`, but it is
 * inert for a plain API-key provider.
 *
 * `apps/zcode-cli/packages/adapters/src/model/runner.ts` only installs
 * `refreshRuntimeHeadersBeforeAttempt` when the provider is `zhipu-account` (requiring it
 * for `off-peak`); its own comment says a plain API-key model must not consume that port.
 * When the hook is absent, `resolveRequest` is invoked without `requestAuth`, so the
 * static key from the provider config is what actually authenticates the request. A
 * schema-level field is not evidence that the request uses it, and the credential is
 * delivered by the loopback relay instead.
 */
export const ZCODE_REQUEST_AUTH_IS_INERT_FOR_API_KEY = true

/**
 * Remove the credential from anything that may be surfaced.
 *
 * Applied to every diagnostic line and error message so the key cannot reach stderr,
 * a log file or a stored session.
 */
export function redactSecret(text: string, secret: string | undefined): string {
  return secret ? text.replaceAll(secret, '[REDACTED]') : text
}

// ── Loopback credential relay ──────────────────────────────────────────────────────────

/** What the bridge needs from the relay once it is listening. */
export interface HuaweiRelay {
  /** Base URL the official CLI should call. */
  readonly baseUrl: string
  /** Non-secret, per-session. Guards the relay against open forwarding. */
  readonly ticket: string
  close(): void
}

/**
 * A loopback-only HTTP transport that swaps the placeholder credential for the real one.
 *
 * It is deliberately not a proxy: it binds `127.0.0.1` only, accepts exactly one
 * upstream origin and one allow-listed path, and requires the per-session ticket. It
 * holds no model logic and cannot be pointed at another target. The credential is
 * obtained through `getApiKey`, so it stays in the caller's memory and is never written
 * to a file, an argument vector or a log.
 *
 * @param getApiKey - resolves the real credential on demand; may return undefined.
 */
export async function startHuaweiRelay(
  getApiKey: () => Promise<string | undefined>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<HuaweiRelay> {
  const { randomBytes, timingSafeEqual } = await import('node:crypto')
  const { createServer } = await import('node:http')
  const { request: httpsRequest, Agent } = await import('node:https')
  const proxyEnv = {
    HTTPS_PROXY: environment.HTTPS_PROXY,
    https_proxy: environment.https_proxy,
    HTTP_PROXY: environment.HTTP_PROXY,
    http_proxy: environment.http_proxy,
    NO_PROXY: environment.NO_PROXY,
    no_proxy: environment.no_proxy,
  }
  const [major, minor] = process.versions.node.split('.').map(Number)
  const supportsProxy = major > 24 || (major === 24 && minor >= 5)
  if (!supportsProxy && (proxyEnv.https_proxy || proxyEnv.HTTPS_PROXY))
    throw Error('ZCode 的独立代理需要 Node.js 24.5 或以上版本，未发起直连请求')
  const agent = new Agent({ ...(supportsProxy ? { proxyEnv } : {}), keepAlive: true })
  const sockets = new Set<Socket>()
  const ticket = randomBytes(24).toString('hex')
  const server = createServer((req, res) => {
    // Refusals never reveal whether a credential exists.
    const refuse = (status: number) => res.writeHead(status).end()
    // The body is consumed before any decision. Responding while a request body is
    // still arriving tears the socket down under the client, which shows up as an
    // intermittent hang rather than as the status the caller needs.
    const body = new Promise<Buffer | 'too-large' | 'aborted'>((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        // Bounded so a hostile or broken caller cannot make the relay buffer forever.
        if (size > HUAWEI_RELAY_MAX_BODY_BYTES) {
          resolve('too-large')
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('aborted', () => resolve('aborted'))
      req.on('error', () => resolve('aborted'))
    })
    void (async () => {
      // Only the completion POST is proxied. Any other verb is refused outright.
      if (req.method !== 'POST') return refuse(405)
      const payload = await body
      if (payload === 'aborted') return
      if (payload === 'too-large') return refuse(413)
      const presented = req.headers[HUAWEI_RELAY_TICKET_HEADER]
      const value = Array.isArray(presented) ? presented[0] : presented
      const a = Buffer.from(value ?? '')
      const b = Buffer.from(ticket)
      if (a.length !== b.length || !timingSafeEqual(a, b)) return refuse(403)
      const path = (req.url ?? '').split('?')[0]
      if (!(HUAWEI_RELAY_ALLOWED_PATHS as readonly string[]).includes(path)) return refuse(404)
      const apiKey = await getApiKey()
      if (!apiKey) return refuse(503)
      const upstream = httpsRequest(
        HUAWEI_RELAY_UPSTREAM_ORIGIN + path,
        {
          method: req.method,
          agent,
          headers: {
            // The placeholder never leaves this process; the real key goes on the wire.
            authorization: `Bearer ${apiKey}`,
            'content-type': String(req.headers['content-type'] ?? 'application/json'),
            'content-length': String(payload.length),
            accept: String(req.headers.accept ?? 'text/event-stream'),
          },
        },
        (upstreamRes) => {
          // Provider error bodies can echo request headers. Preserve the status without
          // exposing that body to the CLI, its logs or the conversation.
          if ((upstreamRes.statusCode ?? 502) >= 400) {
            upstreamRes.resume()
            res.writeHead(upstreamRes.statusCode ?? 502, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Huawei MaaS request failed' } }))
            return
          }
          res.writeHead(upstreamRes.statusCode ?? 502, {
            'content-type': String(upstreamRes.headers['content-type'] ?? 'application/json'),
            'cache-control': 'no-cache',
          })
          // Streamed through untouched so server-sent events keep arriving incrementally.
          upstreamRes.pipe(res)
        },
      )
      // A cancelled or torn-down turn must not leave an upstream request running.
      req.on('aborted', () => upstream.destroy())
      res.on('close', () => upstream.destroy())
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502).end()
        else res.end()
      })
      upstream.setTimeout(180000, () => upstream.destroy())
      upstream.end(payload)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, HUAWEI_RELAY_HOST, () => {
      server.removeListener('error', reject)
      resolve()
    })
  }).catch((error) => {
    agent.destroy()
    throw error
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  if (!port) {
    server.close()
    throw Error('未能启动本地鉴权转发')
  }
  // Tracked so closing the relay also tears down anything still in flight, rather than
  // leaving sockets open behind a server that will no longer accept them.
  return {
    baseUrl: `http://${HUAWEI_RELAY_HOST}:${port}/openai/v1`,
    ticket,
    close: () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.close()
      agent.destroy()
    },
  }
}
