/**
 * ACP agent fixture that publishes the routing it was actually launched with.
 */
import { join } from 'node:path'
import { createAcpStub } from './acp-stub-base.mjs'

const stub = createAcpStub({
  journalPath: join(process.cwd(), 'proxy-acp.log'),
  asyncJournal: true,
})
const PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]
const routing = (value) => {
  try {
    return new URL(value).origin
  } catch {
    return /^[\w.,:*\-\[\]\/ ]{0,512}$/.test(value) ? value : '[redacted]'
  }
}
const proxyEnvironment = () => {
  const seen = {}
  for (const key of PROXY_KEYS) {
    const value = process.env[key]
    if (value !== undefined) seen[key] = routing(value)
  }
  return seen
}
const record = (event) => stub.record({ pid: process.pid, ...event })

let sessionId = 'proxy-unset'
let loaded = false
let running
let effort = 'high'
const model = process.env.OPL_FIXTURE_MODEL
const configOptions = () => [
  {
    id: 'reasoning_effort',
    type: 'select',
    name: 'Reasoning Effort',
    currentValue: effort,
    options: ['low', 'medium', 'high', 'xhigh'].map((value) => ({ value, name: value })),
  },
]
const selfReport = () => ({
  pid: process.pid,
  proxy: proxyEnvironment(),
  model: model ?? null,
  session: { sessionId, method: loaded ? 'session/load' : 'session/new', loadSession: true },
})

stub.start(async (m) => {
  if (m.method?.startsWith('_x.ai/rewind/')) return stub.fail(m.id, -32601, 'unsupported fixture')
  if (m.method === 'initialize') {
    await record({ event: 'initialize', loadSession: true })
    stub.reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } })
  } else if (m.method === 'session/new' || m.method === 'session/load') {
    loaded = m.method === 'session/load'
    sessionId = loaded ? m.params.sessionId : `proxy-${process.pid}`
    await record({
      event: 'session',
      method: m.method,
      requested: m.params.sessionId ?? null,
      sessionId,
      proxy: proxyEnvironment(),
    })
    stub.reply(m.id, {
      sessionId,
      ...(model ? { models: { currentModelId: model } } : {}),
      configOptions: configOptions(),
    })
  } else if (m.method === 'session/set_config_option') {
    if (
      m.params.configId !== 'reasoning_effort' ||
      !['low', 'medium', 'high', 'xhigh'].includes(m.params.value)
    )
      return stub.fail(m.id, -32602, 'Unsupported effort')
    effort = m.params.value
    stub.reply(m.id, { configOptions: configOptions() })
  } else if (m.method === 'session/prompt') {
    running = m.id
    const text = m.params.prompt[0].text
    await record({ event: 'prompt', text, sessionId })
    if (text === 'hold') return
    const report = selfReport()
    stub.chunk(sessionId, 'report:' + JSON.stringify(report))
    stub.update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'proxy-report',
      title: 'Report launch routing',
      kind: 'other',
      status: 'completed',
      rawInput: {},
      rawOutput: report,
    })
    stub.reply(m.id, { stopReason: 'end_turn' })
    running = undefined
  } else if (m.method === 'session/cancel') {
    await record({ event: 'cancel', sessionId })
    if (running) stub.reply(running, { stopReason: 'cancelled' })
    running = undefined
  }
})
