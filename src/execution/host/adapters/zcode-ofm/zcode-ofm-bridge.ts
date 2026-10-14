/** ACP transport over the official ZCode CLI, carrying the Our Free Model route.
 *
 * This file owns no agent loop, model request, tool execution or session format. It
 * launches the same official CLI in the same `app-server` mode the Huawei route uses
 * and translates the official ZCode Protocol (newline delimited JSON-RPC over stdio)
 * onto the ACP surface the Host already drives. Every piece of official protocol
 * knowledge — the method names, the event projection, the permission mapping and the
 * session identity assertions — is imported from `../zcode-protocol.ts` rather than
 * restated, so this route cannot drift away from the protocol it claims to speak.
 *
 * What is route-specific and lives here:
 *
 * - the credential is read through the owner's resolved route, not through the
 *   official credential service, so the Huawei key is never in scope;
 * - the relay is pinned to the owner's published loopback endpoint;
 * - the model and reasoning level asserted after create/resume are this route's.
 *
 * Credential handling: the OFM key is resolved on demand from the Host over private
 * stdio and held only in memory. It is not passed through the adapter's environment,
 * argv, a file, a log or the ZCode protocol. The provider config the official CLI
 * reads contains a fixed non-secret placeholder, and the loopback relay swaps in the
 * real value on the wire.
 *
 * @module zcode-ofm/zcode-ofm-bridge
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve as resolvePath } from 'node:path'
import { commandLaunch } from '../../harness-registry.ts'
import { EXTERNAL_TOOL_NAME_META } from '../../external-binding.ts'
import {
  ZCODE_CLIENT_REQUESTS,
  ZCODE_EVENT_NOTIFICATION,
  ZCODE_FULL_ACCESS_MODE,
  ZCODE_HARNESS,
  ZCODE_METHODS,
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  ZCODE_RUNTIME_PREFERENCES,
  ZCODE_SESSION_MODES,
  acpPermissionOptions,
  acpUpdatesForEvent,
  assertProtocolIdentity,
  assertSessionMode,
  redactSecret,
  resolvePermissionResponse,
  type ZcodeEvent,
  type ZcodePermissionRequest,
} from '../zcode-protocol.ts'
import {
  OFM_RELAY_TICKET_HEADER,
  OFM_ZCODE_PROVIDER_ID,
  buildOfmPersonalProviderConfig,
  ofmModelSelection,
  assertOfmModelIdentity,
  assertOfmModelSelection,
  ofmReportsReasoningLevel,
  ofmShellSelection,
  ZCODE_OFM_REASONING_LEVELS,
  type ZcodeOfmReasoningLevel,
} from './zcode-ofm-models.ts'
import { startOfmRelay, type OfmRelay } from './zcode-ofm-relay.ts'

const command = process.env.OPL_ZCODE_OFM_COMMAND!
/** Arguments placed before the protocol subcommand, e.g. the `zcode.cjs` bundle path. */
const prefix: string[] = JSON.parse(process.env.OPL_ZCODE_OFM_PREFIX ?? '[]')
const model = process.env.OPL_ZCODE_OFM_MODEL!
const providerConfigFile = process.env.OPL_ZCODE_OFM_PROVIDER_CONFIG_FILE!
const personalProviderConfigFile = process.env.OPL_ZCODE_OFM_PERSONAL_PROVIDER_CONFIG_FILE!
/**
 * The Git Bash executable the adapter already resolved and verified.
 *
 * This route does not export `SHELL` and hope: the official runtime picks its own shell
 * and quietly degrades to the system shell when Git Bash is absent. The verified path is
 * handed to the official `integratedTerminalShell` selection at session creation.
 */
const gitBash = process.env.OPL_ZCODE_OFM_GIT_BASH!
/** The owner's published loopback endpoint for this launch; the relay is pinned to it. */
const upstream = process.env.OPL_ZCODE_OFM_UPSTREAM!
/**
 * The permission mode the task authorized. `yolo` is the official full-access mode;
 * `auto` is reserved upstream and fails closed, so it is never accepted here.
 */
const mode = process.env.OPL_ZCODE_OFM_MODE ?? ZCODE_FULL_ACCESS_MODE
if (!ZCODE_SESSION_MODES.includes(mode as (typeof ZCODE_SESSION_MODES)[number]))
  throw Error('ZCode 会话模式不在官方值域内')
