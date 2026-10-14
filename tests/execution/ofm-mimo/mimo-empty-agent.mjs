/**
 * Executable ACP agent fixture for MiMo Code's empty-`end_turn` projection.
 *
 * Official MiMo Code 0.1.15 builds its `session/prompt` result from the SDK reply
 * without inspecting the assistant message's error, so a request the model never
 * answered still comes back as `end_turn` with zero usage, no body and no tool.
 * Only `available_commands_update` and `usage_update` are emitted. This fixture
 * reproduces that wire shape exactly, so the suite's completion rule is exercised
 * against the real failure rather than against a stripped-down stand-in.
 *
 * Like `mimo-acp-agent.mjs`, the model advertisement is derived from the launch
 * configuration the adapter actually produced (`MIMOCODE_CONFIG_CONTENT`), so a
 * test cannot pass by matching the adapter's own constants: a wrong provider id,
 * model id or config shape changes what is advertised and fails the pinning
 * checks before any prompt is sent.
 *
 * The turn's shape is chosen by the prompt text, so one process serves every case
 * the adjudication rule has to distinguish:
 *
 *   empty-turn      no body, no tool — the defect this suite refuses
 *   think-only      reasoning chunks only, which are not body
 *   body-only       body text and nothing else
 *   tool-completed  one completed tool and no body
 *   tool-failed     one failed tool and no body
 *   hold            answers only after `session/cancel`, as cancelled
 */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const journal = process.env.MIMO_JOURNAL
const record = (entry) => {
  if (journal) appendFileSync(journal, JSON.stringify(entry) + '\n')
}

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const reply = (id, result) => send({ id, result })
const fail = (id, code, message) => send({ id, error: { code, message } })

/** Build the advertisement from the configuration the adapter really wrote. */
function loadConfig() {
  let parsed = {}
  try {
    parsed = JSON.parse(process.env.MIMOCODE_CONFIG_CONTENT || '{}')
  } catch {
    parsed = {}
  }
  const providerId = Object.keys(parsed.provider ?? {})[0]
  const provider = providerId ? parsed.provider[providerId] : undefined
  const availableModels = provider
    ? Object.keys(provider.models ?? {}).map((modelId) => ({
        value: `${providerId}/${modelId}`,
        name: `${provider?.name}/${modelId}`,
      }))
    : []
  const currentModelId = typeof parsed.model === 'string' ? parsed.model : ''
  return {
    availableModels,
    currentModelId,
    configOptions: (model) => [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: model,
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
let sequence = 0

const update = (sessionId, value) =>
  send({ method: 'session/update', params: { sessionId, update: value } })

/** The zero-usage success the official CLI returns for a request it never answered. */
const EMPTY_SUCCESS = {
  stopReason: 'end_turn',
  usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
}

async function prompt(params, id) {
  const session = sessions.get(params.sessionId)
  if (!session) return fail(id, -32602, 'Unknown session')
  const text = params.prompt?.[0]?.text ?? ''
  record({ method: 'session/prompt', params: { sessionId: params.sessionId, text } })

  if (text === 'hold') {
    await new Promise((done) => {
      session.release = done
    })
    return reply(id, { stopReason: 'cancelled' })
  }

  if (text === 'empty-turn') {
    // Exactly what 0.1.15 emits for a controlled 400 and 429: no content update.
    update(params.sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [] })
    update(params.sessionId, { sessionUpdate: 'usage_update', usage: { totalTokens: 0 } })
    record({ event: 'empty-success' })
    return reply(id, EMPTY_SUCCESS)
  }
  if (text === 'think-only')
    update(params.sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '正在考虑这条请求。' },
    })
  if (text === 'body-only')
    update(params.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '这是正文。' },
    })
  if (text === 'tool-completed' || text === 'tool-failed')
    update(params.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: text === 'tool-completed' ? '读取文件' : '写入文件',
      kind: 'execute',
      status: text === 'tool-completed' ? 'completed' : 'failed',
    })
  record({ event: 'turn.settled', text })

  if (aborted.has(params.sessionId)) return reply(id, { stopReason: 'cancelled' })
  return reply(id, EMPTY_SUCCESS)
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
      agentInfo: { name: 'OpenCode', version: process.env.MIMO_FAKE_VERSION || '0.1.15' },
    })
  },
  'session/new': (params, id) => {
    const sid = `mimo-empty-${++sequence}`
    sessions.set(sid, { currentModelId: config.currentModelId })
    record({ method: 'session/new', params: { cwd: params.cwd } })
    reply(id, { sessionId: sid, configOptions: config.configOptions(config.currentModelId) })
  },
  'session/load': (params, id) => {
    const sid = `mimo-empty-${++sequence}`
    sessions.set(sid, { currentModelId: config.currentModelId, restored: params.sessionId })
    record({ method: 'session/load', params: { cwd: params.cwd, sessionId: params.sessionId } })
    reply(id, { sessionId: sid, configOptions: config.configOptions(config.currentModelId) })
  },
  'session/set_config_option': (params, id) => {
    const session = sessions.get(params.sessionId)
    if (!session) return fail(id, -32602, 'Unknown session')
    record({ method: 'session/set_config_option', params })
    if (params.configId !== 'model')
      return fail(id, -32602, `Unsupported config option: ${params.configId}`)
    if (!config.availableModels.some((model) => model.value === params.value))
      return fail(id, -32602, 'Model not offered by this configuration')
    session.currentModelId = params.value
    reply(id, { configOptions: config.configOptions(session.currentModelId) })
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
    if (message.id === undefined && message.method === 'session/cancel') {
      record({ method: message.method, params: message.params })
      aborted.add(message.params.sessionId)
      sessions.get(message.params.sessionId)?.release?.()
      return
    }
    const handler = handlers[message.method]
    if (!handler) {
      if (message.id !== undefined)
        fail(message.id, -32601, `Unsupported method: ${message.method}`)
      return
    }
    void handler(message.params, message.id)
  })
  .on('close', () => process.exit(0))

record({ event: 'spawn', argv: process.argv.slice(2), cwd: process.cwd() })
