/** ACP transport projection over the installed official ZCode CLI.
 *
 * This file owns no agent loop, model request, tool execution or session format. It
 * launches the official CLI and translates the official ZCode Protocol (newline
 * delimited JSON-RPC over stdio) onto the ACP surface the host already drives for the
 * other official harnesses.
 *
 * Credential handling: the Huawei key is read from the Windows Credential Manager into
 * this process's memory at startup and never leaves it in any persisted form. It is not
 * passed through the adapter's environment, argv, a file, a log or the ZCode protocol.
 * Instead the official CLI is pointed at a loopback relay that holds the key and
 * swaps it in on the wire. The provider config therefore only ever contains a fixed
 * non-secret placeholder.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { commandLaunch } from '../harness-registry.ts'
import {
  describeHuaweiMaaSApiKey,
  readHuaweiMaaSApiKey,
} from '../../../credentials/host/windows-keyring.ts'
import {
  HUAWEI_RELAY_TICKET_HEADER,
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
  assertModelSelection,
  assertSessionMode,
  assertProtocolIdentity,
  buildBuiltinProviderConfig,
  buildPersonalProviderConfig,
  startHuaweiRelay,
  modelSelection,
  redactSecret,
  resolvePermissionResponse,
  type ZcodeEvent,
  type ZcodePermissionRequest,
  type HuaweiRelay,
} from './zcode-protocol.ts'

const command = process.env.OPL_ZCODE_COMMAND!
/** Arguments placed before the protocol subcommand, e.g. the `zcode.cjs` bundle path. */
const prefix: string[] = JSON.parse(process.env.OPL_ZCODE_PREFIX ?? '[]')
const providerId = process.env.OPL_ZCODE_PROVIDER_ID!
const model = process.env.OPL_ZCODE_MODEL!
const providerConfigFile = process.env.OPL_ZCODE_PROVIDER_CONFIG_FILE!
const personalProviderConfigFile = process.env.OPL_ZCODE_PERSONAL_PROVIDER_CONFIG_FILE!
/**
 * The permission mode the task authorized. `yolo` is the official full-access mode;
 * `auto` is reserved upstream and fails closed, so it is never accepted here.
 */
const mode = process.env.OPL_ZCODE_MODE ?? ZCODE_FULL_ACCESS_MODE
if (!ZCODE_SESSION_MODES.includes(mode as (typeof ZCODE_SESSION_MODES)[number]))
  throw Error('ZCode 会话模式不在官方值域内')
if (mode === 'auto') throw Error('ZCode 的 auto 模式官方保留且直接拒绝，不能用于本组合')
const reasoningLevel = process.env.OPL_ZCODE_REASONING_LEVEL!
const cwd = process.cwd()

const send = (value: object) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const emit = (update: object) => send({ method: 'session/update', params: { sessionId, update } })

let sessionId = '',
  cancelled = false,
  seq = 0
const streamed = new Set<string>()
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const asks = new Map<string, (optionId: string | undefined) => void>()
let resolveTurn: ((value: unknown) => void) | undefined,
  rejectTurn: ((e: Error) => void) | undefined

/** Release the child process, the relay and every in-flight request together. */
let relay: HuaweiRelay | undefined
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
  for (const answer of asks.values()) answer(undefined)
  asks.clear()
  rejectTurn?.(Error(reason))
  resolveTurn = undefined
  rejectTurn = undefined
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
          title:
            'ZCode · ' +
            request.toolName +
            '\n' +
            request.reason +
            '\n' +
            JSON.stringify(request.input ?? {}).slice(0, 2000),
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
const REQUEST_TIMEOUT_MS = Number(process.env.OPL_ZCODE_REQUEST_TIMEOUT_MS ?? 180000)

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

// ── Loopback credential relay ────────────────────────────────────────────────────────
// The relay itself lives in zcode-protocol.ts so it can be exercised directly.
let apiKey: string | undefined

/**
 * Resolve the credential on demand.
 *
 * Nothing reads the key eagerly or stores it: the value exists only in this variable
 * and in the closure handed to the relay. It is never written to a file, placed in an
 * argument vector, or logged.
 */
async function readKey(): Promise<string | undefined> {
  apiKey = await readHuaweiMaaSApiKey()
  return apiKey
}

/**
 * Launch the official CLI in app-server mode.
 *
 * The real runtime is `node <zcode.cjs> app-server --stdio`, so the command and the
 * prefix that carries the bundle path are composed explicitly instead of assuming the
 * CLI is installed on PATH. A Windows `.cmd`/`.bat` launcher additionally needs
 * `cmd.exe` with the path quoted twice, because `/S` strips only the outer pair.
 */
