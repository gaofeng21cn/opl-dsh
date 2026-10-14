/**
 * MSP → ACP projection for the official Muse Code CLI.
 *
 * Muse speaks MSP (JSON-RPC 2.0 over NDJSON on stdio) and the suite drives ACP, so
 * this process owns the translation and nothing else: it spawns one
 * `muse serve` host, completes the official handshake, and answers the ACP surface
 * the execution engine already uses. There is no agent loop here — every turn is the
 * official runtime's own, and every tool is the official runtime's.
 *
 * Protocol facts this projection is written against, all verified against
 * `Muse Code 1.4.7 (1.4.7-R6101.1)`:
 *
 *  - The handshake is two steps, not one. `initialize` answers, then the client MUST
 *    send an `initialized` notification. Without it every later method answers
 *    `-32600 Not initialized`.
 *  - `initialize` returns `schema.fingerprint`, and this build serves
 *    `sha256:6de32db08bbbe0deb478d2bfcaba001e9fb490986bc80db3aceb4d996abf7df9`,
 *    the same value `@muse-code/sdk@1.4.7` pins in `EXPECTED_SCHEMA_FINGERPRINT`.
 *    A different fingerprint is refused here rather than carried on: this projection
 *    was written against one stable surface, and the SDK's own advice for a mismatch
 *    is to re-pin after reviewing what changed, not to keep talking to an unknown
 *    schema.
 *  - `session/start` requires a UUIDv7 `commandId`; a plain string is `invalidParams`.
 *  - `session/setModel` takes `model: {modelId}`, and answers a refusal with
 *    `-32030 commandRejected` carrying `data.reason`. That refusal is a hard stop, not
 *    a fallback: the whole point of pinning is that no other model may run.
 *  - `sandboxAvailability` comes back from `initialize` and is reported verbatim.
 *
 * Written as plain ESM on purpose: the execution engine spawns this file as its own
 * OS process and never imports it, so compiling it would buy nothing and would add a
 * shared-build entry the packager has to keep in step.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { startMuseEndpoint } from './muse-endpoint.mjs'

/**
 * Stable-surface fingerprint this projection refuses to talk past.
 *
 * The adapter owns the value and passes it in, so there is one pin in the repository
 * rather than two that can disagree. The literal below is the fallback for running
 * this file directly; it is the value `muse serve` 1.4.7-R6101.1 serves and the value
 * `@muse-code/sdk@1.4.7` pins in `EXPECTED_SCHEMA_FINGERPRINT`.
 */
export const MUSE_SCHEMA_FINGERPRINT =
  process.env.OPL_MUSE_SCHEMA_FINGERPRINT ??
  'sha256:6de32db08bbbe0deb478d2bfcaba001e9fb490986bc80db3aceb4d996abf7df9'

/** Configuration this bridge is launched with; every value comes from the adapter. */
const CFG = {
  command: process.env.OPL_MUSE_COMMAND ?? '',
  prefix: JSON.parse(process.env.OPL_MUSE_PREFIX ?? '[]'),
  verbatim: process.env.OPL_MUSE_VERBATIM === '1',
  model: process.env.OPL_MUSE_MODEL ?? '',
  baseUrl: process.env.OPL_MUSE_BASE_URL ?? '',
  apiKey: process.env.META_API_KEY ?? '',
  approvalMode: process.env.OPL_MUSE_APPROVAL_MODE ?? 'allowAll',
  effort: process.env.OPL_MUSE_EFFORT ?? '',
  protocol: process.env.OPL_MUSE_PROTOCOL ?? 'responses',
  contributorMode: process.env.OPL_MUSE_CONTRIBUTOR_MODE ?? 'off',
  bashTool: process.env.OPL_MUSE_BASH_TOOL ?? '',
}

const log = (line) => process.stderr.write(`muse-bridge: ${line}\n`)