if (mode === 'auto') throw Error('ZCode 的 auto 模式官方保留且直接拒绝，不能用于本组合')
const reasoningLevel = process.env.OPL_ZCODE_OFM_REASONING_LEVEL!
if (!(ZCODE_OFM_REASONING_LEVELS as readonly string[]).includes(reasoningLevel))
  throw Error('Our Free Model 组合的推理档位不在官方声明的取值内')
const reasoning = reasoningLevel as ZcodeOfmReasoningLevel
const cwd = process.cwd()

/** OPL-owned bridge-only requests. No caller-selected credential ref is accepted. */
const OFM_CREDENTIAL_REQUESTS = {
  describe: 'opl/ofm-credential/describe',
  resolve: 'opl/ofm-credential/resolve',
} as const

const send = (value: object) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const emit = (update: object) => send({ method: 'session/update', params: { sessionId, update } })

let sessionId = '',
  cancelled = false,
  seq = 0
const streamed = new Set<string>()
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const asks = new Map<string, (optionId: string | undefined) => void>()
const hostPending = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>()
let resolveTurn: ((value: unknown) => void) | undefined,
  rejectTurn: ((e: Error) => void) | undefined

/** Release the child process, the relay and every in-flight request together. */
let relay: OfmRelay | undefined
let apiKey: string | undefined
function releaseEverything(reason = 'ZCode 会话已结束') {
  failPending(reason)
  const previous = child
  child = undefined
  previous?.kill('SIGTERM')
  relay?.close()
  relay = undefined
  apiKey = undefined
}

/** Reject everything still in flight so no caller waits on a process that is gone. */
function failPending(reason: string) {
  for (const entry of pending.values()) entry.reject(Error(reason))
  pending.clear()
  for (const entry of hostPending.values()) {
    clearTimeout(entry.timer)
    entry.reject(Error(reason))
  }
  hostPending.clear()
  for (const answer of asks.values()) answer(undefined)
  asks.clear()
  rejectTurn?.(Error(reason))
  resolveTurn = undefined
  rejectTurn = undefined
}

/** Only the OPL Host sees these requests; no ref or secret goes to the official CLI. */
function hostCredentialRequest(method: string): Promise<unknown> {
  const id = 'credential-' + ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hostPending.delete(id)
      reject(Error('Host 凭据读取超时'))
    }, 30000)
    hostPending.set(id, { resolve, reject, timer })
    send({ id, method, params: {} })
  })
}

/**
 * Resolve the credential on demand.
 *
 * Nothing reads the key eagerly or stores it: the value exists only in this variable
 * and in the closure handed to the relay. It is never written to a file, placed in an
 * argument vector, or logged.
 */
async function readKey(): Promise<string | undefined> {
  const value = await hostCredentialRequest(OFM_CREDENTIAL_REQUESTS.resolve)
  apiKey = typeof value === 'string' && value.length ? value : undefined
  return apiKey
}

/** Ask the host to authorize one ZCode `interaction/requestPermission`. */
function permission(request: ZcodePermissionRequest): Promise<string | undefined> {
  const id = 'permission-' + ++seq
  const options = acpPermissionOptions(request.options)
  return new Promise((resolve) => {
    asks.set(id, resolve)
    send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: {
          // The official request's tool name and structured input are passed through
          // verbatim, in the ACP extension slot and `rawInput`. The host never decodes
          // the display title into an authorization decision, and `toolCallId` keeps one
          // ask addressable while it is pending.
          toolCallId: id,
          title:
            'ZCode · ' +
            request.toolName +
            '\n' +
            request.reason +
            '\n' +
            JSON.stringify(request.input ?? {}).slice(0, 2000),
          kind: 'other',
          rawInput: request.input ?? {},
          _meta: { [EXTERNAL_TOOL_NAME_META]: request.toolName },
        },
        options:
          options.length > 0
            ? options
            : [
                { optionId: 'deny', name: '拒绝', kind: 'reject_once' as const },
                { optionId: 'allow', name: '允许本次', kind: 'allow_once' as const },
              ],
      },
    })
  })
}

let child: ChildProcessWithoutNullStreams | undefined
const REQUEST_TIMEOUT_MS = Number(process.env.OPL_ZCODE_OFM_REQUEST_TIMEOUT_MS ?? 180000)

function zcodeRequest(
  method: string,
  params: object,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id))
        reject(Error(`ZCode 请求超时（${method}），未在 ${timeoutMs}ms 内返回`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    child!.stdin!.write(JSON.stringify({ id, method, params }) + '\n')
  })
}

