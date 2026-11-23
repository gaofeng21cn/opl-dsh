/**
 * Protocol double for the official Kimi ACP server.
 */
import { createAcpStub } from '../../../fixtures/acp-stub-base.mjs'

const VERSION = process.env.STUB_AGENT_VERSION || '2.1.1'
const ALIAS = '__kimi_env_model__'
const stub = createAcpStub({ exitOnClose: false })
const sessions = new Map()
let sequence = 0

function configOptions(session) {
  return [
    {
      type: 'select',
      id: 'model',
      category: 'model',
      currentValue: session.model,
      options: [{ value: ALIAS, name: ALIAS }],
    },
    {
      type: 'select',
      id: 'thinking',
      category: 'thought_level',
      currentValue: session.thinking,
      options: ['off', 'on'].map((value) => ({ value, name: `Thinking ${value}` })),
    },
    {
      type: 'select',
      id: 'mode',
      category: 'mode',
      currentValue: session.mode,
      options: ['default', 'plan', 'auto', 'yolo'].map((value) => ({ value, name: value })),
    },
  ]
}

async function handle(method, params, id) {
  if (method === 'initialize') {
    return stub.reply(id, {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
        mcpCapabilities: { http: true, sse: false },
      },
      authMethods: [
        {
          id: 'login',
          type: 'terminal',
          name: 'Login with Kimi account',
          description: 'Open the device-code login flow in a terminal.',
          args: ['--login'],
          env: {},
        },
      ],
      agentInfo: { name: 'Kimi Code CLI', version: VERSION },
    })
  }
  if (method === 'session/new' || method === 'session/load') {
    const sessionId = params.sessionId || `sess-${++sequence}`
    const session = {
      id: sessionId,
      cwd: params.cwd,
      model: ALIAS,
      thinking: 'on',
      mode: 'default',
      settle: undefined,
      cancelled: false,
    }
    sessions.set(sessionId, session)
    if (method === 'session/load') stub.chunk(sessionId, `restored ${sessionId}`)
    const modes = {
      availableModes: ['default', 'plan', 'auto', 'yolo'].map((value) => ({
        id: value,
        name: value,
      })),
      currentModeId: session.mode,
    }
    return stub.reply(
      id,
      method === 'session/load'
        ? { configOptions: configOptions(session), modes }
        : { sessionId, configOptions: configOptions(session), modes },
    )
  }
  if (method === 'session/set_config_option') {
    const session = sessions.get(params.sessionId)
    if (!session) return stub.fail(id, -32602, 'Unknown sessionId')
    if (params.configId === 'model') {
      if (params.value !== ALIAS) return stub.fail(id, -32602, 'Model not found')
      session.model = params.value
    } else if (params.configId === 'thinking') {
      if (!['off', 'on'].includes(params.value))
        return stub.fail(id, -32602, 'Unknown thinking value')
      session.thinking = params.value
    } else if (params.configId === 'mode') {
      if (!['default', 'plan', 'auto', 'yolo'].includes(params.value))
        return stub.fail(id, -32602, 'Unknown modeId')
      session.mode = params.value
    } else return stub.fail(id, -32602, `Unknown configId: ${params.configId}`)
    return stub.reply(id, { configOptions: configOptions(session) })
  }
  if (method === 'session/prompt') {
    const session = sessions.get(params.sessionId)
    if (!session) return stub.fail(id, -32602, 'Unknown sessionId')
    const text = params.prompt.map((block) => block?.text ?? '').join('')
    stub.update(session.id, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: `plan:${text}` },
    })
    const outcome = await new Promise((settle) => {
      session.settle = settle
    })
    stub.chunk(session.id, outcome === 'cancelled' ? 'cancelled' : `cwd=${session.cwd}`)
    return stub.reply(id, { stopReason: outcome === 'cancelled' ? 'cancelled' : 'end_turn' })
  }
  if (method === 'stub/proceed') {
    const session = sessions.get(params.sessionId)
    if (session?.settle) session.settle('end_turn')
    return stub.reply(id, {})
  }
  if (method === 'session/cancel') {
    const session = sessions.get(params.sessionId)
    if (session) {
      session.cancelled = true
      session.settle?.('cancelled')
    }
    return
  }
  if (method === 'session/close') return stub.reply(id, {})
  if (id !== undefined) stub.fail(id, -32601, `Unsupported ACP client request: ${method}`)
}

stub.start((message) => {
  if (message.jsonrpc !== '2.0' || !message.method) return
  if (message.id !== undefined && typeof message.id !== 'number') return
  void handle(message.method, message.params ?? {}, message.id)
})
