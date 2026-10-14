/**
 * Stand-in for the official `zcode app-server`, speaking the official ZCode Protocol:
 * newline delimited JSON-RPC, `{id,result}`/`{id,error}` answers, live stream pushed as
 * `session/event` notifications, and lifecycle calls answered with the official session
 * state snapshot.
 *
 * It is deliberately a *controlled* provider: it opens no network connection, so no test
 * here can reach a real model or send a real prompt. What it does do is let the owned
 * bridge be driven exactly as the Host drives it, including the runtime-preferences
 * handshake, so drift, cancellation and cleanup are observed rather than asserted.
 *
 * Behaviour switches (environment):
 *   FAKE_MODEL          model id the session claims; defaults to the pinned one
 *   FAKE_MODEL_PROVIDER provider id the session claims
 *   FAKE_LEVEL          reasoning level the session claims; omit to omit the option
 *   FAKE_MODE           session permission mode; defaults to `yolo`
 *   FAKE_BAD_PROTOCOL   emit a mismatched protocol identity
 *   FAKE_NO_HANDSHAKE   answer session/create without asking for runtime preferences
 *   SEND_ERROR          fail session/send with an upstream error
 *   TURN_FAIL           end the turn with turn.failed
 *   HANG                never complete the turn (for cancellation tests)
 *   PERMISSION          raise interaction/requestPermission mid-turn
 *   TRACE_FILE          append every observed frame as NDJSON for assertions
 */
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const send = (v) => process.stdout.write(JSON.stringify(v) + '\n')
const trace = (v) => {
  if (process.env.TRACE_FILE) appendFileSync(process.env.TRACE_FILE, JSON.stringify(v) + '\n')
}

const exec = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: process.cwd(), env: process.env, windowsHide: true },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (error.code ?? 1) : 0,
          stdout,
          stderr,
          error: error ? String(error.message) : '',
        }),
    )
  })

/**
 * Run a *real* external Git command chain in this process's own working directory and
 * report the actual output. This is what proves the route works in a project path that
 * contains Chinese characters and spaces: the CLI receives the real cwd and the real
 * environment, and `git` has to cope with both on its own.
 */
async function runRealGit() {
  await writeFile('中文 文件.txt', 'OPL owned fixture\n', 'utf8')
  const init = await exec('git', ['init', '--quiet'])
  const add = await exec('git', ['add', '--', '中文 文件.txt'])
  // `core.quotePath=false` so real UTF-8 path bytes are observed, not octal escapes.
  const status = await exec('git', ['-c', 'core.quotePath=false', 'status', '--porcelain'])
  return {
    cwd: process.cwd(),
    shell: process.env.SHELL || '',
    init: init.code,
    add: add.code,
    status: status.code,
    stdout: status.stdout,
    stderr: status.stderr,
  }
}

const MODEL = process.env.FAKE_MODEL || 'z-ai/glm-5.3'
const PROVIDER = process.env.FAKE_MODEL_PROVIDER || 'our-free-model-zcode'
const MODE = process.env.FAKE_MODE || 'yolo'

const snapshot = (id) => ({
  protocol: process.env.FAKE_BAD_PROTOCOL
    ? { name: 'Not ZCode', version: 99 }
    : { name: 'ZCode Protocol', version: 1 },
  session: {
    sessionId: id,
    workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
    sessionKind: 'interactive',
    title: 'test',
    mode: MODE,
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
  },
  settings: {
    model: {
      available: [{ providerId: PROVIDER, modelId: MODEL }],
      current: {
        providerId: PROVIDER,
        modelId: MODEL,
        ...(process.env.FAKE_LEVEL === undefined
          ? {}
          : { options: { reasoningLevel: process.env.FAKE_LEVEL } }),
      },
    },
    thoughtLevel: { enabled: false, available: [] },
    mode: { current: MODE },
  },
  projection: {},
  runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
  messages: [],
  slashCommands: [],
})

let seq = 0
let sessionId = null
let permissionId = null
let deferredCreate = null

const event = (sid, type, payload) =>
  send({
    method: 'session/event',
    params: { eventId: 'e' + ++seq, sessionId: sid, seq, timestamp: seq, type, payload },
  })