/**
 * Launch the official CLI in app-server mode.
 *
 * The real runtime is `node <zcode.cjs> app-server --stdio`, so the command and the
 * prefix that carries the bundle path are composed explicitly instead of assuming the
 * CLI is installed on PATH. `commandLaunch` is the repository's already-verified
 * launcher: it quotes each argument individually before handing it to cmd.exe, which a
 * plain `args.join(' ')` does not and which breaks on any argument containing a space.
 */
async function openAgent() {
  const resolved = commandLaunch(command, [...prefix, 'app-server', '--stdio'])
  const launched = spawn(resolved.command, resolved.args, {
    cwd,
    env: zcodeEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // Required whenever cmd.exe is involved; without it Node re-escapes the inner
    // quotes and cmd cannot resolve the script path.
    ...(resolved.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  })
  child = launched as ChildProcessWithoutNullStreams
  // The official CLI reserves stdout for protocol frames and sends its own logs to
  // stderr; discarding stderr keeps a diagnostics-only stream off the wire.
  child.stderr!.resume()
  child.on('error', () => {
    if (child === launched) releaseEverything('ZCode 进程启动失败')
  })
  child.on('exit', () => {
    if (child === launched) releaseEverything('ZCode 进程退出')
  })
  createInterface({ input: child.stdout! }).on('line', (line) => {
    void (async () => {
      let m: any
      try {
        m = JSON.parse(line)
      } catch {
        // Output that is not a protocol frame means the transport is wrong. It is
        // surfaced rather than dropped, so a broken stream cannot look like silence.
        if (process.env.OPL_ZCODE_OFM_DIAGNOSTICS === '1')
          process.stderr.write(
            JSON.stringify({ method: 'protocol', error: 'non-JSON stdout' }) + '\n',
          )
        releaseEverything('ZCode 输出了非协议内容，连接已中断')
        return
      }
      if (m.id !== undefined && !m.method) {
        const entry = pending.get(m.id)
        if (!entry) return
        pending.delete(m.id)
        if (m.error) entry.reject(Error(`ZCode 请求失败（${m.error.code ?? 'unknown'}）`))
        else entry.resolve(m.result)
        return
      }
      if (m.id !== undefined && m.method) {
        await answerAgentRequest(m)
        return
      }
      if (m.method !== ZCODE_EVENT_NOTIFICATION) return
      handleEvent(m.params as ZcodeEvent)
    })().catch(() => releaseEverything('ZCode 协议处理失败'))
  })
}

/**
 * Environment for the official CLI.
 *
 * The two provider config variables are always set together: the official runtime
 * refuses a half-configured pair (`resolveNodeProviderRuntimePaths` throws when only
 * one is present), so leaving one unset is not a supported combination.
 */
function zcodeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: providerConfigFile,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalProviderConfigFile,
  }
}

/**
 * Write the provider config now that the relay port is known.
 *
 * Only non-secret fields are persisted: a fixed placeholder key, and the loopback base
 * URL the official CLI will call. The Our Free Model credential stays in memory.
 */
function writeProviderConfig(relayBaseUrl: string, ticket: string) {
  const headers = { [OFM_RELAY_TICKET_HEADER]: ticket }
  mkdirSync(dirname(providerConfigFile), { recursive: true, mode: 0o700 })
  mkdirSync(dirname(personalProviderConfigFile), { recursive: true, mode: 0o700 })
  // The built-in layer is the official release shipped inside the installed CLI, not a
  // stub. Verified against the real CLI: with an empty built-in layer the runtime exits
  // immediately with `Bundled 与 Active ZCode Built-in Release 均不可用`, so a stub would
  // make every launch fail before any session exists. The file is referenced, never
  // written or modified.
  if (!existsSync(providerConfigFile))
    throw Error('找不到官方 ZCode 内置 Provider 配置，未启动 ZCode')
  writeFileSync(
    personalProviderConfigFile,
    JSON.stringify(
      buildOfmPersonalProviderConfig({
        baseUrl: relayBaseUrl,
        modelId: model,
        reasoningLevel: reasoning,
        headers,
      }),
      null,
      2,
    ),
    { mode: 0o600 },
  )
}

/**
 * Confirm the reasoning level only when the runtime actually reports one.
 *
 * The CLI of record echoes provider, model and permission mode, but it does not echo
 * `options.reasoningLevel` for a personal API-key provider. When a snapshot does carry
 * a level it must be the pinned one, and a mismatch is a refusal. When it carries none,
 * this route makes no claim: it does not fabricate an option, does not substitute the
 * requested value, and does not treat the declaration in the provider config as proof.
 * The route's advertised capability stays `'model-declared'` for exactly this reason.
 */