async function openAgent() {
  // The real runtime is `node <zcode.cjs> app-server --stdio`, so the command and the
  // prefix carrying the bundle path are composed explicitly instead of assuming the CLI
  // is on PATH. `commandLaunch` is the repository's already-verified launcher: it quotes
  // each argument individually before handing it to cmd.exe, which a plain
  // `args.join(' ')` does not and which breaks on any argument containing a space.
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
        if (process.env.OPL_ZCODE_DIAGNOSTICS === '1')
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
 * The two provider config variables are always set together: the builtin file carries
 * this task's Huawei provider and the personal file is where the CLI expects the user's
 * own overlay to live, so leaving one unset is not a supported combination.
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
 * Only non-secret fields are persisted: a fixed placeholder key, and the loopback
 * base URL the official CLI will call. The Huawei credential stays in memory.
 */
function writeProviderConfig(relayBaseUrl: string, ticket: string) {
  const headers = { [HUAWEI_RELAY_TICKET_HEADER]: ticket }
  mkdirSync(dirname(providerConfigFile), { recursive: true, mode: 0o700 })
  mkdirSync(dirname(personalProviderConfigFile), { recursive: true, mode: 0o700 })
  // Two files, because the official CLI expects the builtin and personal variables as a
  // pair and the two layers use different schemas.
  writeFileSync(providerConfigFile, JSON.stringify(buildBuiltinProviderConfig(), null, 2), {
    mode: 0o600,
  })
  writeFileSync(
    personalProviderConfigFile,
    JSON.stringify(
      buildPersonalProviderConfig({
        providerId,
        providerName: 'Huawei MaaS',
        baseUrl: relayBaseUrl,
        modelId: model,
        reasoningLevel,
        headers,
      }),
      null,
      2,
    ),
    { mode: 0o600 },
  )
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
  for (const update of acpUpdatesForEventSafe(event)) emit(update)
}
function acpUpdatesForEventSafe(event: ZcodeEvent) {
  return acpUpdatesForEvent(event, streamed)
}

/** Answer a request the agent makes of this client. */
async function answerAgentRequest(m: any) {
  if (m.method === ZCODE_METHODS.sessionRequestRuntimePreferences) {
    // Answered explicitly rather than refused: the official client is asked for these
    // during session creation, and refusing it makes `session/create` fail.
    child!.stdin!.write(
      JSON.stringify({ id: m.id, result: { ...ZCODE_RUNTIME_PREFERENCES } }) + '\n',
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
    // The credential is read here, once, into this process's memory. Nothing downstream
    // ever reads it again, and it is not written anywhere.
    // Presence is checked without loading the value. An unconfigured or unreachable
    // keyring is reported rather than thrown here, so the protocol surface stays usable
    // and the failure lands on the request that actually needs the credential, with the
    // relay refusing closed (503) instead of any silent downgrade.
    const keyring = await describeHuaweiMaaSApiKey()
    // `runtime/capabilities` only reports `independentPlanState`; it carries no protocol
    // identity, so the identity is verified from the real session snapshot instead.
    if (child || relay) throw Error('ZCode 桥接器已经初始化')
    relay = await startHuaweiRelay(readKey)
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
        credentialConfigured: keyring.configured,
        home: homedir(),
      },
    }
  }
  if (method === 'session/new' || method === 'session/load') {
    if (p.cwd !== cwd) throw Error('不能改变已绑定项目')
    const workspace = { workspacePath: cwd, workspaceKey: cwd }
    // Both lifecycle calls answer with the official session state snapshot; the
    // session id lives at `snapshot.session.sessionId`.
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
            model: modelSelection(providerId, model, reasoningLevel),
          })
    sessionId = snapshot?.session?.sessionId
    if (!sessionId) throw Error('ZCode 未返回会话标识')
    // Confirm the live session really is on the requested model and mode before it is
    // ever driven. A silent downgrade to another model or mode is not acceptable.
    assertProtocolIdentity(snapshot)
    assertModelSelection(snapshot, providerId, model)
    assertSessionMode(snapshot, mode)
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
    // snapshot, so both the model and the permission mode are confirmed against server
    // state rather than against what this process believes it asked for.
    const probe: any = await zcodeRequest(ZCODE_METHODS.sessionSubscribe, {
      sessionId,
      deliveryKind: 'desktop-continuous',
      includeSnapshot: true,
    })
    const live = probe?.snapshot ?? probe
    assertSessionMode(live, mode)
    assertProtocolIdentity(live)
    assertModelSelection(live, providerId, model)
    const done = new Promise((resolve, reject) => {
      resolveTurn = resolve
      rejectTurn = reject
    })
    void done.catch(() => {})
    try {
      await zcodeRequest(ZCODE_METHODS.sessionSend, {
        sessionId,
        content: text,
        modelSelection: modelSelection(providerId, model, reasoningLevel),
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
      if (process.env.OPL_ZCODE_DIAGNOSTICS === '1')
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