createInterface({ input: process.stdin }).on('line', async (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.id !== undefined && !m.method) {
    trace({ clientResponse: m })
    // The create result is withheld until the client has answered the server's
    // runtime-preferences request, exactly as the real runtime behaves.
    if (m.id === 800 && deferredCreate) {
      const deferred = deferredCreate
      deferredCreate = null
      send(deferred)
    }
    if (m.id === permissionId) {
      permissionId = null
      const outcome = m.result?.outcome?.optionId
      event(sessionId, 'part.delta', {
        messageId: 'm1',
        partId: 'pt',
        field: 'text',
        delta: outcome === 'yes' ? 'after-approval' : 'denied',
      })
      event(sessionId, 'turn.completed', {
        response: 'done',
        tokenCount: 1,
        toolCallCount: 0,
        duration: 1,
        resultType: 'success',
      })
    }
    return
  }
  trace({ method: m.method, params: m.params })
  if (m.method === 'runtime/capabilities')
    return send({
      id: m.id,
      result: { protocol: { name: 'ZCode Protocol', version: 1 }, capabilities: {} },
    })
  if (m.method === 'session/create') {
    sessionId = 'sess-new'
    if (process.env.FAKE_NO_HANDSHAKE) return send({ id: m.id, result: snapshot(sessionId) })
    deferredCreate = { id: m.id, result: snapshot(sessionId) }
    send({
      id: 800,
      method: 'session/requestRuntimePreferences',
      params: { sessionId, scope: 'runtime-materialization' },
    })
    return
  }
  if (m.method === 'session/resume') {
    sessionId = m.params.sessionId
    return send({ id: m.id, result: snapshot(sessionId) })
  }
  if (m.method === 'session/subscribe')
    return send({
      id: m.id,
      result: {
        sessionId: m.params.sessionId,
        eventSeq: 0,
        events: [],
        ...(m.params.includeSnapshot ? { snapshot: snapshot(m.params.sessionId) } : {}),
      },
    })
  if (m.method === 'session/stop') {
    send({ id: m.id, result: {} })
    return event(sessionId, 'turn.completed', {
      response: '',
      tokenCount: 0,
      toolCallCount: 0,
      duration: 0,
      resultType: 'cancelled',
    })
  }
  if (m.method === 'session/send') {
    if (process.env.SEND_ERROR)
      return send({ id: m.id, error: { code: -32000, message: 'upstream refused the request' } })
    send({ id: m.id, result: { sessionId: m.params.sessionId, accepted: true, stateRevision: 1 } })
    if (process.env.PERMISSION) {
      permissionId = 900
      return send({
        id: permissionId,
        method: 'interaction/requestPermission',
        params: {
          requestId: 'r1',
          sessionId,
          toolCallId: 'c1',
          toolName: 'bash',
          reason: 'run a command',
          riskLevel: 'medium',
          input: { command: 'pwd' },
          options: [
            { optionId: 'yes', kind: 'allow', name: '允许', response: { decision: 'allow' } },
            { optionId: 'no', kind: 'deny', name: '拒绝', response: { decision: 'deny' } },
            { optionId: 'esc', kind: 'escalate', name: '升级', response: { decision: 'escalate' } },
          ],
        },
      })
    }
    if (process.env.RUN_GIT) {
      const result = await runRealGit()
      event(sessionId, 'tool.updated', {
        kind: 'result',
        toolCallId: 'git-1',
        toolName: 'Bash',
        result,
        duration: 1,
      })
    }
    if (process.env.RELEASED_EVENTS) {
      event(sessionId, 'model.streaming', {
        assistantMessageId: 'm1',
        partId: 'p2',
        kind: 'reasoning_delta',
        delta: 'think',
      })
      event(sessionId, 'tool.updated', {
        kind: 'scheduled',
        toolCallId: 'bash-1',
        toolName: 'Bash',
        input: { command: 'pwd' },
      })
      event(sessionId, 'tool.updated', {
        kind: 'result',
        toolCallId: 'bash-1',
        toolName: 'Bash',
        result: { output: 'done' },
        duration: 1,
      })
      event(sessionId, 'model.streaming', {
        assistantMessageId: 'm1',
        partId: 'p1',
        kind: 'text_delta',
        delta: 'hello ',
      })
      return event(sessionId, 'turn.completed', {
        response: 'hello ',
        tokenCount: 1,
        toolCallCount: 1,
        duration: 1,
        resultType: 'success',
      })
    }
    event(sessionId, 'part.delta', {
      messageId: 'm1',
      partId: 'p1',
      field: 'text',
      delta: 'hello ',
    })
    if (process.env.TURN_FAIL)
      return event(sessionId, 'turn.failed', {
        error: { type: 'provider_error', message: 'model rejected the request' },
        turnPhase: 'generate',
      })
    if (!process.env.HANG)
      event(sessionId, 'turn.completed', {
        response: 'done',
        tokenCount: 1,
        toolCallCount: 0,
        duration: 1,
      })
    return
  }
  send({ id: m.id, error: { code: -32601, message: 'method not found' } })
})
