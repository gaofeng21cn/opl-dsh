/**
 * Shared JSON-RPC 2.0 stdio transport and provider-config helpers for executable ACP test stubs.
 */
import { appendFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

export function createAcpStub({ journalPath, asyncJournal = false, exitOnClose = true } = {}) {
  const send = (payload) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n')
  const reply = (id, result) => {
    if (id === undefined) return
    send({ id, result })
  }
  const fail = (id, code, message, data) =>
    send({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } })
  const update = (sessionId, value) =>
    send({ method: 'session/update', params: { sessionId, update: value } })
  const chunk = (sessionId, text) =>
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  const record = (entry) => {
    if (!journalPath) return
    const line = JSON.stringify(entry) + '\n'
    if (asyncJournal) return appendFile(journalPath, line).catch(() => {})
    appendFileSync(journalPath, line)
  }

  function start(onMessage) {
    const rl = createInterface({ input: process.stdin }).on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let message
      try {
        message = JSON.parse(trimmed)
      } catch {
        return
      }
      void onMessage(message)
    })
    if (exitOnClose) rl.on('close', () => process.exit(0))
    return rl
  }

  return { send, reply, fail, update, chunk, record, start }
}

export function loadProviderRouteConfig(envName) {
  let parsed = {}
  try {
    parsed = JSON.parse(process.env[envName] || '{}')
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
  const currentModelId = typeof parsed.model === 'string' ? parsed.model : ''
  return { parsed, providerId, provider, modelIds, availableModels, currentModelId }
}

export function settleToolPermission(stub, pending, message, { rejectOnUndefined = false } = {}) {
  const { id, result } = message
  const parked = pending.get(id)
  stub.record({ event: 'permission.settled', id, result })
  if (!parked) return
  pending.delete(id)
  const selected = result?.outcome?.optionId
  const rejected = selected === 'reject' || (rejectOnUndefined && selected === undefined)
  stub.update(parked.sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_1',
    status: rejected ? 'failed' : 'completed',
    content: [
      {
        type: 'content',
        content: { type: 'text', text: rejected ? 'permission denied by client' : 'ok' },
      },
    ],
  })
  stub.reply(parked.promptId, { stopReason: rejected ? 'refusal' : 'end_turn' })
}
