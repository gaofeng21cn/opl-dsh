/**
 * Executable ACP agent fixture for MiMo Code's empty-`end_turn` projection.
 */
import { createAcpStub, loadProviderRouteConfig } from '../../fixtures/acp-stub-base.mjs'

const stub = createAcpStub({ journalPath: process.env.MIMO_JOURNAL })

function loadConfig() {
  const { availableModels, currentModelId } = loadProviderRouteConfig('MIMOCODE_CONFIG_CONTENT')
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

const EMPTY_SUCCESS = {
  stopReason: 'end_turn',
  usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
}

async function prompt(params, id) {
  const session = sessions.get(params.sessionId)
  if (!session) return stub.fail(id, -32602, 'Unknown session')
  const text = params.prompt?.[0]?.text ?? ''
  stub.record({ method: 'session/prompt', params: { sessionId: params.sessionId, text } })

  if (text === 'hold') {
    await new Promise((done) => {
      session.release = done
    })
    return stub.reply(id, { stopReason: 'cancelled' })
  }

  if (text === 'empty-turn') {
    stub.update(params.sessionId, {
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
    })
    stub.update(params.sessionId, { sessionUpdate: 'usage_update', usage: { totalTokens: 0 } })
    stub.record({ event: 'empty-success' })
    return stub.reply(id, EMPTY_SUCCESS)
  }
  if (text === 'think-only')
    stub.update(params.sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '正在考虑这条请求。' },
    })
  if (text === 'body-only') stub.chunk(params.sessionId, '这是正文。')
  if (text === 'tool-completed' || text === 'tool-failed')
    stub.update(params.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: text === 'tool-completed' ? '读取文件' : '写入文件',
      kind: 'execute',
      status: text === 'tool-completed' ? 'completed' : 'failed',
    })
  stub.record({ event: 'turn.settled', text })

  if (aborted.has(params.sessionId)) return stub.reply(id, { stopReason: 'cancelled' })
  return stub.reply(id, EMPTY_SUCCESS)
}

const handlers = {
  initialize: (params, id) => {
    stub.record({ method: 'initialize', params })
    stub.reply(id, {
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
    stub.record({ method: 'session/new', params: { cwd: params.cwd } })
    stub.reply(id, { sessionId: sid, configOptions: config.configOptions(config.currentModelId) })
  },
  'session/load': (params, id) => {
    const sid = `mimo-empty-${++sequence}`
    sessions.set(sid, { currentModelId: config.currentModelId, restored: params.sessionId })
    stub.record({
      method: 'session/load',
      params: { cwd: params.cwd, sessionId: params.sessionId },
    })
    stub.reply(id, { sessionId: sid, configOptions: config.configOptions(config.currentModelId) })
  },
  'session/set_config_option': (params, id) => {
    const session = sessions.get(params.sessionId)
    if (!session) return stub.fail(id, -32602, 'Unknown session')
    stub.record({ method: 'session/set_config_option', params })
    if (params.configId !== 'model')
      return stub.fail(id, -32602, `Unsupported config option: ${params.configId}`)
    if (!config.availableModels.some((model) => model.value === params.value))
      return stub.fail(id, -32602, 'Model not offered by this configuration')
    session.currentModelId = params.value
    stub.reply(id, { configOptions: config.configOptions(session.currentModelId) })
  },
  'session/prompt': prompt,
}

stub.start((message) => {
  if (message.id === undefined && message.method === 'session/cancel') {
    stub.record({ method: message.method, params: message.params })
    aborted.add(message.params.sessionId)
    sessions.get(message.params.sessionId)?.release?.()
    return
  }
  const handler = handlers[message.method]
  if (!handler) {
    if (message.id !== undefined)
      stub.fail(message.id, -32601, `Unsupported method: ${message.method}`)
    return
  }
  void handler(message.params, message.id)
})

stub.record({ event: 'spawn', argv: process.argv.slice(2), cwd: process.cwd() })
