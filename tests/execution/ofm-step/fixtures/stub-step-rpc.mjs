/**
 * Stub of the official StepCode CLI's RPC mode, for the adapter's transport tests.
 *
 * It reproduces the surface and, importantly, the *failure modes* confirmed against the
 * shipped `step.exe` 0.1.4, because those are what the adapter has to defend against:
 *
 * - `models.json` is read from the Step **config root** (`dirname(STEP_CODING_AGENT_DIR)`).
 *   A copy placed inside the agent directory is silently ignored and the model list comes
 *   back empty — the exact behaviour that made the obvious file location look correct.
 * - `set_thinking_level` answers `success: true` for *any* level, including one the model
 *   does not advertise. A successful write therefore proves nothing.
 * - `switch_session` answers `success: true` for a path that does not exist.
 * - `STEP_PERMISSION_PRESET=full-access` raises the session-scoped Full Access dialog and
 *   waits for an `extension_ui_response`.
 * - A turn ends on `agent_settled`; `agent_end` is emitted *before* it, and an
 *   `auto_retry_start`/`auto_retry_end` pair is emitted in between.
 *
 * Unlike a unit fake this is a real process driven through the suite's own ACP transport
 * and the real compiled bridge, and its `bash` tool executes genuine external commands
 * (`git`) through the verified Git Bash in a working directory whose name contains both
 * non-ASCII characters and a space.
 *
 * Model behaviour knobs, for negative tests. They live in `<agentDir>/stub-knobs.json`
 * rather than in the environment, because the bridge forwards an explicit allowlist to
 * the child and a test that relied on a stray variable would silently exercise nothing:
 *   { modelDrift: true,     `get_state` reports a different model than was selected
 *     thinkingEcho: false,  `get_state` never reflects the requested thinking level
 *     pendingTurn: true,    `prompt` never settles until an `abort` arrives
 *     offerEmpty: true,     `set_model` fails: the catalog no longer carries the model }
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const agentDir = process.env.STEP_CODING_AGENT_DIR ?? ''
const configRoot = process.env.STEP_CONFIG_ROOT_OVERRIDE ?? dirname(agentDir)
const sessionDir = process.env.STEP_CODING_AGENT_SESSION_DIR ?? join(agentDir, 'sessions')
const preset = process.env.STEP_PERMISSION_PRESET ?? ''

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

// The official CLI loads providers from the config root, not the agent directory.
const modelsDoc = readJson(join(configRoot, 'models.json')) ?? { providers: {} }
const knobs = readJson(join(agentDir, 'stub-knobs.json')) ?? {}
const settings = readJson(join(agentDir, 'settings.json')) ?? {}
const shell = typeof settings.shellPath === 'string' ? settings.shellPath : ''

/** Flatten `models.json` into the official `{provider}/{id}` catalog. */
const catalog = []
for (const [providerId, provider] of Object.entries(modelsDoc.providers ?? {})) {
  for (const model of provider?.models ?? [])
    catalog.push({
      id: model.id,
      provider: providerId,
      api: provider.api,
      baseUrl: provider.baseUrl,
      reasoning: model.reasoning === true,
      levels:
        model.levels ?? (model.reasoning ? ['off', 'minimal', 'low', 'medium', 'high'] : ['off']),
      contextWindow: model.contextWindow ?? 32768,
    })
}

let sessionId = process.env.STUB_SESSION_ID ?? 'stub-session-0001'
let sessionFile = ''
let model = null
let thinkingLevel = 'off'
let streaming = false
let pending = false
let seq = 0

const write = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const event = (value) => write(value)

/**
 * Record every dialog response the bridge sent, so a test can prove *which* dialogs it
 * answered rather than only that the turn finished.
 */
const recordDialogAnswer = (id, value) => {
  try {
    appendFileSync(
      join(agentDir, 'stub-dialog-answers.jsonl'),
      JSON.stringify({ id, value }) + '\n',
    )
  } catch {
    // Evidence only: a test that cannot read the file still observes the turn outcome.
  }
}

mkdirSync(sessionDir, { recursive: true })
sessionFile = join(sessionDir, `${sessionId}.jsonl`)
if (!existsSync(sessionFile)) writeFileSync(sessionFile, '', 'utf8')

/** Append one user message so a resumed session has real history to replay. */
const appendMessage = (role, text) => {
  writeFileSync(
    sessionFile,
    JSON.stringify({ type: 'message', id: `e-${Date.now()}-${seq++}`, role, content: text }) + '\n',
    { flag: 'a' },
  )
}

