// Stub official MSP host used to drive the bridge's failure semantics.
//
// It speaks the same NDJSON MSP surface `muse serve` does, and reproduces the one
// behaviour the bridge must not paper over: `turn/cancel` is refused, and the turn then
// ends with its own terminal. A bridge that resolves the prompt as `cancelled` on the
// strength of having *sent* a cancel is reporting a success the runtime never granted.
//
// The fingerprint is the value the real 1.4.7-R6101.1 host serves, so the bridge's pin
// check passes and the test exercises the paths after it.
//
// Usage: node stub-msp-host.mjs <mode>   with mode: refuse-cancel | ignore-cancel
import { createInterface } from 'node:readline'

const mode = process.argv[2] ?? 'refuse-cancel'
const FINGERPRINT = 'sha256:6de32db08bbbe0deb478d2bfcaba001e9fb490986bc80db3aceb4d996abf7df9'
const SESSION = 'stub-session-1'

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const refuse = (id, code, message, data) =>
  send({ jsonrpc: '2.0', id, error: { code, message, data } })
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })

let turnStarted = false

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
  switch (method) {
    case 'initialize':
      return reply(id, {
        serverInfo: { name: 'muse', version: '1.4.7' },
        platformOs: 'windows',
        schema: { version: 1, fingerprint: FINGERPRINT },
        grantedCapabilities: [],
        sandboxAvailability: 'unavailable',
        museHome: 'C:/stub/muse',
      })
    case 'session/start':
    case 'session/resume':
      return reply(id, { session: { sessionId: SESSION, workspaceRoot: params?.workspaceRoot } })
    case 'session/setModel':
      notify('session/modelChanged', { sessionId: SESSION, modelId: params.model.modelId })
      return reply(id, { commandId: params?.commandId, status: 'accepted' })
    case 'session/setReasoningEffort':
      notify('session/reasoningEffortChanged', {
        sessionId: SESSION,
        reasoningEffort: params.reasoningEffort,
      })
      return reply(id, { commandId: params?.commandId, status: 'accepted' })
    case 'session/read':
      return reply(id, { session: { sessionId: SESSION, modelId: process.env.OPL_MUSE_MODEL } })
    case 'turn/start': {
      turnStarted = true
      reply(id, { turnId: 'stub-turn-1', disposition: 'started' })
      // Stream some assistant text, then end on the official terminal.
      notify('item/started', { sessionId: SESSION, item: { itemId: 'i1', kind: 'agentMessage' } })
      notify('item/delta', { sessionId: SESSION, itemId: 'i1', delta: 'working' })
      setTimeout(
        () => {
          if (!turnStarted) return
          turnStarted = false
          notify('item/completed', {
            sessionId: SESSION,
            item: { itemId: 'i1', kind: 'agentMessage', text: 'working' },
          })
          // Whatever the runtime decided, reported as-is.
          notify('turn/completed', {
            sessionId: SESSION,
            turnId: 'stub-turn-1',
            terminal: mode === 'provider-refusal' ? 'failed' : 'completed',
            ...(mode === 'provider-refusal'
              ? {
                  reason:
                    "server_error: OpenCode's free tier can only be used from within OpenCode. synthetic-private-key",
                }
              : {}),
          })
        },
        Number(process.env.STUB_TURN_MS ?? 1500),
      )
      return
    }
    case 'turn/cancel':
      // The failure the bridge must survive: refused, and the turn carries on.
      if (mode === 'refuse-cancel')
        return refuse(id, -32030, 'turn/cancel rejected: session has no cancellable turn', {
          kind: 'commandRejected',
          retryable: false,
        })
      reply(id, { commandId: params?.commandId, status: 'accepted' })
      return
    default:
      if (id === undefined) return
      return refuse(id, -32601, `Method not found: ${method}`)
  }
})

process.stdin.on('end', () => process.exit(0))
