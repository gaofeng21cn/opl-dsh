/**
 * Executable ACP agent fixture for the OpenCode adaptation tests.
 *
 * It speaks the subset of the official protocol this adapter relies on and — most
 * importantly — derives its model advertisement from the launch configuration the adapter
 * actually produced (`OPENCODE_CONFIG_CONTENT`), the same way the official CLI merges
 * that variable. A test therefore cannot pass by matching the adapter's own constants: if
 * the adapter wrote a different provider id, model id, namespace, or shape, the advertised
 * values change and the pinning checks fail.
 *
 * The advertisement shape mirrors what the pinned `opencode-ai@1.19.0` binary was
 * observed to send: a `model` select whose values are `provider/model`, and a `mode`
 * select with `build`/`plan`.
 *
 * Every inbound request is appended to `OPENCODE_JOURNAL` so assertions cover the real
 * wire method names, order, and parameters rather than in-process calls.
 */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const journal = process.env.OPENCODE_JOURNAL
/** When set, the reported value drifts away from the one that was just written. */
const drift = process.env.OPENCODE_DRIFT_AFTER_SET === '1'
/** When set, the agent refuses every config write, as a CLI without the option would. */
const rejectSet = process.env.OPENCODE_REJECT_SET === '1'
/** When set, `session/load` reports the CLI's own default model, as the real one does. */
const loadResetsModel = process.env.OPENCODE_LOAD_RESETS_MODEL === '1'
/** When set, the prompt asks the client for permission before doing any work. */
const askPermission = process.env.OPENCODE_ASK_PERMISSION === '1'
/** When set, `session/cancel` answers -32601, as the pinned CLI does. */
const cancelUnsupported = process.env.OPENCODE_CANCEL_UNSUPPORTED === '1'

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
    parsed = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}')
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
  return {
    providerId,
    models: availableModels,
    /** The default the pinned CLI reports before any pin: not one of ours. */
    defaultModelId: 'opencode/official-default',
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
        options: [
          { value: 'build', name: 'build' },
          { value: 'plan', name: 'plan' },
        ],
      },
    ],
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
    if (selected === 'reject') {
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
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, list: {} } },
      agentInfo: { name: 'OpenCode', version: '1.19.0' },
      authMethods: [{ id: 'opencode-login', name: 'Login with opencode', description: '' }],
    })
    return
  }

  if (method === 'session/new') {
    counter += 1
    const sessionId = `ses_fixture_${counter}`
    sessions.set(sessionId, { model: config.defaultModelId, cancelled: false })
    reply(id, { sessionId, configOptions: config.configOptions(config.defaultModelId) })
    return
  }

  if (method === 'session/load') {
    const session = sessions.get(params?.sessionId)
    if (!session) return fail(id, -32602, 'unknown session')
    // Measured behaviour of the pinned release: a restored session comes back on the
    // CLI's own default model, not on the one pinned before the restart.
    if (loadResetsModel) session.model = config.defaultModelId
    reply(id, { configOptions: config.configOptions(session.model) })
    return
  }

  if (method === 'session/set_config_option') {
    if (rejectSet) return fail(id, -32602, 'unknown config option')
    const session = sessions.get(params?.sessionId)
    if (!session) return fail(id, -32602, 'unknown session')
    if (params.configId === 'model') {
      session.model = params.value
      reply(id, {
        configOptions: config.configOptions(drift ? 'opencode/official-default' : session.model),
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
    const text = (params.prompt ?? []).map((part) => part?.text ?? '').join('\n')
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
          content: [{ type: 'content', content: { type: 'text', text: text ? 'ok' : 'ok' } }],
        },
      },
    })
    reply(id, { stopReason: 'end_turn' })
    return
  }

  fail(id, -32601, `"Method not found": ${method}`)
})

// The pinned CLI reports `OpenCode 1.19.0`; keep the fixture's identity identical so
// diagnostics that name the inspected version behave the same.
process.stdout.write('')
