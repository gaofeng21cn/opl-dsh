/**
 * Executable ACP fixture reproducing the official MiniMax Code CLI (`mcode` 0.7.4).
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync, watch } from 'node:fs'
import { createAcpStub } from './acp-stub-base.mjs'

const argv = process.argv.slice(2)
const argValue = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const state = argValue('--state', process.env.MCODE_FIXTURE_STATE ?? process.cwd())
const stub = createAcpStub({
  journalPath: join(state, 'journal.ndjson'),
  asyncJournal: true,
  exitOnClose: false,
})
const sessionFile = join(state, 'session.json')
const callsFile = join(state, 'prompts.txt')

const M3_FLASH = 'MiniMax-M3.1-Flash'
const M3 = 'MiniMax-M3'
const ACP_PROVIDER = 'minimax'
const modelValue = (model, variant) =>
  ['m', ACP_PROVIDER, model, 'v', variant].map(encodeURIComponent).join(':')
const M3_FLASH_VALUE = modelValue(M3_FLASH, 'thinking')
const M3_VALUE = modelValue(M3, 'thinking')
const MODEL_VALUES = [
  modelValue(M3_FLASH, ''),
  M3_FLASH_VALUE,
  modelValue(M3, ''),
  M3_VALUE,
  modelValue('MiniMax-M2.7-highspeed', 'thinking'),
  modelValue('MiniMax-M2.7', 'thinking'),
]
const EFFORT_VALUES = ['default', 'low', 'medium', 'high', 'xhigh', 'max']
const capability = argValue('--capability', process.env.MCODE_FIXTURE_CAPABILITY ?? 'full')

let sessionId = 'mvs_fixture'
let model = M3_VALUE
let effort = 'default'
let permissionMode = process.env.MCODE_FIXTURE_PERMISSION ?? 'auto'
let running

const fail = (id, code, message, details) =>
  stub.fail(id, code, message, details ? { details } : undefined)
const note = (entry) => stub.record({ at: Date.now(), region: process.env.MAVIS_REGION, ...entry })

const configOptions = () => {
  const options = [
    {
      type: 'select',
      id: 'permissionMode',
      name: 'Permission mode',
      category: '_permission',
      currentValue: permissionMode,
      options: [
        { value: 'default', name: 'Ask' },
        { value: 'auto', name: 'Auto' },
        { value: 'bypassPermissions', name: 'Full access' },
      ],
    },
  ]
  if (capability === 'no-model-option') return options
  const offered = capability === 'legacy-models' ? [modelValue(M3, ''), M3_VALUE] : MODEL_VALUES
  options.push({
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: offered.includes(model) ? model : offered.at(-1),
    options: offered.map((entry) => ({ value: entry, name: entry })),
  })
  if (model === M3_FLASH_VALUE && capability !== 'no-effort')
    options.push({
      type: 'select',
      id: 'thinkingEffort',
      name: 'Thinking effort',
      category: 'thought_level',
      currentValue: capability === 'wrong-effort' ? 'private-account-diagnostic' : effort,
      options: EFFORT_VALUES.map((entry) => ({ value: entry, name: entry })),
    })
  return options
}

const persist = async () => {
  await mkdir(state, { recursive: true }).catch(() => {})
  await writeFile(sessionFile, JSON.stringify({ sessionId, model, effort }))
}

const restore = async () => {
  const saved = JSON.parse(await readFile(sessionFile, 'utf8').catch(() => '{}'))
  if (saved.sessionId) sessionId = saved.sessionId
  if (saved.model) model = saved.model
  if (saved.effort) effort = saved.effort
}

await restore()

stub.start(async (message) => {
  await note({ method: message.method ?? 'response', id: message.id, params: message.params })
  if (message.method === 'initialize')
    stub.reply(message.id, {
      protocolVersion: 1,
      fixturePid: process.pid,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'minimax-code', title: 'MiniMax Code', version: '0.7.4' },
      ...(process.env.MCODE_SHELL_PATH && capability !== 'no-shell'
        ? {
            _meta: {
              'minimax-code/shell': {
                version: 1,
                type: capability === 'wrong-shell' ? 'powershell' : 'bash',
                shell: process.env.MCODE_SHELL_PATH,
                args: ['-c'],
              },
            },
          }
        : {}),
    })
  else if (message.method === 'session/new' || message.method === 'session/load') {
    await note({ event: message.method })
    if (message.method === 'session/new') {
      model = M3_VALUE
      effort = 'default'
    }
    if (message.params?.sessionId) sessionId = message.params.sessionId
    await persist()
    stub.reply(message.id, {
      sessionId,
      modes: { currentModeId: 'default', availableModes: [] },
      configOptions: configOptions(),
    })
  } else if (message.method === 'session/set_config_option') {
    const { configId, value: requested } = message.params
    if (configId === 'permissionMode') {
      await note({ event: 'permission-mode', value: requested })
      if (!['default', 'auto', 'bypassPermissions'].includes(requested)) {
        fail(message.id, -32602, 'Unsupported permission mode')
        return
      }
      permissionMode = requested
      stub.reply(message.id, { configOptions: configOptions() })
    } else if (configId === 'model') {
      if (existsSync(join(state, 'refuse-config'))) {
        fail(message.id, -32603, 'private-account-diagnostic', 'private-account-diagnostic')
      } else if (requested === modelValue(M3_FLASH, '')) {
        fail(message.id, -32603, 'Internal error', 'Invalid model reasoning')
      } else if (capability === 'legacy-models' && requested !== M3_VALUE) {
        fail(message.id, -32602, 'Invalid params: Model selection is not advertised.')
      } else if (!MODEL_VALUES.includes(requested)) {
        fail(message.id, -32602, 'Invalid params: Model selection is not advertised.')
      } else {
        model = requested
        if (requested !== M3_FLASH_VALUE) effort = 'default'
        await persist()
        await note({ event: 'config', configId, current: model })
        stub.reply(message.id, { configOptions: configOptions() })
      }
    } else if (configId === 'thinkingEffort') {
      if (capability === 'refuse-effort')
        fail(message.id, -32603, 'private-account-diagnostic', 'private-account-diagnostic')
      else if (model !== M3_FLASH_VALUE || capability === 'no-effort')
        fail(
          message.id,
          -32602,
          `Invalid params: Thinking effort is not advertised for the selected model: ${requested}`,
        )
      else if (!EFFORT_VALUES.includes(requested)) fail(message.id, -32602, 'Invalid params')
      else {
        effort = requested
        await persist()
        await note({ event: 'config', configId, current: effort })
        stub.reply(message.id, { configOptions: configOptions() })
      }
    } else fail(message.id, -32602, 'Invalid params: Unsupported configuration option')
  } else if (message.method === 'session/prompt') {
    running = message.id
    await appendFile(callsFile, message.params.prompt[0].text + '\n').catch(() => {})
    const text = message.params.prompt[0].text
    if (text.includes('USAGE_FIXTURE')) {
      const operationId = message.params._meta['opl/clientRequestId']
      const turnId = 'native-' + operationId
      stub.send({
        method: 'opl/session/history/boundary',
        params: {
          sessionId,
          clientRequestId: operationId,
          userMessageId: 'user-' + operationId,
          turnId,
        },
      })
      const row = {
        id: 1,
        turnId,
        model: 'minimax/' + model.split(':')[2],
        inputTokens: 10,
        outputTokens: 3,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        reasoningTokens: 1,
      }
      const params = { version: 1, sessionId, operationId, turnId, rows: [row] }
      for (const change of [
        { sessionId: 'unrelated' },
        { operationId: 'old-operation' },
        { turnId: 'old-turn' },
        { rows: [{ ...row, model: 'minimax/other' }] },
        { version: 99 },
      ])
        stub.send({ method: 'opl/session/usage', params: { ...params, ...change } })
      if (!text.includes('NO_USAGE')) {
        const complete = { ...params, rows: [row, { ...row, id: 2, inputTokens: 5 }] }
        stub.send({ method: 'opl/session/usage', params: complete })
        stub.send({ method: 'opl/session/usage', params: complete })
      }
    }
    if (text.includes('TRANSCRIPT_FIXTURE')) {
      const update = (value) => stub.update(sessionId, value)
      stub.update('unrelated-session', {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'WRONG_SESSION' },
      })
      const live = text.includes('TRANSCRIPT_FIXTURE_LIVE')
      update({
        sessionUpdate: 'session_info_update',
        title: live
          ? 'MiniMax live transcript ' + (text.match(/TITLE_ID=([\w-]+)/)?.[1] ?? 'title')
          : 'MiniMax transcript title',
      })
      update({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Inspecting ' },
      })
      update({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'the repository.' },
      })
      stub.chunk(sessionId, 'Starting check.')
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'transcript-bash',
        title: 'bash',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'printf TRANSCRIPT_OK' },
      })
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'transcript-bash',
        status: 'completed',
        rawOutput: {
          content: [{ type: 'text', text: 'TRANSCRIPT_OK\n' }],
          details: {
            execution: { status: 'succeeded', exitCode: 0 },
            processOutput: { stdout: 'TRANSCRIPT_OK\n', stderr: '', exitCode: 0 },
          },
        },
      })
      update({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: live ? 'Continuing live thought.' : 'The check passed.' },
      })
      if (live) {
        const finish = join(
          process.cwd(),
          text.match(/RELEASE_FILE=([\w-]+)/)?.[1] ?? 'finish-live-transcript',
        )
        await new Promise((resolve) => {
          const observer = watch(process.cwd(), () => {
            if (existsSync(finish)) {
              observer.close()
              resolve()
            }
          })
          if (existsSync(finish)) {
            observer.close()
            resolve()
          }
        })
      }
      stub.chunk(sessionId, 'TRANSCRIPT_DONE')
      stub.reply(message.id, { stopReason: 'end_turn' })
      running = undefined
      return
    }
    if (text === 'wait') return
    if (text === 'approval') {
      stub.send({
        id: 'official-permission',
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { title: 'Controlled tool' },
          options: [
            { optionId: 'yes', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'no', kind: 'reject_once', name: 'Reject once' },
          ],
        },
      })
      return
    }
    stub.chunk(sessionId, 'result:' + text)
    stub.reply(message.id, { stopReason: 'end_turn' })
    running = undefined
  } else if (message.id === 'official-permission') {
    const choice = message.result?.outcome?.optionId
    await note({ event: 'permission-answer', current: choice })
    stub.chunk(sessionId, choice === 'yes' ? 'allowed' : 'denied')
    stub.reply(running, { stopReason: 'end_turn' })
    running = undefined
  } else if (message.method === 'session/cancel') {
    if (running) stub.reply(running, { stopReason: 'cancelled' })
    running = undefined
  }
})