const readMessages = () =>
  readFileSync(sessionFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    })
    .filter(Boolean)
    .map((entry) => ({ role: entry.role, content: entry.content }))

/** Run a real external command through the configured shell, as the official tool does. */
const runCommand = (command) =>
  new Promise((resolve) => {
    if (!shell || !existsSync(shell)) {
      resolve({ output: 'NO_SHELL_CONFIGURED', exitCode: 127 })
      return
    }
    const child = spawn(shell, ['-c', command], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: process.env.PATH ?? '' },
      windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', (c) => (output += c.toString()))
    child.stderr.on('data', (c) => (output += c.toString()))
    child.on('error', () => resolve({ output: 'SHELL_SPAWN_FAILED', exitCode: 127 }))
    child.on('close', (code) => resolve({ output, exitCode: code ?? 0 }))
  })

const modelView = (entry) => ({
  id: entry.id,
  name: entry.id,
  api: entry.api,
  provider: entry.provider,
  baseUrl: entry.baseUrl,
  reasoning: entry.reasoning,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: entry.contextWindow,
  maxTokens: 4096,
})

const find = (provider, modelId) =>
  catalog.find((item) => item.provider === provider && item.id === modelId)

const handle = async (message) => {
  const respond = (result) => write({ id: message.id, type: 'response', ...result })

  switch (message.type) {
    case 'get_available_models':
      respond({ command: message.type, success: true, data: { models: catalog.map(modelView) } })
      return
    case 'set_model': {
      const entry = find(message.provider, message.modelId)
      // STUB_OFFER_EMPTY models a provider whose catalog no longer carries the pinned
      // model: the model is withdrawn between the config being written and the launch.
      if (!entry || knobs.offerEmpty === true) {
        respond({
          command: 'set_model',
          success: false,
          error: `Model not found: ${message.provider}/${message.modelId}`,
        })
        return
      }
      model = entry
      respond({ command: 'set_model', success: true, data: modelView(entry) })
      return
    }
    case 'get_state':
      respond({
        command: 'get_state',
        success: true,
        data: {
          // STUB_MODEL_DRIFT makes the live state disagree with the selection, which is
          // how a silent downgrade to a different model would present.
          model: model
            ? modelView(
                knobs.modelDrift === true
                  ? { ...model, id: 'other-live-model', provider: 'other-live-provider' }
                  : model,
              )
            : { id: 'unknown', provider: 'unknown', api: 'unknown', baseUrl: '' },
          thinkingLevel: knobs.thinkingEcho === false ? 'off' : thinkingLevel,
          isStreaming: streaming,
          sessionId,
          sessionFile,
          messageCount: readMessages().length,
          pendingMessageCount: 0,
        },
      })
      return
    case 'get_available_thinking_levels':
      respond({
        command: message.type,
        success: true,
        data: { levels: model ? model.levels : ['off'] },
      })
      return
    case 'set_thinking_level':
      // The official 0.1.4 binary accepts an arbitrary level string. Reproduced so the
      // adapter's read-back is genuinely exercised instead of trusting `success`.
      if (model?.levels.includes(message.level)) thinkingLevel = message.level
      respond({ command: message.type, success: true })
      return
    case 'switch_session':
      // Also answers success for a path that does not exist, as the official binary does.
      if (existsSync(message.sessionPath)) {
        const name = message.sessionPath
          .split(/[\\/]/)
          .pop()
          .replace(/\.jsonl$/, '')
        if (name) sessionId = name
        sessionFile = message.sessionPath
      }
      respond({ command: message.type, success: true, data: { cancelled: false } })
      return
    case 'get_messages':
      respond({ command: message.type, success: true, data: { messages: readMessages() } })
      return
    case 'bash': {
      const result = await runCommand(message.command)
      write({ type: 'bash_execution_update', id: message.id, delta: result.output })
      respond({
        command: 'bash',
        success: true,
        data: { ...result, cancelled: false, truncated: false },
      })
      return
    }
    case 'abort':
      streaming = false
      pending = false
      respond({ command: 'abort', success: true })
      if (streaming) return
      // An aborted turn settles like any other, so the caller can distinguish it by the
      // cancellation it requested.
      event({ type: 'agent_settled' })
      return
    case 'prompt': {
      appendMessage('user', message.message)
      respond({ command: 'prompt', success: true })
      streaming = true
      event({ type: 'agent_start' })
      event({ type: 'turn_start' })
      event({ type: 'message_start', message: { role: 'assistant' } })
      if (knobs.terminalError === true) {
        event({
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: '429 daily limit exceeded',
          },
        })
        event({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [] })
        event({ type: 'agent_end', messages: [], willRetry: true })
        event({
          type: 'auto_retry_start',
          attempt: 1,
          maxAttempts: 1,
          delayMs: 1,
          errorMessage: '429 daily limit exceeded',
        })
        event({ type: 'auto_retry_end', success: false, finalError: '429 daily limit exceeded' })
        event({ type: 'agent_settled' })
        streaming = false
        return
      }
      if (message.message.includes('/think')) {
        event({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '思考中' },
        })
      }
      event({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '收到：' },
      })
      if (knobs.dialogAckDuringTurn === true) {
        // An identical-looking dialog raised while the turn is running. It must be
        // relayed for human approval, never answered by the startup grant.
        void raiseFullAccessDialog('task-ack-1')
      }
      // A real external command through the verified shell, so PATH, quoting and a
      // non-ASCII path with a space are exercised rather than asserted.
      const toolId = 'call_1'
      event({
        type: 'tool_execution_start',
        toolCallId: toolId,
        toolName: 'bash',
        args: { command: 'git rev-parse --show-toplevel' },
      })
      const tool = await runCommand('git rev-parse --show-toplevel')
      event({
        type: 'tool_execution_end',
        toolCallId: toolId,
        toolName: 'bash',
        result: { content: [{ type: 'text', text: tool.output }] },
        isError: tool.exitCode !== 0,
      })
      event({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: tool.output.trim() },
      })
      event({ type: 'message_end', message: { role: 'assistant' } })
      event({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [] })
      event({ type: 'agent_end', messages: [], willRetry: false })
      appendMessage('assistant', '收到：' + tool.output.trim())
      streaming = false
      if (knobs.pendingTurn === true) {
        // Never settles on its own: the caller must cancel.
        pending = true
        return
      }
      // The official ordering: `agent_end` first, an automatic retry in between, then the
      // settled signal. Treating `agent_end` as the turn end would cut the turn short.
      event({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1 })
      event({ type: 'auto_retry_end', success: true, attempt: 2 })
      event({ type: 'agent_settled' })
      return
    }
    default:
      respond({ command: message.type ?? 'parse', success: false, error: 'unsupported' })
  }
}

