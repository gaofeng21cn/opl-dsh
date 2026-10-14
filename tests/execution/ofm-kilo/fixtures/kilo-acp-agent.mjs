/**
 * Executable ACP agent fixture for the Kilo adaptation tests.
 *
 * It speaks the subset of the official protocol this adapter relies on and — most
 * importantly — derives its model advertisement from the launch configuration the adapter
 * actually produced (`KILO_CONFIG_CONTENT`), the same way the official CLI merges that
 * variable. A test therefore cannot pass by matching the adapter's own constants: if the
 * adapter wrote a different provider id, model id, namespace, or shape, the advertised
 * values change and the pinning checks fail.
 *
 * The advertisement mirrors what the pinned `@kilocode/cli@7.8.8` binary was measured to
 * send:
 *   - a `model` select whose values are `provider/model`;
 *   - an `effort` select in category `thought_level` that is advertised only while the
 *     CLI's own default model is selected (one value, `thinking`) and that disappears from
 *     `configOptions` once a route model is pinned; writes are refused either way;
 *   - a `mode` select with `code`/`ask`/`debug`/`orchestrator`/`plan`;
 *   - `session/load` reporting the CLI's own default model, not the pinned one;
 *   - `session/cancel` answering `-32601 "Method not found"`.
 *
 * Every inbound request is appended to `KILO_JOURNAL` so assertions cover the real wire
 * method names, order, and parameters rather than in-process calls.
 */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const journal = process.env.KILO_JOURNAL
/** When set, the reported value drifts away from the one that was just written. */
const drift = process.env.KILO_DRIFT_AFTER_SET === '1'
/** When set, the agent refuses every config write, as a CLI without the option would. */
const rejectSet = process.env.KILO_REJECT_SET === '1'
/** When set, `session/load` reports the CLI's own default model, as the real one does. */
const loadResetsModel = process.env.KILO_LOAD_RESETS_MODEL === '1'
/** When set, the prompt asks the client for permission before doing any work. */
const askPermission = process.env.KILO_ASK_PERMISSION === '1'
/** When set, `session/cancel` answers -32601, as the pinned CLI does. */
const cancelUnsupported = process.env.KILO_CANCEL_UNSUPPORTED === '1'

const record = (entry) => {
  if (journal) appendFileSync(journal, JSON.stringify(entry) + '\n')
}

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const reply = (id, result) => send({ id, result })
const fail = (id, code, message) => send({ id, error: { code, message } })

/** Build the advertisement exactly as the official CLI's ACP agent does. */
function loadConfig() {
  let parsed = {}
  try {
    parsed = JSON.parse(process.env.KILO_CONFIG_CONTENT || '{}')
  } catch {
    parsed = {}
  }
  const providerId = Object.keys(parsed.provider ?? {})[0]
  const provider = providerId ? parsed.provider[providerId] : undefined
  const modelIds = provider ? Object.keys(provider.models ?? {}) : []
  const availableModels = modelIds.map((modelId) => ({
    value: `${providerId}/${modelId}`,
    name: `${provider?.name}/${modelId}`,
  }))
  /** Kilo ships its own catalog; the default it reports is never one of our route models. */
  const ownCatalogDefault = 'kilo/google/gemini-3-pro-image'
  const isRouteModel = (value) => availableModels.some((entry) => entry.value === value)
  return {
    providerId,
    availableModels,
    ownCatalogDefault,
    configOptions: (currentModelId) => {
      const options = [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: currentModelId,
          options: [{ value: ownCatalogDefault, name: ownCatalogDefault }, ...availableModels],
        },
      ]
      // Measured on 7.8.8: while the CLI's own default model is selected the option is
      // advertised with a single `thinking` value; once a route model is selected the whole
      // option disappears and only `model` and `mode` remain.
      if (!isRouteModel(currentModelId))
        options.push({
          id: 'effort',
          name: 'Effort',
          description: 'Available effort levels for this model',
          category: 'thought_level',
          type: 'select',
          currentValue: 'thinking',
          options: [{ value: 'thinking', name: 'Thinking' }],
        })
      options.push({
        id: 'mode',
        name: 'Session Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'code',
        options: ['code', 'ask', 'debug', 'orchestrator', 'plan'].map((value) => ({
          value,
          name: value,
        })),
      })
      return options
    },
  }
}

