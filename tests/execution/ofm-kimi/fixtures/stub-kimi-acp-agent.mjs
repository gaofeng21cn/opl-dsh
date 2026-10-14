/**
 * Protocol double for the official Kimi ACP server.
 *
 * It reproduces the wire shape verified against `@moonshot-ai/kimi-code` 2.1.1: the
 * `initialize` capabilities and terminal auth, and the `model` / `thinking` / `mode`
 * config options whose `model` value is the environment alias `__kimi_env_model__`
 * when a route is supplied through `KIMI_MODEL_*`.
 *
 * It executes nothing. It never spawns a shell and never runs git: real shell and git
 * execution is asserted against the official binary itself in
 * `kimi-real-binary.spec.ts`, so no claim here can be satisfied by a fixture.
 */
import { createInterface } from 'node:readline'

const VERSION = process.env.STUB_AGENT_VERSION || '2.1.1'
const ALIAS = '__kimi_env_model__'

const sessions = new Map()
let sequence = 0

const write = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const reply = (id, result) => {
  if (id === undefined) return
  write({ id, result })
}
const fail = (id, code, message) => write({ id, error: { code, message } })

function configOptions(session) {
  const options = [
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
  return options
}

const notify = (sessionId, update) =>
  write({ method: 'session/update', params: { sessionId, update } })

async function handle(method, params, id) {
  if (method === 'initialize') {
    reply(id, {
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
    return
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
    if (method === 'session/load')
      notify(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `restored ${sessionId}` },
      })
    reply(
      id,
      method === 'session/load'
        ? {
            configOptions: configOptions(session),
            modes: {
              availableModes: ['default', 'plan', 'auto', 'yolo'].map((value) => ({
                id: value,
                name: value,
              })),
              currentModeId: session.mode,
            },
          }
        : {
            sessionId,
            configOptions: configOptions(session),
            modes: {
              availableModes: ['default', 'plan', 'auto', 'yolo'].map((value) => ({
                id: value,
                name: value,
              })),
              currentModeId: session.mode,
            },
          },
    )
    return
  }
  if (method === 'session/set_config_option') {
    const session = sessions.get(params.sessionId)
    if (!session) return fail(id, -32602, 'Unknown sessionId')
    if (params.configId === 'model') {
      if (params.value !== ALIAS) return fail(id, -32602, 'Model not found')
      session.model = params.value
    } else if (params.configId === 'thinking') {
      if (!['off', 'on'].includes(params.value)) return fail(id, -32602, 'Unknown thinking value')
      session.thinking = params.value
    } else if (params.configId === 'mode') {
      if (!['default', 'plan', 'auto', 'yolo'].includes(params.value))
        return fail(id, -32602, 'Unknown modeId')
      session.mode = params.value
    } else return fail(id, -32602, `Unknown configId: ${params.configId}`)
    return reply(id, { configOptions: configOptions(session) })
  }
  if (method === 'session/prompt') {
    const session = sessions.get(params.sessionId)
    if (!session) return fail(id, -32602, 'Unknown sessionId')
    const text = params.prompt.map((block) => block?.text ?? '').join('')
    notify(session.id, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: `plan:${text}` },
    })
    // The turn stays open until a `session/cancel` or the test-only `stub/proceed`
    // settles it, so both outcomes are deterministic and nothing polls or sleeps.
    const outcome = await new Promise((settle) => {
      session.settle = settle
    })
    notify(session.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: outcome === 'cancelled' ? 'cancelled' : `cwd=${session.cwd}` },
    })
    return reply(id, { stopReason: outcome === 'cancelled' ? 'cancelled' : 'end_turn' })
  }
  if (method === 'stub/proceed') {
    const session = sessions.get(params.sessionId)
    if (session?.settle) session.settle('end_turn')
    return reply(id, {})
  }
  if (method === 'session/cancel') {
    const session = sessions.get(params.sessionId)
    if (session) {
      session.cancelled = true
      session.settle?.('cancelled')
    }
    return
  }
  if (method === 'session/close') {
    return reply(id, {})
  }
  if (id === undefined) return
  fail(id, -32601, `Unsupported ACP client request: ${method}`)
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.jsonrpc !== '2.0' || !message.method) return
  // `session/cancel` is a notification: no id, and it must still be dispatched.
  if (message.id === undefined) {
    void handle(message.method, message.params ?? {}, undefined)
    return
  }
  if (typeof message.id !== 'number') return
  void handle(message.method, message.params ?? {}, message.id)
})
