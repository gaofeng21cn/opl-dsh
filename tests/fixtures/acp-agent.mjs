import { writeFile, readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAcpStub } from './acp-stub-base.mjs'

const stub = createAcpStub({ exitOnClose: false })
let sessionId = 'test-native'
let running
let completeOnCancel = false
let effort = 'high'
const efforts =
  process.env.OPL_FIXTURE_MODEL === 'glm-5.2' ? ['high', 'max'] : ['low', 'medium', 'high', 'xhigh']
const configOptions = () => [
  {
    id: 'reasoning_effort',
    type: 'select',
    name: 'Reasoning Effort',
    currentValue: effort,
    options: efforts.map((value) => ({ value, name: value })),
  },
]
const approvals = new Map()
const editHistory = []
const editHistoryFile = () =>
  join(
    process.cwd(),
    process.env.OPL_FIXTURE_FRESH_EDIT === '1' ? `edit-${sessionId}.json` : 'edit-history.json',
  )
const persistEditHistory = async () => {
  if (process.env.OPL_FIXTURE_EDIT_PERSIST === '1')
    await writeFile(editHistoryFile(), JSON.stringify(editHistory))
}
const editToken = () => JSON.stringify(editHistory)
const update = (u) => stub.update(sessionId, u)
const chunk = (t) => stub.chunk(sessionId, t)