/** UUIDv7 command ids: MSP rejects anything else, so this is a protocol requirement. */
let lastMs = 0
let seq = 0
function uuidV7() {
  const bytes = randomUUID()
    .replace(/-/gu, '')
    .match(/../gu)
    .map((byte) => parseInt(byte, 16))
  const now = Date.now()
  const ms = now > lastMs ? now : lastMs
  seq = ms === lastMs ? (seq + 1) & 0x0fff : 0
  lastMs = ms
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff
  bytes[5] = ms & 0xff
  bytes[6] = (0x70 | ((seq >>> 8) & 0x0f)) & 0xff
  bytes[7] = seq & 0xff
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The official MSP connection to one `muse serve` child. */
class MspConnection {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Set()
    this.closed = false
    createInterface({ input: child.stdout }).on('line', (line) => this.#receive(line))
    const failed = (error) => {
      if (this.closed) return
      this.closed = true
      for (const { reject } of this.pending.values()) reject(error)
      this.pending.clear()
      for (const handler of this.handlers) handler(null)
    }
    child.on('error', () => failed(Error('官方 Muse Code 启动失败')))
    child.on('exit', (code, signal) => {
      failed(Error(`官方 Muse Code 进程已退出（code=${code} signal=${signal}）`))
    })
  }

  #receive(line) {
    const trimmed = line.trim()
    if (!trimmed) return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch (error) {
      log(`丢弃无法解析的行：${error.message}`)
      return
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) {
        const failure = Error(message.error.message ?? 'MSP error')
        failure.code = message.error.code
        failure.data = message.error.data
        reject(failure)
      } else resolve(message.result)
      return
    }
    for (const handler of this.handlers) handler(message)
  }

  notify(method, params) {
    if (this.closed) return
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  command(method, params, timeoutMs = 120_000) {
    if (this.closed) return Promise.reject(Error('官方 Muse Code 连接已关闭'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Error(`官方 Muse Code 未在 ${timeoutMs}ms 内响应 ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
}

/** ACP-side JSON-RPC framing, in the shape the execution engine's transport expects. */
class AcpSide {
  constructor() {
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Set()
  }

  respond(id, result) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }
  reject(id, code, message) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
  }
  notify(method, params) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
  onMessage(handler) {
    this.handlers.add(handler)
  }
  onRequest(method, handler) {
    this.handlers.add((message) => {
      if (message.method === method) handler(message)
    })
  }
  accept(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) reject(Error(message.error.message ?? 'ACP error'))
      else resolve(message.result)
      return true
    }
    return false
  }
  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
}

/** State the ACP projection keeps for one Muse session. */
const state = {
  msp: null,
  child: null,
  sessionId: '',
  /** In-flight `session/prompt`, settled only by an MSP `turn/completed`. */
  turn: null,
  /** ACP `sessionId` → MSP `sessionId` is 1:1 here; the map exists for clarity. */
  model: CFG.model,
  effort: CFG.effort,
  cancelled: false,
}

const acp = new AcpSide()

/**
 * Fail the launch when the host's stable surface is not the one this projection knows.
 *
 * The SDK treats a fingerprint move as a warning because its facade is generated
 * against the whole open schema. This projection is not: it names specific methods
 * and fields, so an unknown surface has to stop the run and be reviewed.
 */
function assertFingerprint(result) {
  const served = result?.schema?.fingerprint
  if (served !== MUSE_SCHEMA_FINGERPRINT)
    throw Error(
      `官方 Muse Code 的 MSP schema 指纹与本适配器固定值不一致：官方 ${served ?? '（未提供）'}，本适配器 ${MUSE_SCHEMA_FINGERPRINT}。已停止，未启动会话；不会在未知 schema 上继续，也不会改用其他模型。`,
    )
}

/** Start the official host and complete the two-step MSP handshake. */
async function connect() {
  if (!CFG.command) throw Error('未提供官方 Muse Code 可执行文件路径')
  if (state.closing) throw Error('Muse 连接已关闭')
  const settingsFile = join(process.env.XDG_CONFIG_HOME ?? '', 'muse', 'settings.json')
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'))
  if (
    settings.endpoint_transport?.base_url !== CFG.baseUrl ||
    settings.endpoint_transport?.auth !== 'bearer'
  )
    throw Error('Muse 端点设置与本轮模型来源不一致，未启动 CLI')
  const endpoint = await startMuseEndpoint({ baseURL: CFG.baseUrl, apiKey: CFG.apiKey })
  state.endpoint = endpoint
  if (state.closing) throw Error('Muse 连接已关闭')
  const temporary = `${settingsFile}.${randomUUID()}.tmp`
  settings.endpoint_transport = { base_url: endpoint.baseURL, auth: 'bearer' }
  await writeFile(temporary, JSON.stringify(settings) + '\n', { flag: 'wx', mode: 0o600 })
  await rename(temporary, settingsFile)
  if (state.closing) throw Error('Muse 连接已关闭')
  const child = spawn(CFG.command, CFG.prefix, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, META_API_KEY: endpoint.apiKey },
    windowsHide: true,
    windowsVerbatimArguments: CFG.verbatim,
  })
  state.child = child
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/u)) if (line.trim()) log(line.trim())
  })
  const msp = new MspConnection(child)
  state.msp = msp
  msp.handlers.add((message) => {
    if (message === null) {
      state.turn?.reject(Error('官方 Muse Code 连接已关闭'))
      state.turn = null
      void dispose()
    } else onMspMessage(message)
  })
  const opened = await msp.command('initialize', {
    clientInfo: { name: 'opl_dsh', title: 'OPL DSH', version: '1' },
    capabilities: { requestedCapabilities: [], userInputDialogs: false },
  })
  assertFingerprint(opened)
  // Required second handshake step; every later method answers notInitialized without it.
  msp.notify('initialized')
  if (state.closing) throw Error('Muse 连接已关闭')
  return opened
}

/** Project one MSP notification onto the ACP surface. */
function onMspMessage(message) {
  if (!message || typeof message !== 'object') return
  const params = message.params ?? {}
  if (params.sessionId && state.sessionId && params.sessionId !== state.sessionId) return
  switch (message.method) {
    case 'session/modelChanged':
      state.observedModel = params.modelId
      return
    case 'session/reasoningEffortChanged':
      state.observedEffort = params.reasoningEffort
      return
    case 'item/started':
      openItems.set(params.item?.itemId, { kind: params.item?.kind, streamed: false })
      if (params.item?.kind === 'toolCall')
        acp.notify('session/update', {
          sessionId: state.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: params.item.itemId,
            title: params.item.tool ?? params.item.name ?? params.item.title ?? '',
            kind: 'other',
            status: 'pending',
            rawInput: params.item.args ?? params.item.arguments ?? {},
          },
        })
      return
    case 'item/delta': {
      const item = openItems.get(params.itemId)
      // Only assistant text is streamed into the transcript; reasoning and tool
      // output belong to the tool_call channel and are reported at completion.
      if (item?.kind === 'agentMessage' && (!params.field || params.field === 'text')) {
        item.streamed = true
        acp.notify('session/update', {
          sessionId: state.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: params.delta ?? '' },
          },
        })
      }
      return
    }
    case 'item/completed':
      if (params.item?.kind === 'toolCall')
        acp.notify('session/update', {
          sessionId: state.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: params.item.itemId,
            status: params.item.status === 'completed' ? 'completed' : 'failed',
            content: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text:
                    params.item.visibleOutput ??
                    params.item.failureReason ??
                    params.item.output ??
                    '',
                },
              },
            ],
          },
        })
      else if (
        params.item?.kind === 'agentMessage' &&
        !openItems.get(params.item.itemId)?.streamed &&
        typeof params.item.text === 'string' &&
        params.item.text
      )
        acp.notify('session/update', {
          sessionId: state.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: params.item.text },
          },
        })
      openItems.delete(params.item?.itemId)
      return
    case 'turn/completed': {
      const pending = state.turn
      state.turn = null
      openItems.clear()
      if (!pending) return
      const terminal = params.terminal
      // The official terminal is the only thing that decides a turn's outcome. A
      // requested cancellation that the runtime ignored leaves a `completed` turn, and
      // reporting it as cancelled would be a success the runtime never granted.
      if (terminal === 'cancelled') {
        if (pending.cancelError)
          log(`本轮终态为 cancelled，但此前的取消请求被拒绝：${pending.cancelError}`)
        pending.resolve({ stopReason: 'cancelled' })
      } else if (terminal === 'completed') {
        if (pending.cancelError)
          log(`取消请求被拒绝（${pending.cancelError}），本轮以 completed 结束，未标记为已取消。`)
        pending.resolve({ stopReason: 'end_turn' })
      } else
        pending.reject(
          Error(
            `官方 Muse Code 本轮以 ${terminal} 结束：${params.reason ?? params.error?.message ?? '未提供原因'}` +
              (pending.cancelError ? `（取消请求同时被拒绝：${pending.cancelError}）` : ''),
          ),
        )
      return
    }
    default:
  }
}

const openItems = new Map()

async function readSelection() {
  const read = await state.msp.command('session/read', {
    sessionId: state.sessionId,
    excludeItems: true,
  })
  if (
    read.session?.modelId !== state.model ||
    (state.observedModel && state.observedModel !== state.model)
  )
    throw Error('Muse 实际会话模型与所选组合不一致')
  if (state.effort && state.observedEffort !== state.effort)
    throw Error('Muse 未回报所选思考档位已生效')
  return {
    modelId: read.session.modelId,
    ...(state.effort ? { reasoningEffort: state.observedEffort } : {}),
  }
}

/** ACP `initialize`. */
async function onInitialize() {
  if (state.closing) throw Error('Muse 连接已关闭')
  let opened
  try {
    opened = await (state.opening ??= connect())
  } catch (error) {
    await dispose()
    throw error
  }
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
    },
    agentInfo: {
      name: 'Muse Code',
      version: String(opened.serverInfo?.version ?? ''),
    },
    // Surfaced rather than interpreted: the adapter already refuses every tier whose
    // isolation this value cannot support.
    _meta: {
      'muse/sandboxAvailability': opened.sandboxAvailability ?? null,
      'muse/schemaFingerprint': MUSE_SCHEMA_FINGERPRINT,
      'muse/museHome': opened.museHome ?? null,
      'muse/bashTool': CFG.bashTool,
    },
  }
}

async function onSessionNew(params) {
  if (state.closing || !state.msp) throw Error('Muse 连接已关闭')
  const started = await state.msp.command('session/start', {
    commandId: uuidV7(),
    workspaceRoot: params.cwd,
    approvalMode: CFG.approvalMode,
    modelId: state.model || undefined,
  })
  state.sessionId = started.session.sessionId
  // The pinned model is applied over the wire and its refusal is fatal: this is the
  // only place a different model could be substituted, so it must not be tolerated.
  const selected = await state.msp.command('session/setModel', {
    sessionId: state.sessionId,
    commandId: uuidV7(),
    model: { modelId: state.model },
  })
  if (selected.status !== 'accepted')
    throw Error(`官方 Muse Code 未接受所选模型 ${state.model}（status=${selected.status}）`)
  if (state.effort) {
    const effort = await state.msp.command('session/setReasoningEffort', {
      sessionId: state.sessionId,
      commandId: uuidV7(),
      reasoningEffort: state.effort,
    })
    if (effort.status !== 'accepted')
      throw Error(`官方 Muse Code 未接受思考档位 ${state.effort}（status=${effort.status}）`)
  }
  return {
    sessionId: state.sessionId,
    models: { currentModelId: state.model, availableModels: [{ modelId: state.model }] },
    configOptions: await readSelection(),
  }
}

async function onSessionLoad(params) {
  if (state.closing || !state.msp) throw Error('Muse 连接已关闭')
  const resumed = await state.msp.command('session/resume', {
    commandId: uuidV7(),
    sessionId: params.sessionId,
    history: 'snapshot',
  })
  state.sessionId = resumed.session.sessionId
  state.observedEffort = resumed.history?.snapshot?.state?.reasoningEffort?.reasoningEffort
  state.observedModel = resumed.session.modelId
  // A resumed session keeps whatever model it had; pin it again or refuse.
  const selected = await state.msp.command('session/setModel', {
    sessionId: state.sessionId,
    commandId: uuidV7(),
    model: { modelId: state.model },
  })
  if (selected.status !== 'accepted')
    throw Error(`恢复的 Muse 会话未接受所选模型 ${state.model}（status=${selected.status}）`)
  if (state.effort) {
    const effort = await state.msp.command('session/setReasoningEffort', {
      sessionId: state.sessionId,
      commandId: uuidV7(),
      reasoningEffort: state.effort,
    })
    if (effort.status !== 'accepted')
      throw Error(`恢复的 Muse 会话未接受思考档位 ${state.effort}（status=${effort.status}）`)
  }
  return {
    sessionId: state.sessionId,
    models: { currentModelId: state.model, availableModels: [{ modelId: state.model }] },
    configOptions: await readSelection(),
  }
}

async function onSessionPrompt(params) {
  if (state.closing || params.sessionId !== state.sessionId || state.turn)
    throw Error('Muse 会话不匹配或已有活动轮次')
  // Reserve the turn before awaiting readback so concurrent prompts cannot enter.
  const pending = { resolve: undefined, reject: undefined, cancelError: null }
  const result = new Promise((resolve, reject) => Object.assign(pending, { resolve, reject }))
  result.catch(() => {}) // Owned until the turn/start acknowledgement is received.
  state.turn = pending
  // A cancel that arrived with no turn in flight had nothing to cancel; carrying it
  // forward would report this prompt as cancelled before it ever ran.
  state.cancelled = false
  const text = (params.prompt ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('')
  try {
    await readSelection()
    if (state.closing || state.turn !== pending) throw Error('Muse 连接已关闭')
    await state.msp.command(
      'turn/start',
      {
        sessionId: state.sessionId,
        commandId: uuidV7(),
        input: [{ type: 'text', text }],
        ...(state.effort ? { reasoningEffort: state.effort } : {}),
        ifBusy: 'replace',
      },
      24 * 60 * 60 * 1000,
    )
  } catch (error) {
    if (state.turn === pending) state.turn = null
    pending.reject(error)
    throw error
  }
  // Settled by `turn/completed` only. No timer decides a turn's fate, so a slow model
  // and a fast one follow the same path.
  return result
}

async function onSessionCancel() {
  const pending = state.turn
  if (!pending) {
    // Nothing is running, so there is no cancellation to report. Saying "cancelled"
    // here would credit the runtime with an outcome it never produced.
    state.cancelled = true
    return { stopReason: 'no_active_turn', turnActive: false }
  }
  state.cancelled = true
  try {
    // Only the acknowledgement is claimed. The prompt still resolves from the official
    // `turn/completed`, so an ack on its own can never turn into a cancelled turn.
    await state.msp.command('turn/cancel', {
      sessionId: state.sessionId,
      commandId: uuidV7(),
    })
    return { stopReason: 'cancel_requested', turnActive: true }
  } catch (error) {
    // A refusal is carried into the turn's own outcome rather than swallowed: the
    // prompt keeps waiting for the real terminal, and reports the refusal alongside it.
    pending.cancelError = error.message
    log(`官方 Muse Code 拒绝了取消请求：${error.message}`)
    return { stopReason: 'cancel_rejected', turnActive: true, error: error.message }
  }
}

let disposal
function dispose() {
  state.closing = true
  return (disposal ??= close())
}
async function close() {
  if (state.turn) {
    state.turn.reject(Error('官方 Muse Code 连接已关闭'))
    state.turn = null
  }
  const child = state.child
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('close', resolve))
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 3000)
    await exited
    clearTimeout(timer)
  }
  await state.opening?.catch(() => {}) // A failed handshake still owns relay cleanup.
  await state.endpoint?.close()
}

process.on('SIGTERM', () => {
  void dispose()
})
process.on('SIGINT', () => {
  void dispose()
})
process.stdin.on('end', () => {
  void dispose()
})

createInterface({ input: process.stdin }).on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }
  if (acp.accept(message)) return
  const id = message.id
  const handler =
    message.method === 'initialize'
      ? onInitialize
      : message.method === 'session/new'
        ? onSessionNew
        : message.method === 'session/load'
          ? onSessionLoad
          : message.method === 'session/prompt'
            ? onSessionPrompt
            : message.method === 'session/cancel'
              ? onSessionCancel
              : undefined
  if (!handler) {
    if (id !== undefined) acp.reject(id, -32601, `Method not found: ${message.method}`)
    return
  }
  Promise.resolve(handler(message.params ?? {}))
    .then((result) => acp.respond(id, result ?? null))
    .catch((error) => {
      log(`${message.method} 失败：${error.message}`)
      acp.reject(id, -32000, error.message)
    })
})
