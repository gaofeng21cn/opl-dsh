/**
 * ACP agent fixture that publishes the routing it was actually launched with.
 *
 * Proxy configuration is only observable from inside the child: the suite rewrites the
 * launch environment immediately before the ACP process starts, so no host-side value can
 * prove which process received which routing. This agent therefore reports its own pid,
 * its proxy environment and the session method it served, both as a turn tool result and as
 * an append-only record in its working directory. The record outlives the process, so a
 * later process can be told apart from the one it replaced.
 *
 * Only routing variables are reported and every URL is reduced to its origin, so no
 * credential can reach a turn transcript, the log file or this fixture. `tests/fixtures/
 * acp-agent.mjs` covers the general transport and is deliberately left untouched.
 */
import { createInterface } from 'node:readline'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

const LOG = join(process.cwd(), 'proxy-acp.log')
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
/** Report a routing value with any embedded userinfo removed. */
const routing = (value) => {
  try {
    return new URL(value).origin
  } catch {
    // NO_PROXY-style lists are not URLs; keep only plainly safe text.
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
const record = (event) => appendFile(LOG, JSON.stringify({ pid: process.pid, ...event }) + '\n')

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
const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\n')
const answer = (id, r) => send({ id, result: r })
const update = (u) => send({ method: 'session/update', params: { sessionId, update: u } })
const chunk = (t) =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } })
/** Everything this process can prove about its own launch. */
const selfReport = () => ({
  pid: process.pid,
  proxy: proxyEnvironment(),
  model: model ?? null,
  session: { sessionId, method: loaded ? 'session/load' : 'session/new', loadSession: true },
})

createInterface({ input: process.stdin })
  .on('line', async (line) => {
    const m = JSON.parse(line)
    if (m.method === 'initialize') {
      await record({ event: 'initialize', loadSession: true })
      answer(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } })
    } else if (m.method === 'session/new' || m.method === 'session/load') {
      loaded = m.method === 'session/load'
      // A restored session keeps the identity the client sent; a fresh one is named after
      // this process, so an unintended new session is visible instead of looking valid.
      sessionId = loaded ? m.params.sessionId : `proxy-${process.pid}`
      await record({
        event: 'session',
        method: m.method,
        requested: m.params.sessionId ?? null,
        sessionId,
        proxy: proxyEnvironment(),
      })
      answer(m.id, {
        sessionId,
        ...(model ? { models: { currentModelId: model } } : {}),
        configOptions: configOptions(),
      })
    } else if (m.method === 'session/set_config_option') {
      if (
        m.params.configId !== 'reasoning_effort' ||
        !['low', 'medium', 'high', 'xhigh'].includes(m.params.value)
      )
        return send({ id: m.id, error: { code: -32602, message: 'Unsupported effort' } })
      effort = m.params.value
      answer(m.id, { configOptions: configOptions() })
    } else if (m.method === 'session/prompt') {
      running = m.id
      const text = m.params.prompt[0].text
      await record({ event: 'prompt', text, sessionId })
      // A held turn never answers, so the caller can observe a live turn while the
      // catalog changes underneath it.
      if (text === 'hold') return
      const report = selfReport()
      chunk('report:' + JSON.stringify(report))
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'proxy-report',
        title: 'Report launch routing',
        kind: 'other',
        status: 'completed',
        rawInput: {},
        rawOutput: report,
      })
      answer(m.id, { stopReason: 'end_turn' })
      running = undefined
    } else if (m.method === 'session/cancel') {
      await record({ event: 'cancel', sessionId })
      if (running) answer(running, { stopReason: 'cancelled' })
      running = undefined
    }
  })
  .on('close', () => process.exit(0))