function assertReasoningConfirmed(snapshot: unknown) {
  if (!ofmReportsReasoningLevel(snapshot)) return
  assertOfmModelSelection(snapshot, model, reasoning)
}

function handleEvent(event: ZcodeEvent) {
  if (!event || event.sessionId !== sessionId) return
  if (event.type === 'turn.completed') {
    const resultType = event.payload?.resultType
    if (typeof resultType === 'string' && resultType.startsWith('error_')) {
      rejectTurn?.(Error('HARNESS_EXECUTION'))
      resolveTurn = undefined
      rejectTurn = undefined
      return
    }
    // ZCode reports a stopped turn as a completed one, so the cancellation this bridge
    // requested is what distinguishes the two stop reasons.
    resolveTurn?.({
      stopReason: cancelled || resultType === 'cancelled' ? 'cancelled' : 'end_turn',
    })
    resolveTurn = undefined
    rejectTurn = undefined
    return
  }
  if (event.type === 'turn.failed') {
    const detail = (event.payload?.error ?? {}) as { type?: string; message?: string }
    rejectTurn?.(Error(redactSecret(detail.message ?? detail.type ?? '未知错误', apiKey)))
    resolveTurn = undefined
    rejectTurn = undefined
    return
  }
  for (const update of acpUpdatesForEvent(event, streamed)) emit(update)
}

/** Answer a request the agent makes of this client. */
async function answerAgentRequest(m: any) {
  if (m.method === ZCODE_METHODS.sessionRequestRuntimePreferences) {
    // Answered explicitly rather than refused: the official client is asked for these
    // during session creation, and refusing it makes `session/create` fail. Auto
    // resolution stays off because an approval is answered by the user through DSH.
    // Verified against the real CLI: `nativeSearchEnhancementsEnabled` is required and
    // the result object is strict, so every declared field must be well typed.
    //
    // `integratedTerminalShell` pins Git Bash to the path the adapter already verified.
    // The engine otherwise applies its own detection and degrades to the system shell,
    // which would leave "Git Bash required" as an unenforced promise.
    child!.stdin!.write(
      JSON.stringify({
        id: m.id,
        result: {
          ...ZCODE_RUNTIME_PREFERENCES,
          ...(gitBash ? { integratedTerminalShell: ofmShellSelection(gitBash) } : {}),
        },
      }) + '\n',
    )
    return
  }
  if (m.method !== ZCODE_CLIENT_REQUESTS.requestPermission) {
    child!.stdin!.write(
      JSON.stringify({ id: m.id, error: { code: -32601, message: 'Unsupported client request' } }) +
        '\n',
    )
    return
  }
  const params = m.params as ZcodePermissionRequest
  const chosen = await permission(params)
  child!.stdin!.write(
    JSON.stringify({ id: m.id, result: resolvePermissionResponse(params.options ?? [], chosen) }) +
      '\n',
  )
}