stub.start(async (m) => {
  if (m.method === 'opl/message-edit/read' || m.method === 'opl/message-edit/rewind') {
    if (process.env.OPL_FIXTURE_EDIT !== '1') return stub.fail(m.id, -32601, 'unsupported fixture')
    if (m.params?.sessionId !== sessionId) return stub.fail(m.id, -32602, 'unknown session')
    if (m.method === 'opl/message-edit/read')
      return stub.reply(m.id, {
        sessionId,
        token: editToken(),
        boundaries: editHistory.map((text, index) => ({ id: String(index), text })),
      })
    if (m.params?.expectedToken !== editToken()) return stub.fail(m.id, -32602, 'stale edit token')
    const index = Number(m.params?.targetId)
    if (!Number.isInteger(index) || index < 0 || index >= editHistory.length)
      return stub.fail(m.id, -32602, 'unknown edit target')
    const retained = Array.from({ length: index }, (_, item) => ({
      previousId: String(item),
      nextId: String(item),
    }))
    editHistory.splice(index)
    await persistEditHistory()
    return stub.reply(m.id, { sessionId, retained })
  }
  if (m.method === 'initialize')
    stub.reply(m.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        ...(process.env.OPL_FIXTURE_EDIT === '1'
          ? {
              _meta: {
                'opl/message-edit': {
                  version: 1,
                  methods: ['opl/message-edit/read', 'opl/message-edit/rewind'],
                },
              },
            }
          : {}),
        ...(process.env.OPL_FIXTURE_IMAGES === '1'
          ? {
              promptCapabilities: {
                image: process.env.OPL_FIXTURE_IMAGE_CAPABILITY !== 'false',
              },
            }
          : {}),
      },
      ...(process.env.OPL_FIXTURE_GROK_VERSION
        ? { _meta: { grokShell: true, agentVersion: process.env.OPL_FIXTURE_GROK_VERSION } }
        : {}),
    })
  else if (m.method === 'session/new' || m.method === 'session/load') {
    await appendFile(join(process.cwd(), 'connections.txt'), m.method + '\n')
    sessionId =
      m.params.sessionId ??
      (process.env.OPL_FIXTURE_FRESH_EDIT === '1' ? randomUUID() : 'test-native')
    if (process.env.OPL_FIXTURE_FRESH_EDIT === '1' && m.method === 'session/new')
      editHistory.length = 0
    if (process.env.OPL_FIXTURE_EDIT_PERSIST === '1') {
      try {
        const saved = JSON.parse(await readFile(editHistoryFile(), 'utf8'))
        editHistory.splice(0, editHistory.length, ...saved)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    await writeFile(
      join(process.cwd(), 'launch.json'),
      JSON.stringify({
        envKey: !!process.env.OPL_GATEWAY_GROK_API_KEY,
        hasCodex: !!process.env.OPL_GATEWAY_CODEX_API_KEY,
        home: process.env.GROK_HOME,
        args: process.argv.slice(2),
      }),
    )
    stub.reply(m.id, {
      sessionId,
      models: { currentModelId: process.env.OPL_FIXTURE_MODEL ?? 'grok-4.7' },
      configOptions: configOptions(),
    })
  } else if (m.method === 'session/set_config_option') {
    if (m.params.configId !== 'reasoning_effort' || !efforts.includes(m.params.value))
      return stub.fail(m.id, -32602, 'Unsupported effort')
    effort = m.params.value
    stub.reply(m.id, { configOptions: configOptions() })
  } else if (m.method === 'session/prompt') {
    running = m.id
    if (process.env.OPL_FIXTURE_IMAGES === '1')
      await appendFile(
        join(process.cwd(), 'image-calls.jsonl'),
        JSON.stringify(m.params.prompt) + '\n',
      )
    await appendFile(join(process.cwd(), 'calls.txt'), m.params.prompt[0].text + '\n')
    const text = m.params.prompt[0].text
    if (
      (['quota', 'quota-recorded'].includes(process.env.OPL_FIXTURE_EDIT_FAILURE) &&
        text === 'user: replacement') ||
      (process.env.OPL_FIXTURE_EDIT_FAILURE === 'ui-quota' && text.includes('EDIT_UI_RATE_LIMIT'))
    ) {
      if (process.env.OPL_FIXTURE_EDIT_FAILURE === 'quota-recorded') {
        editHistory.push(text)
        await persistEditHistory()
      }
      running = undefined
      return stub.fail(m.id, 'HARNESS_PROVIDER_RATE_LIMIT')
    }
    if (process.env.OPL_FIXTURE_EDIT === '1') editHistory.push(text)
    await persistEditHistory()
    if (text.startsWith('以下是先前会话记录'))
      update({
        sessionUpdate: 'session_info_update',
        title: text.replace(/s+/g, ' ').slice(0, 200),
      })
    if (text === 'tool-in-progress-wait') {
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'quiet-tool',
        title: 'Long running tool',
        kind: 'execute',
        status: 'in_progress',
      })
      return
    }
    if (text === 'partial-then-wait') {
      chunk('partial answer')
      return
    }
    if (text === 'wait' || text === 'wait-end-on-cancel') {
      completeOnCancel = text === 'wait-end-on-cancel'
      if (completeOnCancel) chunk('partial answer')
      return
    }
    if (text === 'fail-turn') {
      stub.reply(m.id, { stopReason: 'error' })
      running = undefined
      return
    }
    if (text === 'empty-turn') {
      update({ sessionUpdate: 'available_commands_update', availableCommands: [] })
      update({ sessionUpdate: 'usage_update', usage: { totalTokens: 0 } })
      stub.reply(m.id, {
        stopReason: 'end_turn',
        usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
      })
      running = undefined
      return
    }
    if (text.endsWith('usage-stats')) {
      chunk('usage answer')
      update({ sessionUpdate: 'usage_update', used: 42, size: 100 })
      stub.reply(m.id, {
        stopReason: 'end_turn',
        usage: {
          totalTokens: 42,
          inputTokens: 40,
          outputTokens: 2,
          _meta: { 'opl/usageSemantics': 'per-prompt' },
        },
      })
      running = undefined
      return
    }
    if (text.endsWith('owned-usage')) {
      chunk('owned usage answer')
      stub.reply(m.id, {
        stopReason: 'end_turn',
        _meta: {
          'opl/turnUsage': {
            version: 1,
            usage: {
              inputTokens: 30,
              cacheReadTokens: 10,
              cacheWriteTokens: 5,
              outputTokens: 4,
              reasoningTokens: 2,
              totalTokens: 49,
            },
          },
          'opl/contextUsage': { used: 49, size: 100, estimated: true },
        },
      })
      running = undefined
      return
    }
    if (text.endsWith('usage-cumulative')) {
      chunk('cumulative answer')
      update({ sessionUpdate: 'usage_update', used: 84, size: 100 })
      stub.reply(m.id, {
        stopReason: 'end_turn',
        usage: { totalTokens: 84, inputTokens: 80, outputTokens: 4 },
      })
      running = undefined
      return
    }
    if (
      [
        'thought-only',
        'blank-answer',
        'tool-only-completed',
        'tool-only-failed',
        'tool-only-pending',
      ].includes(text)
    ) {
      if (text === 'thought-only')
        update({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'thinking' },
        })
      else if (text === 'blank-answer') chunk('   \n')
      else
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'one',
          title: 'read',
          kind: 'read',
          status: text.slice('tool-only-'.length),
        })
      stub.reply(m.id, { stopReason: 'end_turn' })
      running = undefined
      return
    }
    if (text === 'allow-write' || text === 'deny-write') {
      approvals.set('permission-string', m.id)
      stub.send({
        id: 'permission-string',
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            title: 'Write controlled.txt',
            rawInput: { command: 'printf approved > controlled.txt' },
          },
          options: [
            { optionId: 'yes', kind: 'allow_once', name: 'Allow' },
            { optionId: 'no', kind: 'reject_once', name: 'Deny' },
          ],
        },
      })
    } else {
      const saved = await readFile(join(process.cwd(), 'memory.txt'), 'utf8').catch(() => '')
      chunk(text === 'recall' ? saved : 'result:' + text)
      if (text !== 'recall') await writeFile(join(process.cwd(), 'memory.txt'), text)
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'read1',
        title: 'Read file',
        kind: 'read',
        status: 'completed',
      })
      stub.reply(m.id, { stopReason: 'end_turn' })
      running = undefined
    }
  } else if (m.method === 'session/cancel') {
    if (running) stub.reply(running, { stopReason: completeOnCancel ? 'end_turn' : 'cancelled' })
    running = undefined
  } else if (m.id === 'permission-string') {
    const id = approvals.get(m.id)
    if (m.result.outcome.optionId === 'yes') {
      await writeFile(join(process.cwd(), 'controlled.txt'), 'approved')
      chunk('written')
    } else chunk('denied')
    stub.reply(id, { stopReason: 'end_turn' })
    running = undefined
  }
})
