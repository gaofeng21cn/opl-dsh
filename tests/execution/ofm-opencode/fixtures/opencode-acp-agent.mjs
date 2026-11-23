/**
 * Executable ACP agent fixture for the OpenCode adaptation tests.
 */
import {
  createAcpStub,
  loadProviderRouteConfig,
  settleToolPermission,
} from '../../../fixtures/acp-stub-base.mjs'

const stub = createAcpStub({
  journalPath: process.env.OPENCODE_JOURNAL,
  exitOnClose: false,
})
const drift = process.env.OPENCODE_DRIFT_AFTER_SET === '1'
const rejectSet = process.env.OPENCODE_REJECT_SET === '1'
const loadResetsModel = process.env.OPENCODE_LOAD_RESETS_MODEL === '1'
const askPermission = process.env.OPENCODE_ASK_PERMISSION === '1'
const cancelUnsupported = process.env.OPENCODE_CANCEL_UNSUPPORTED === '1'

function loadConfig() {
  const { providerId, availableModels } = loadProviderRouteConfig('OPENCODE_CONFIG_CONTENT')
  return {
    providerId,
    models: availableModels,
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
const pending = new Map()
let counter = 0

stub.start((message) => {
  const { id, method, params } = message
  if (method === undefined && id !== undefined && message.result !== undefined)
    return settleToolPermission(stub, pending, message, { rejectOnUndefined: false })

  stub.record({ method, params })

  if (method === 'initialize')
    return stub.reply(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, list: {} } },
      agentInfo: { name: 'OpenCode', version: '1.19.0' },
      authMethods: [{ id: 'opencode-login', name: 'Login with opencode', description: '' }],
    })

  if (method === 'session/new') {
    counter += 1
    const sessionId = `ses_fixture_${counter}`
    sessions.set(sessionId, { model: config.defaultModelId, cancelled: false })
    return stub.reply(id, { sessionId, configOptions: config.configOptions(config.defaultModelId) })
  }

  if (method === 'session/load') {
    const session = sessions.get(params?.sessionId)
    if (!session) return stub.fail(id, -32602, 'unknown session')
    if (loadResetsModel) session.model = config.defaultModelId
    return stub.reply(id, { configOptions: config.configOptions(session.model) })
  }

  if (method === 'session/set_config_option') {
    if (rejectSet) return stub.fail(id, -32602, 'unknown config option')
    const session = sessions.get(params?.sessionId)
    if (!session) return stub.fail(id, -32602, 'unknown session')
    if (params.configId === 'model') {
      session.model = params.value
      return stub.reply(id, {
        configOptions: config.configOptions(drift ? 'opencode/official-default' : session.model),
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
    const text = (params.prompt ?? []).map((part) => part?.text ?? '').join('\n')
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
      content: [{ type: 'content', content: { type: 'text', text: text ? 'ok' : 'ok' } }],
    })
    return stub.reply(id, { stopReason: 'end_turn' })
  }

  stub.fail(id, -32601, `"Method not found": ${method}`)
})

process.stdout.write('')