async function invoke(method: string, p: any) {
  if (method === 'initialize') {
    // Presence is checked without loading the value. An unconfigured or withdrawn
    // endpoint is reported here, so the protocol surface stays usable and the failure
    // lands on the request that actually needs the credential, with the relay refusing
    // closed (503) instead of any silent downgrade.
    const credential = (await hostCredentialRequest(OFM_CREDENTIAL_REQUESTS.describe)) as {
      configured: boolean
    }
    // `runtime/capabilities` only reports `independentPlanState`; it carries no protocol
    // identity, so the identity is verified from the real session snapshot instead.
    if (child || relay) throw Error('ZCode 桥接器已经初始化')
    relay = await startOfmRelay(readKey, { baseURL: upstream })
    try {
      writeProviderConfig(relay.baseUrl, relay.ticket)
      await openAgent()
      await zcodeRequest(ZCODE_METHODS.runtimeCapabilities, {}, 30000)
    } catch (error) {
      // A failed start must not leave a child process, a listening socket or an
      // unresolved request behind.
      releaseEverything()
      throw error
    }
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: {
        name: ZCODE_HARNESS,
        version: `${ZCODE_PROTOCOL_NAME} ${ZCODE_PROTOCOL_VERSION}`,
        credentialConfigured: credential.configured,
        home: homedir(),
      },
    }
  }
  if (method === 'session/new' || method === 'session/load') {
    if (p.cwd !== cwd) throw Error('不能改变已绑定项目')
    const workspace = { workspacePath: cwd, workspaceKey: cwd }
    // Both lifecycle calls answer with the official session state snapshot; the session
    // id lives at `snapshot.session.sessionId`.
    const snapshot: any =
      method === 'session/load'
        ? await zcodeRequest(ZCODE_METHODS.sessionResume, {
            sessionId: p.sessionId,
            workspace,
          })
        : await zcodeRequest(ZCODE_METHODS.sessionCreate, {
            workspace,
            // The authorized permission mode, not a default.
            mode,
            model: ofmModelSelection(model, reasoning),
          })
    sessionId = snapshot?.session?.sessionId
    if (!sessionId) throw Error('ZCode 未返回会话标识')
    // Confirm the live session really is on the requested model and permission mode
    // before it is ever driven. Both are genuine runtime readbacks.
    assertProtocolIdentity(snapshot)
    assertOfmModelIdentity(snapshot, model)
    assertSessionMode(snapshot, mode)
    assertReasoningConfirmed(snapshot)
    await zcodeRequest(ZCODE_METHODS.sessionSubscribe, {
      sessionId,
      deliveryKind: 'desktop-continuous',
      includeSnapshot: false,
    })
    return { sessionId, models: { currentModelId: model } }
  }
  if (p.sessionId !== sessionId) throw Error('会话身份不匹配')
  if (method === 'session/cancel') {
    cancelled = true
    // A pending approval would otherwise keep the turn open forever.
    for (const answer of asks.values()) answer(undefined)
    asks.clear()
    // `session/stop` bypasses the official server's serial request queue, so a cancel
    // issued during a long turn is still delivered.
    await zcodeRequest(ZCODE_METHODS.sessionStop, { sessionId }, 30000)
    return {}
  }
  if (method === 'session/prompt') {
    const text = p.prompt
      .filter((v: any) => v.type === 'text')
      .map((v: any) => v.text)
      .join('\n')
    cancelled = false
    // Re-read the live session state before every send. `session/subscribe` accepts
    // `includeSnapshot`, and the subscribe result carries the same official session
    // snapshot, so the model and the permission mode are confirmed against server state
    // rather than against what this process believes it asked for.
    const probe: any = await zcodeRequest(ZCODE_METHODS.sessionSubscribe, {
      sessionId,
      deliveryKind: 'desktop-continuous',
      includeSnapshot: true,
    })
    const live = probe?.snapshot ?? probe
    assertSessionMode(live, mode)
    assertProtocolIdentity(live)
    assertOfmModelIdentity(live, model)
    assertReasoningConfirmed(live)
    const done = new Promise((resolve, reject) => {
      resolveTurn = resolve
      rejectTurn = reject
    })
    void done.catch(() => {})
    try {
      await zcodeRequest(ZCODE_METHODS.sessionSend, {
        sessionId,
        content: text,
        modelSelection: ofmModelSelection(model, reasoning),
      })
      return await done
    } finally {
      resolveTurn = undefined
      rejectTurn = undefined
    }
  }
  throw Error('不支持的调用')
}

createInterface({ input: process.stdin }).on('line', (line) => {
  void (async () => {
    let m: any
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (!m.method) {
      const credential = hostPending.get(m.id)
      if (credential) {
        clearTimeout(credential.timer)
        hostPending.delete(m.id)
        if (m.error) credential.reject(Error('Host 凭据读取失败'))
        else credential.resolve(m.result)
        return
      }
      const answer = asks.get(m.id)
      if (answer) {
        asks.delete(m.id)
        answer(m.result?.outcome?.optionId)
      }
      return
    }
    try {
      const result = await invoke(m.method, m.params ?? {})
      if (m.id !== undefined) send({ id: m.id, result })
    } catch (error) {
      const message = redactSecret(
        String(error instanceof Error ? error.message : 'failure'),
        apiKey,
      )
      if (process.env.OPL_ZCODE_OFM_DIAGNOSTICS === '1')
        process.stderr.write(JSON.stringify({ method: m.method, error: message }) + '\n')
      if (m.id !== undefined)
        send({
          id: m.id,
          error: {
            code:
              error instanceof Error &&
              /^HARNESS_(AUTH|RATE_LIMIT|MODEL|EXECUTION|TIMEOUT|NETWORK)$/.test(error.message)
                ? error.message
                : 'HARNESS_UNKNOWN',
            message: '官方 Harness 调用未完成',
          },
        })
    }
  })()
})
const stop = () => {
  releaseEverything()
  process.exit()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.stdin.on('end', stop)
process.on('exit', () => releaseEverything())