let queue = Promise.resolve()
let stdinBuffer = ''

/** Handle one protocol frame. Responses to our own dialogs are the bridge's business. */
const route = (message) => {
  if (message.type === 'extension_ui_response') return
  queue = queue.then(async () => {
    try {
      await handle(message)
    } catch (error) {
      write({
        id: message.id,
        type: 'response',
        command: message.type,
        success: false,
        error: String(error),
      })
    }
  })
}

process.stdin.on('data', (chunk) => {
  // The accumulator lives outside the handler: a frame split across two chunks must not
  // lose its first half.
  stdinBuffer += chunk.toString('utf8')
  for (;;) {
    const index = stdinBuffer.indexOf('\n')
    if (index === -1) break
    const line = stdinBuffer.slice(0, index).replace(/\r$/, '')
    stdinBuffer = stdinBuffer.slice(index + 1)
    if (line.trim().length === 0) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      write({ type: 'response', command: 'parse', success: false, error: 'parse error' })
      continue
    }
    route(message)
  }
})

/**
 * Raise the official Full Access acknowledgment the way the product does, without the
 * per-session preset: `dialogAck: true` emits the same session-scoped `select` during
 * session start, and `dialogAckDuringTurn: true` re-emits an identical-looking dialog
 * while a turn is running, which is what a task approval that copies the startup text
 * looks like.
 */
const raiseFullAccessDialog = (id = 'ack-1') => {
  const options = [
    'Yes, continue anyway — apply full access for this session',
    "Yes, and don't ask again — enable full access and remember this choice",
    'Cancel — go back without enabling full access',
  ]
  return new Promise((resolve) => {
    write({
      type: 'extension_ui_request',
      id,
      method: 'select',
      title: 'Enable full access?',
      options,
    })
    const onLine = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.type === 'extension_ui_response' && message.id === id) {
          process.stdin.off('data', onLine)
          recordDialogAnswer(id, message.value)
          resolve(message)
          return
        }
      }
    }
    process.stdin.on('data', onLine)
  })
}

void (async () => {
  if (preset === 'full-access' || knobs.dialogAck === true) await raiseFullAccessDialog()
})()

void pending