const config = loadConfig()
const sessions = new Map()
/** Prompt requests parked on a human permission decision, keyed by our own request id. */
const pending = new Map()
let counter = 0

createInterface({ input: process.stdin }).on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }
  const { id, method, params } = message

  // A response to a permission request we sent: no `method`, an `id`, and a result.
  if (method === undefined && id !== undefined && message.result !== undefined) {
    const parked = pending.get(id)
    record({ event: 'permission.settled', id, result: message.result })
    if (!parked) return
    pending.delete(id)
    const selected = message.result?.outcome?.optionId
    if (selected === 'reject' || selected === undefined) {
      send({
        method: 'session/update',
        params: {
          sessionId: parked.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call_1',
            status: 'failed',
            content: [
              { type: 'content', content: { type: 'text', text: 'permission denied by client' } },
            ],
          },
        },
      })
      reply(parked.promptId, { stopReason: 'refusal' })
      return
    }
    send({
      method: 'session/update',
      params: {
        sessionId: parked.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
        },
      },
    })
    reply(parked.promptId, { stopReason: 'end_turn' })
    return
  }

  record({ method, params })

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: { embeddedContext: true, image: true },
        sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
      },
      agentInfo: { name: 'Kilo', version: '7.8.8' },
      authMethods: [
        { id: 'kilo-login', name: 'Login with Kilo', description: 'Run `kilo auth login`' },
      ],
    })
    return
  }

  if (method === 'session/new') {
    counter += 1
    const sessionId = `ses_fixture_${counter}`
    sessions.set(sessionId, { model: config.ownCatalogDefault, cancelled: false })
    reply(id, { sessionId, configOptions: config.configOptions(config.ownCatalogDefault) })
    return
  }

  if (method === 'session/load') {
    const session = sessions.get(params?.sessionId)
    if (!session) return fail(id, -32602, 'unknown session')
    // Measured behaviour of the pinned release: a restored session comes back on the CLI's
    // own default model, not on the one pinned before the restart.
    if (loadResetsModel) session.model = config.ownCatalogDefault
    reply(id, { configOptions: config.configOptions(session.model) })
    return
  }

  if (method === 'session/set_config_option') {
    if (rejectSet) return fail(id, -32602, 'unknown config option')
    const session = sessions.get(params?.sessionId)
    if (!session) return fail(id, -32602, 'unknown session')
    if (params.configId === 'effort') {
      // Measured on 7.8.8: the effort option is advertised but never writable.
      return fail(id, -32602, 'Invalid params: effort not found')
    }
    if (params.configId === 'model') {
      // Measured on 7.8.8: a value outside the advertisement is refused and the session
      // keeps the model it had.
      if (!config.availableModels.some((entry) => entry.value === params.value))
        return fail(id, -32602, 'Invalid params: model not found')
      session.model = params.value
      reply(id, {
        configOptions: config.configOptions(drift ? config.ownCatalogDefault : session.model),
      })
      return
    }
    reply(id, { configOptions: config.configOptions(session.model) })
    return
  }

  if (method === 'session/cancel') {
    if (cancelUnsupported) return fail(id, -32601, '"Method not found": session/cancel')
    const session = sessions.get(params?.sessionId)
    if (session) session.cancelled = true
    reply(id, {})
    return
  }

  if (method === 'session/list') {
    reply(id, { sessions: [...sessions.keys()].map((sessionId) => ({ sessionId })) })
    return
  }

  if (method === 'session/close') {
    sessions.delete(params?.sessionId)
    reply(id, {})
    return
  }

  if (method === 'session/prompt') {
    const session = sessions.get(params?.sessionId)
    if (!session) return fail(id, -32602, 'unknown session')
    if (askPermission) {
      // The client must answer this request; the turn is not complete until it does.
      const requestId = `perm_${counter}`
      pending.set(requestId, { promptId: id, sessionId: params.sessionId })
      send({
        id: requestId,
        method: 'session/request_permission',
        params: {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'call_1', title: 'bash' },
          options: [
            { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      })
      return
    }
    send({
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_1',
          title: 'bash',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'echo probe' },
        },
      },
    })
    send({
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
        },
      },
    })
    reply(id, { stopReason: 'end_turn' })
    return
  }

  fail(id, -32601, `"Method not found": ${method}`)
})

// stdin EOF must leave the process to exit cleanly, as the pinned CLI does.
process.stdout.write('')
