/** Isolated Vibe 3.0.4 ACP wire fixture for HarnessService usage accounting. */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAcpStub } from '../../../fixtures/acp-stub-base.mjs'

const args = process.argv.slice(2)
const directory = args[args.indexOf('--state') + 1]
const mode = args[args.indexOf('--mode') + 1]
const stateFile = join(directory, 'session.json')
const stub = createAcpStub({ journalPath: join(directory, 'journal.ndjson') })
const model = 'mistralai/mistral-large-4-1t-a52b'
const alias = 'opl-eac-mistral-large-4'
let state
let heldPrompt
let checkpoint = 0
const replies = new Map()

const save = () => writeFileSync(stateFile, JSON.stringify(state))
const config = () => [
  {
    id: 'model',
    type: 'select',
    currentValue: alias,
    options: [{ value: alias, description: model }],
  },
  {
    id: 'mode',
    type: 'select',
    currentValue: 'auto-approve',
    options: [{ value: 'auto-approve' }],
  },
  { id: 'thinking', type: 'select', currentValue: 'off', options: [{ value: 'off' }] },
]
const snapshot = () => ({ modes: { currentModeId: 'auto-approve' }, configOptions: config() })
const usage = () => ({
  inputTokens: state.input,
  outputTokens: state.output,
  totalTokens: state.input + state.output,
  ...(state.cached ? { cachedReadTokens: state.cached } : {}),
})
const notify = (value, sessionId = state.id) => stub.update(sessionId, value)
const usageUpdate = (used = 120) => ({
  sessionUpdate: 'usage_update',
  used,
  size: 202_144,
  _meta: {
    promptTokens: state.input,
    completionTokens: state.output,
    cachedTokens: state.cached,
    totalTokens: state.input + state.output,
    steps: state.calls,
    lastTurnTotalTokens: 120,
  },
})
const wrongSessionUpdate = () =>
  notify(
    {
      ...usageUpdate(),
      _meta: {
        promptTokens: 999_000,
        completionTokens: 1000,
        cachedTokens: 0,
        totalTokens: 1_000_000,
      },
    },
    'unrelated-session',
  )

async function hostObservedUsage() {
  const id = `checkpoint-${++checkpoint}`
  await new Promise((resolve) => {
    replies.set(id, resolve)
    stub.send({ id, method: 'vibe-fixture/usage-observed', params: {} })
  })
}

async function prompt(params, id) {
  if (params.sessionId !== state.id) throw Error('Unexpected prompt session')
  const text = params.prompt.map((part) => part.text ?? '').join('')
  state.calls += 1
  const partial = text === 'partial-error' || text === 'disconnect' || text === 'cancel'
  const added = partial
    ? { input: 100, output: 20, cached: 20 }
    : state.calls === 1
      ? { input: 200, output: 40, cached: 60 }
      : { input: 300, output: 50, cached: 100 }
  state.input += added.input
  state.output += added.output
  state.cached += added.cached
  save()
  wrongSessionUpdate()
  notify(usageUpdate(mode === 'over-budget' ? 202_145 : 120 + state.calls))
  stub.chunk(state.id, `VIBE_RESULT:${text}`)
  if (text === 'cancel') {
    heldPrompt = id
    await hostObservedUsage()
    return
  }
  if (text === 'disconnect') {
    await hostObservedUsage()
    stub.record({ event: 'exit-after-usage' })
    process.exit(0)
  }
  if (text === 'partial-error') {
    stub.fail(id, -32000, 'fixture provider failed', {
      usage: { inputTokens: 999_000, outputTokens: 1000, totalTokens: 1_000_000 },
    })
    return
  }
  stub.reply(id, { stopReason: 'end_turn', usage: usage() })
}

stub.start((message) => {
  if (!message.method) {
    const resolve = replies.get(message.id)
    replies.delete(message.id)
    resolve?.()
    return
  }
  stub.record({ method: message.method, params: message.params })
  const { id, method, params } = message
  if (method === 'initialize') {
    stub.reply(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: '@mistralai/mistral-vibe', version: '3.0.4' },
    })
  } else if (method === 'session/new' || method === 'session/load') {
    if (method === 'session/new') {
      state = { id: randomUUID(), calls: 0, input: 0, output: 0, cached: 0 }
      save()
    } else {
      state = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (params.sessionId !== state.id) throw Error('Unexpected restored session')
      notify({ sessionUpdate: 'session_info_update', title: 'Vibe restored title' })
    }
    const unknownContext = mode === 'capacity-load' && method === 'session/load'
    if (mode !== 'no-idle' && !unknownContext)
      notify(usageUpdate(state.calls ? 120 + state.calls : 0))
    wrongSessionUpdate()
    stub.record({ event: 'usage-before-session-response', request: method })
    stub.reply(id, {
      ...snapshot(),
      ...(method === 'session/new' ? { sessionId: state.id } : {}),
      ...(unknownContext
        ? { _meta: { 'opl/contextUsage': { size: 202_144, estimated: true } } }
        : {}),
    })
  } else if (method === 'session/set_config_option') {
    if (params.sessionId !== state.id || params.configId !== 'model' || params.value !== alias)
      throw Error('Unexpected model route')
    stub.reply(id, { configOptions: config() })
  } else if (method === 'session/prompt') {
    void prompt(params, id).catch((error) => {
      process.stderr.write(String(error))
      process.exit(1)
    })
  } else if (method === 'session/cancel') {
    if (heldPrompt !== undefined) {
      notify(usageUpdate(120 + state.calls))
      stub.reply(heldPrompt, { stopReason: 'cancelled', usage: usage() })
      heldPrompt = undefined
    }
  } else if (id !== undefined) {
    stub.fail(id, -32601, 'unsupported fixture method')
  }
})

stub.record({ event: 'spawn' })
