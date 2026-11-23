/**
 * Executable ACP agent fixture for the MiMo Code adaptation tests.
 */
import { createAcpStub, loadProviderRouteConfig } from '../../fixtures/acp-stub-base.mjs'

const argv = process.argv.slice(2)
const stub = createAcpStub({ journalPath: process.env.MIMO_JOURNAL })
const drift = process.env.MIMO_DRIFT_AFTER_SET === '1'
const rejectSet = process.env.MIMO_REJECT_SET === '1'
const askPermission = process.env.MIMO_ASK_PERMISSION === '1'

function loadConfig() {
  const { providerId, availableModels, currentModelId } =
    loadProviderRouteConfig('MIMOCODE_CONFIG_CONTENT')
  return {
    providerId,
    models: availableModels,
    currentModelId,
    configOptions: (current) => [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: current,
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
const permissionWaits = new Map()
let sequence = 0
let permissionSequence = 0
const sessionId = () => `mimo-session-${++sequence}`

const snapshot = (currentModelId) => ({
  sessionId: 'session',
  configOptions: config.configOptions(currentModelId),
})

async function prompt(params, id) {
  const session = sessions.get(params.sessionId)
  if (!session) return stub.fail(id, -32602, 'Unknown session')
  stub.record({ method: 'session/prompt', params: { sessionId: params.sessionId } })
  if (askPermission) {
    const askId = `permission-${++permissionSequence}`
    const decision = await new Promise((done) => {
      permissionWaits.set(askId, done)
      stub.send({
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
      stub.record({ event: 'permission.requested' })
    })
    stub.record({ event: 'permission.settled', decision })
    const outcome = decision?.outcome?.outcome === 'selected' ? decision.outcome.optionId : 'reject'
    if (outcome !== 'once') return stub.reply(id, { stopReason: 'refusal' })
  }
  stub.chunk(params.sessionId, 'ok')
  stub.record({ event: 'chunk.sent' })
  if (process.env.MIMO_HOLD === '1') {
    await new Promise((done) => {
      session.release = done
    })
  }
  if (aborted.has(params.sessionId)) return stub.reply(id, { stopReason: 'cancelled' })
  return stub.reply(id, { stopReason: 'end_turn' })
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
    stub.record({ method: 'session/new', params: { cwd: params.cwd } })
    stub.reply(id, { ...snapshot(config.currentModelId), sessionId: sid })
  },
  'session/load': (params, id) => {
    const sid = sessionId()
    sessions.set(sid, {
      currentModelId: config.currentModelId,
      pendingId: 0,
      pendingPermission: null,
      restored: params.sessionId,
    })
    stub.record({
      method: 'session/load',
      params: { cwd: params.cwd, sessionId: params.sessionId },
    })
    stub.reply(id, { ...snapshot(config.currentModelId), sessionId: sid })
  },
  'session/set_config_option': (params, id) => {
    const session = sessions.get(params.sessionId)
    if (!session)
      return stub.fail(
        id,
        -32602,
        `Unknown session: ${JSON.stringify(params.sessionId)} known=${JSON.stringify([...sessions.keys()])}`,
      )
    stub.record({ method: 'session/set_config_option', params })
    if (rejectSet || params.configId !== 'model')
      return stub.fail(id, -32602, `Unsupported config option: ${params.configId}`)
    if (!config.models.some((model) => model.value === params.value))
      return stub.fail(id, -32602, 'Model not offered by this configuration')
    session.currentModelId = params.value
    const reported = drift
      ? (config.models.find((m) => m.value !== params.value)?.value ?? '')
      : session.currentModelId
    stub.reply(id, { configOptions: config.configOptions(reported) })
  },
  'session/prompt': prompt,
}

stub.start((message) => {
  if (message.method === undefined) {
    const waiter = permissionWaits.get(String(message.id))
    if (waiter) {
      permissionWaits.delete(String(message.id))
      waiter(message.result)
    }
    return
  }
  if (message.id === undefined) {
    stub.record({ method: message.method, params: message.params })
    if (message.method === 'session/cancel') {
      aborted.add(message.params.sessionId)
      sessions.get(message.params.sessionId)?.release?.()
    }
    return
  }
  const handler = handlers[message.method]
  if (!handler) return stub.fail(message.id, -32601, `Unsupported method: ${message.method}`)
  void handler(message.params, message.id)
})

stub.record({ event: 'spawn', argv, cwd: process.cwd() })
