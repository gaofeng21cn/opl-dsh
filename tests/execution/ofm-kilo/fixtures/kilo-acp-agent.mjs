/**
 * Executable ACP agent fixture for the Kilo adaptation tests.
 */
import {
  createAcpStub,
  loadProviderRouteConfig,
  settleToolPermission,
} from '../../../fixtures/acp-stub-base.mjs'

const stub = createAcpStub({
  journalPath: process.env.KILO_JOURNAL,
  exitOnClose: false,
})
const drift = process.env.KILO_DRIFT_AFTER_SET === '1'
const rejectSet = process.env.KILO_REJECT_SET === '1'
const loadResetsModel = process.env.KILO_LOAD_RESETS_MODEL === '1'
const askPermission = process.env.KILO_ASK_PERMISSION === '1'
const cancelUnsupported = process.env.KILO_CANCEL_UNSUPPORTED === '1'

function loadConfig() {
  const { providerId, availableModels } = loadProviderRouteConfig('KILO_CONFIG_CONTENT')
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
const pending = new Map()
let counter = 0

stub.start((message) => {
  const { id, method, params } = message
  if (method === undefined && id !== undefined && message.result !== undefined)
    return settleToolPermission(stub, pending, message, { rejectOnUndefined: true })

  stub.record({ method, params })

  if (method === 'initialize')
    return stub.reply(id, {
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

  if (method === 'session/new') {
    counter += 1
    const sessionId = `ses_fixture_${counter}`
    sessions.set(sessionId, { model: config.ownCatalogDefault, cancelled: false })
    return stub.reply(id, {
      sessionId,
      configOptions: config.configOptions(config.ownCatalogDefault),
    })
  }

  if (method === 'session/load') {
    const session = sessions.get(params?.sessionId)
    if (!session) return stub.fail(id, -32602, 'unknown session')
    if (loadResetsModel) session.model = config.ownCatalogDefault
    return stub.reply(id, { configOptions: config.configOptions(session.model) })
  }

  if (method === 'session/set_config_option') {
    if (rejectSet) return stub.fail(id, -32602, 'unknown config option')
    const session = sessions.get(params?.sessionId)
    if (!session) return stub.fail(id, -32602, 'unknown session')
    if (params.configId === 'effort')
      return stub.fail(id, -32602, 'Invalid params: effort not found')
    if (params.configId === 'model') {
      if (!config.availableModels.some((entry) => entry.value === params.value))
        return stub.fail(id, -32602, 'Invalid params: model not found')
      session.model = params.value
      return stub.reply(id, {
        configOptions: config.configOptions(drift ? config.ownCatalogDefault : session.model),
      })
    }
    return stub.reply(id, { configOptions: config.configOptions(session.model) })
  }

  if (method === 'session/cancel') {
    if (cancelUnsupported) return stub.fail(id, -32601, '"Method not found": session/cancel')
    const session = sessions.get(params?.sessionId)
    if (session) session.cancelled = true
    return stub.reply(id, {})
  }

  if (method === 'session/list')
    return stub.reply(id, { sessions: [...sessions.keys()].map((sessionId) => ({ sessionId })) })

  if (method === 'session/close') {
    sessions.delete(params?.sessionId)
    return stub.reply(id, {})
  }

  if (method === 'session/prompt') {
    const session = sessions.get(params?.sessionId)
    if (!session) return stub.fail(id, -32602, 'unknown session')
    if (askPermission) {
      const requestId = `perm_${counter}`
      pending.set(requestId, { promptId: id, sessionId: params.sessionId })
      return stub.send({
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
    }
    stub.update(params.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'bash',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'echo probe' },
    })
    stub.update(params.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
    })
    return stub.reply(id, { stopReason: 'end_turn' })
  }

  stub.fail(id, -32601, `"Method not found": ${method}`)
})

process.stdout.write('')
