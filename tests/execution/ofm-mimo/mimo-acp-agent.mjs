/**
 * Executable ACP agent fixture for the MiMo Code adaptation tests.
 *
 * It speaks the subset of the official protocol this adapter relies on, and — most
 * importantly — it derives its model advertisement from the launch configuration the
 * adapter actually produced (`MIMOCODE_CONFIG_CONTENT`), the same way the official CLI
 * merges that variable. A test therefore cannot pass by matching the adapter's own
 * constants: if the adapter wrote a different provider id, model id, or shape, the
 * advertised values change and the pinning checks fail.
 *
 * Every inbound request is appended to `MIMO_JOURNAL` so assertions cover the real wire
 * method names, order, and parameters rather than in-process calls.
 */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const journal = process.env.MIMO_JOURNAL
/** When set, the reported value drifts away from the one that was just written. */
const drift = process.env.MIMO_DRIFT_AFTER_SET === '1'
/** When set, the agent refuses every config write, as a CLI without the option would. */
const rejectSet = process.env.MIMO_REJECT_SET === '1'
/** When set, the prompt asks the client for permission before doing any work. */
const askPermission = process.env.MIMO_ASK_PERMISSION === '1'

const record = (entry) => {
  if (journal) appendFileSync(journal, JSON.stringify(entry) + '\n')
}

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const reply = (id, result) => send({ id, result })
const fail = (id, code, message) => send({ id, error: { code, message } })

/** Build the advertisement exactly as `@/acp/agent`'s `buildConfigOptions` does. */
function loadConfig() {
  let parsed = {}
  try {
    parsed = JSON.parse(process.env.MIMOCODE_CONFIG_CONTENT || '{}')
  } catch {
    parsed = {}
  }
  const providerId = Object.keys(parsed.provider ?? {})[0]
  const provider = providerId ? parsed.provider[providerId] : undefined
  const modelIds = provider ? Object.keys(provider.models ?? {}) : []
  const availableModels = modelIds.map((modelId) => ({
    // `provider/model`, optionally followed by a variant segment.
    value: `${providerId}/${modelId}`,
    name: `${provider?.name}/${modelId}`,
  }))
  return {
    providerId,
    models: availableModels,
    currentModelId: typeof parsed.model === 'string' ? parsed.model : '',
    configOptions: (currentModelId) => [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: currentModelId,
        options: availableModels,
      },
      {
        id: 'mode',
        name: 'Session Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'build',
        options: [{ value: 'build', name: 'build' }],
      },
    ],
  }
}

const config = loadConfig()
const sessions = new Map()
const aborted = new Set()
/** Outstanding `session/request_permission` asks, keyed by the id we sent. */
const permissionWaits = new Map()
let sequence = 0
let permissionSequence = 0
const sessionId = () => `mimo-session-${++sequence}`

function snapshot(currentModelId) {
  return {
    sessionId: 'session',
    configOptions: config.configOptions(currentModelId),
  }
}

async function prompt(params, id) {
  const session = sessions.get(params.sessionId)
  if (!session) return fail(id, -32602, 'Unknown session')
  record({ method: 'session/prompt', params: { sessionId: params.sessionId } })
  if (askPermission) {
    const askId = `permission-${++permissionSequence}`
    const decision = await new Promise((done) => {
      permissionWaits.set(askId, done)
      send({
        id: askId,
        method: 'session/request_permission',
        params: {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'bash-1', status: 'pending', title: 'bash', kind: 'execute' },
          options: [
            { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
          ],
        },
      })
      record({ event: 'permission.requested' })
    })
    record({ event: 'permission.settled', decision })
    // A refusal ends the turn exactly as a human rejection would: no retry, no fallback.
    const outcome = decision?.outcome?.outcome === 'selected' ? decision.outcome.optionId : 'reject'
    if (outcome !== 'once') return reply(id, { stopReason: 'refusal' })
  }
  send({
    method: 'session/update',
    params: {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
    },
  })
  record({ event: 'chunk.sent' })
  // Holding the turn open makes cancellation deterministic: the reply is produced only
  // after the cancel notification has actually arrived, so the client cannot observe a
  // cancelled receipt through a timing race.
  if (process.env.MIMO_HOLD === '1') {
    const session = sessions.get(params.sessionId)
    await new Promise((done) => {
      session.release = done
    })
  }
  // The cancellation receipt is carried by this same request, so the client only learns
  // the run stopped when the original prompt comes back — never on a timer.
  if (aborted.has(params.sessionId)) return reply(id, { stopReason: 'cancelled' })
  return reply(id, { stopReason: 'end_turn' })
}

const handlers = {
  initialize: (params, id) => {
    record({ method: 'initialize', params })
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: { embeddedContext: true, image: true },
        sessionCapabilities: { fork: {}, list: {}, resume: {} },
      },
      agentInfo: { name: 'OpenCode', version: process.env.MIMO_FAKE_VERSION || '0.0.0' },
    })
  },
  'session/new': (params, id) => {
    const sid = sessionId()
    sessions.set(sid, {
      currentModelId: config.currentModelId,
      pendingId: 0,
      pendingPermission: null,
    })
    record({ method: 'session/new', params: { cwd: params.cwd } })
    reply(id, { ...snapshot(config.currentModelId), sessionId: sid })
  },
  'session/load': (params, id) => {
    const sid = sessionId()
    sessions.set(sid, {
      currentModelId: config.currentModelId,
      pendingId: 0,
      pendingPermission: null,
      restored: params.sessionId,
    })
    record({ method: 'session/load', params: { cwd: params.cwd, sessionId: params.sessionId } })
    reply(id, { ...snapshot(config.currentModelId), sessionId: sid })
  },
  'session/set_config_option': (params, id) => {
    const session = sessions.get(params.sessionId)
    if (!session)
      return fail(
        id,
        -32602,
        `Unknown session: ${JSON.stringify(params.sessionId)} known=${JSON.stringify([...sessions.keys()])}`,
      )
    record({ method: 'session/set_config_option', params })
    if (rejectSet || params.configId !== 'model')
      return fail(id, -32602, `Unsupported config option: ${params.configId}`)
    if (!config.models.some((model) => model.value === params.value))
      return fail(id, -32602, 'Model not offered by this configuration')
    session.currentModelId = params.value
    // Drift models a session that accepted the write but did not actually apply it.
    const reported = drift
      ? (config.models.find((m) => m.value !== params.value)?.value ?? '')
      : session.currentModelId
    reply(id, { configOptions: config.configOptions(reported) })
  },
  'session/prompt': prompt,
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.method === undefined) {
      // A response to a request this agent sent; settle it rather than treating it as input.
      const waiter = permissionWaits.get(String(message.id))
      if (waiter) {
        permissionWaits.delete(String(message.id))
        waiter(message.result)
      }
      return
    }
    if (message.id === undefined) {
      // A notification: only cancellation is implemented.
      record({ method: message.method, params: message.params })
      if (message.method === 'session/cancel') {
        aborted.add(message.params.sessionId)
        // Release a held turn so the original prompt can answer with its receipt.
        sessions.get(message.params.sessionId)?.release?.()
      }
      return
    }
    const handler = handlers[message.method]
    if (!handler) return fail(message.id, -32601, `Unsupported method: ${message.method}`)
    void handler(message.params, message.id)
  })
  .on('close', () => process.exit(0))

// The launch argument vector and working directory are evidence that a path containing
// both Chinese characters and spaces survived the transport intact.
record({ event: 'spawn', argv, cwd: process.cwd() })
