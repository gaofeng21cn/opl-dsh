/**
 * A Node ACP agent that asks exactly one structured permission question.
 *
 * This fixture exists only to drive the real ACP transport, the real harness
 * connection record and the real `approval/request` waterfall from a test. It
 * speaks the same newline-delimited JSON-RPC ACP the production bridge speaks,
 * and it declares the ask's structured facts the way the OPL ZCode bridge does:
 * the tool name in the ACP `_meta` extension slot, the parameters in
 * `rawInput`, and a stable `toolCallId`. Nothing here is evidence about the real
 * ZCode CLI, its model or its account.
 */
import { createInterface } from 'node:readline'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

let sessionId = 'structured-native'
let running
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const answer = (id, result) => send({ id, result })
const chunk = (text) =>
  send({
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  })

let effort = 'high'
const configOptions = () => [
  {
    id: 'reasoning_effort',
    type: 'select',
    name: 'Reasoning Effort',
    currentValue: effort,
    options: ['high', 'max'].map((value) => ({ value, name: value })),
  },
]

createInterface({ input: process.stdin }).on('line', async (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.method === 'initialize')
    return answer(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } })
  if (m.method === 'session/new' || m.method === 'session/load') {
    sessionId = m.params.sessionId ?? 'structured-native'
    return answer(m.id, {
      sessionId,
      models: { currentModelId: process.env.OPL_FIXTURE_MODEL ?? 'grok-4.7' },
      configOptions: configOptions(),
    })
  }
  if (m.method === 'session/set_config_option') {
    if (m.params.configId !== 'reasoning_effort' || !['high', 'max'].includes(m.params.value))
      return send({ id: m.id, error: { code: -32602, message: 'Unsupported effort' } })
    effort = m.params.value
    return answer(m.id, { configOptions: configOptions() })
  }
  if (m.method === 'session/cancel') {
    if (running !== undefined) answer(running, { stopReason: 'cancelled' })
    running = undefined
    return
  }
  if (m.method === 'session/prompt') {
    running = m.id
    send({
      id: 'permission-structured',
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: {
          toolCallId: 'permission-structured',
          title: 'ZCode · bash\nwrite controlled.txt',
          kind: 'other',
          rawInput: { command: 'printf approved > controlled.txt' },
          _meta: { 'opl/toolName': 'bash' },
        },
        options: [
          { optionId: 'yes', kind: 'allow_once', name: 'Allow' },
          { optionId: 'no', kind: 'reject_once', name: 'Deny' },
        ],
      },
    })
    return
  }
  if (m.id === 'permission-structured') {
    const optionId = m.result?.outcome?.optionId
    if (optionId === 'yes') {
      await writeFile(join(process.cwd(), 'controlled.txt'), 'approved')
      chunk('written')
    } else {
      chunk('denied')
    }
    if (running !== undefined) {
      answer(running, { stopReason: 'end_turn' })
      running = undefined
    }
  }
})
