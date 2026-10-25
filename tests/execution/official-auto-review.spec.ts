/**
 * Official Auto Review on the two external Harnesses this bridge owns.
 *
 * Every case here drives the real bridge source or the real adapter through the official
 * CLI's own protocol surface, so a passing run means the parameter really was sent and the
 * CLI's own reply really was believed — not that a stub agreed with itself.
 *
 * The two Harnesses publish different official mechanisms, and the tests mirror that:
 *
 *  - Codex CLI 0.160.1 exposes `approvalsReviewer: user | auto_review | guardian_subagent`
 *    on `thread/start`, `thread/resume`, `turn/start` and `thread/fork`, and echoes the
 *    reviewer and approval policy now in force on the thread. The bridge verifies that echo.
 *  - Claude Code 2.1.292 exposes `permissionMode: auto` and reports the mode it really took
 *    in its own `system`/`init` message. The bridge verifies that report.
 *
 * The negative cases are the point of the file: an Auto record whose Harness did not adopt
 * the official reviewer must be refused, never downgraded to an ordinary never-ask or
 * bypass-permissions session.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adapterFor } from '../../src/execution/host/adapters/index.ts'
import { externalAutoReviewRequested } from '../../src/execution/host/adapters/native.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'

const BRIDGE = fileURLToPath(
  new URL('../../src/execution/host/adapters/native-harness-bridge.ts', import.meta.url),
)

const roots: string[] = []
const running = new Map<ChildProcess, Promise<void>>()
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const child of running.keys()) child.stdin?.end()
  await Promise.all(running.values())
  running.clear()
  for (const root of roots.splice(0))
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 10 : 0,
      retryDelay: 100,
    })
})
/** A scratch directory that is always removed again. */
async function scratch(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opl-official-auto-review-')))
  roots.push(root)
  return root
}

/**
 * A stand-in for the installed Codex app-server, spoken to exactly as the bridge speaks to
 * the real one: it answers `initialize`, logs every request it receives, and answers
 * `thread/start` / `thread/resume` with the reviewer and approval policy the environment
 * tells it to report. Echoing is separate from the request on purpose, because that is what
 * makes "the CLI agreed" distinguishable from "the bridge assumed".
 */
const CODEX_FIXTURE = `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const log = process.env.OPL_FIXTURE_LOG
const reviewer = process.env.OPL_FIXTURE_REVIEWER
const policy = process.env.OPL_FIXTURE_POLICY
createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id === undefined || m.method === undefined) return
  if (log) appendFileSync(log, JSON.stringify({ method: m.method, params: m.params ?? {} }) + '\\n')
  const answer = (result) => process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n')
  if (m.method === 'initialize')
    return answer({ userAgent: 'fixture', codexHome: process.cwd(), platformFamily: 'windows', platformOs: 'windows' })
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    const p = m.params ?? {}
    return answer({
      thread: { id: p.threadId ?? 'fixture-thread' },
      model: p.model,
      modelProvider: p.modelProvider,
      cwd: p.cwd,
      approvalPolicy: policy ?? p.approvalPolicy ?? 'on-request',
      approvalsReviewer: reviewer ?? p.approvalsReviewer ?? 'user',
      sandbox: { type: 'workspaceWrite' },
    })
  }
  if (m.method === 'turn/start') {
    const id = 'fixture-turn'
    answer({ turn: { id } })
    const scenario = process.env.OPL_FIXTURE_TURN_RESULT
    const item = { id: 'answer', type: 'agentMessage', text: 'final answer' }
    const notify = (method, params) => process.stdout.write(JSON.stringify({method, params}) + '\\n')
    if (scenario === 'streamed') notify('item/agentMessage/delta', {threadId:m.params.threadId,itemId:item.id,delta:'final '})
    if (scenario === 'final-only' || scenario === 'streamed')
      notify('item/completed', {threadId:m.params.threadId,item})
    process.stdout.write(JSON.stringify({
      method: 'turn/completed',
      params: { threadId: m.params.threadId, turn: { id,
        status: scenario === 'failed' ? 'failed' : 'completed',
        ...(scenario === 'failed' ? {error:{message:'synthetic-private-key',
          codexErrorInfo:{httpConnectionFailed:{httpStatusCode:503,body:'synthetic-private-key'}}}} : {}),
        items: scenario && scenario !== 'failed' ? [item] : [],
      } },
    }) + '\\n')
    return
  }
  answer({})
})
`
/**
 * A stand-in for the installed Claude Code executable.
 *
 * The Agent SDK runs any `pathToClaudeCodeExecutable` ending in `.mjs` with the current Node
 * binary, so this file is spawned exactly like the real CLI and speaks the same stream-json
 * channel. It reports the permission mode the environment names, which is what the bridge
 * must verify before it lets a turn run.
 */
const CLAUDE_FIXTURE = `
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const mode = process.env.OPL_FIXTURE_PERMISSION_MODE ?? 'auto'
const askTool = process.env.OPL_FIXTURE_ASK_TOOL
const decisionFile = process.env.OPL_FIXTURE_DECISION
// The real CLI receives the same argument vector, so recording it is how a test proves which
// official switches the bridge actually asked for.
if (process.env.OPL_FIXTURE_ARGV) writeFileSync(process.env.OPL_FIXTURE_ARGV, JSON.stringify(process.argv))
const init = () => process.stdout.write(JSON.stringify({
  type: 'system', subtype: 'init', cwd: process.cwd(), session_id: 'fixture-session',
  tools: [], mcp_servers: [], model: 'fixture-model', permissionMode: mode,
  slash_commands: [], output_style: 'default', skills: [], plugins: [],
  apiKeySource: 'ANTHROPIC_API_KEY', claude_code_version: 'fixture',
}) + '\\n')
let finished = false
const finish = () => {
  if (finished) return
  finished = true
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: 'ok',
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, session_id: 'fixture-session',
  }) + '\\n')
  process.exit(0)
}
createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.type === 'control_response') {
    // The answer to the permission prompt this stand-in CLI raised on the model's behalf.
    if (m.response?.request_id === 'ask-1' && decisionFile) {
      writeFileSync(decisionFile, JSON.stringify(m.response.response ?? null))
      finish()
    }
    return
  }
  if (m.type === 'control_request')
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: m.request_id, response: {} },
    }) + '\\n')
})
init()
if (!askTool || !decisionFile) setTimeout(finish, 400)
else {
  process.stdout.write(JSON.stringify({
    type: 'control_request', request_id: 'ask-1',
    request: {
      subtype: 'can_use_tool', tool_name: askTool,
      input: { command: 'echo hi', file_path: process.cwd() },
      permission_suggestions: [], tool_use_id: 'toolu-1',
    },
  }) + '\\n')
  // An unanswered prompt is a failing test, not a hang.
  setTimeout(() => {
    if (finished) return
    finished = true
    writeFileSync(decisionFile, JSON.stringify({ unanswered: true }))
    process.exit(0)
  }, 8000)
}
setInterval(() => {}, 1000)
`

/** One ACP conversation with a freshly spawned bridge, plus its stderr. */
interface BridgeConversation {
  call(method: string, params?: object): Promise<any>
  updates: string[]
  /** Every tool approval this bridge asked its own operator about. */
  permissionAsks: { title: string }[]
  stderr(): string
  close(): Promise<void>
}
/**
 * Spawn the real bridge with an inherited environment, exactly as the adapter would.
 * @param env - the bridge's environment, including the Harness opt-in under test.
 * @param cwd - the bridge's working directory, which is also the bound project directory.
 * @returns an ACP client bound to that process.
 */
async function openBridge(env: NodeJS.ProcessEnv, cwd: string): Promise<BridgeConversation> {
  const child = spawn(process.execPath, [BRIDGE], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  running.set(child, closed)
  const updates: string[] = []
  const permissionAsks: { title: string }[] = []
  const errors: string[] = []
  child.stderr.on('data', (b) => errors.push(String(b)))
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  child.on('error', (error) => {
    for (const p of pending.values()) p.reject(error)
    pending.clear()
  })
  child.on('exit', (code) => {
    for (const p of pending.values()) p.reject(Error('bridge exited with code ' + String(code)))
    pending.clear()
  })
  let seq = 0
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let m: any
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.method === 'session/update') {
      updates.push(String(m.params?.update?.content?.text ?? ''))
      return
    }
    if (m.method === 'session/request_permission') {
      // Recorded, then refused: an Auto session must never reach this, and an ordinary
      // session must still be able to.
      permissionAsks.push({ title: String(m.params?.toolCall?.title ?? '') })
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: m.id,
          result: { outcome: { optionId: 'deny' } },
        }) + '\n',
      )
      return
    }
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.error
      ? p.reject(Error(m.error.code + ': ' + m.error.message + JSON.stringify(m.error.data ?? {})))
      : p.resolve(m.result)
  })
  return {
    call: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(Error('timeout waiting for ' + method))
        }, 20000)
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer)
            resolve(v)
          },
          reject: (e) => {
            clearTimeout(timer)
            reject(e)
          },
        })
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      }),
    updates,
    permissionAsks,
    stderr: () => errors.join(''),
    close: async () => {
      child.stdin!.end()
      await closed
    },
  }
}
/** Read the request log a fixture wrote, in arrival order. */
async function requests(log: string): Promise<{ method: string; params: any }[]> {
  try {
    return (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

describe('Codex terminal response projection', () => {
  async function resultBridge(scenario: string) {
    const root = await scratch()
    await writeFile(join(root, 'app-server'), CODEX_FIXTURE)
    const bridge = await openBridge(
      {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        TEMP: root,
        TMP: root,
        OPL_NATIVE_HARNESS: 'codex',
        OPL_NATIVE_COMMAND: process.execPath,
        OPL_NATIVE_MODEL: 'gpt-current',
        OPL_NATIVE_PERMISSION: 'workspace',
        OPL_NATIVE_BASE_URL: 'http://127.0.0.1:1/v1',
        OPL_NATIVE_API_KEY: 'synthetic-private-key',
        OPL_FIXTURE_TURN_RESULT: scenario,
      },
      root,
    )
    await bridge.call('initialize')
    const session = await bridge.call('session/new', { cwd: root, mcpServers: [] })
    return { bridge, session }
  }

  it.each(['final-only', 'streamed', 'terminal-only'])(
    'delivers %s text exactly once',
    async (scenario) => {
      const { bridge, session } = await resultBridge(scenario)
      expect(
        await bridge.call('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'answer' }],
        }),
      ).toMatchObject({ stopReason: 'end_turn' })
      expect(bridge.updates.join('')).toBe('final answer')
      await bridge.close()
    },
  )

  it('returns structured terminal failure facts without the provider body', async () => {
    const { bridge, session } = await resultBridge('failed')
    const failure = String(
      await bridge
        .call('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'answer' }],
        })
        .catch((error) => error),
    )
    expect(failure).toContain('HARNESS_EXECUTION')
    expect(failure).toContain('httpConnectionFailed')
    expect(failure).toContain('503')
    expect(failure).toContain('failed')
    expect(failure).not.toContain('synthetic-private-key')
    await bridge.close()
  })
})

describe('official Auto Review opt-in on the native adapter', () => {
  const base = {
    id: 'one',
    cwd: process.cwd(),
    sandbox: 'workspace',
    harnessRef: 'codex',
    modelRef: { provider: 'opl-gateway', model: 'codex::gpt-current' },
  } as unknown as HarnessSession

  it('reads only an explicit boolean, and refuses a malformed flag instead of guessing', () => {
    expect(externalAutoReviewRequested(base)).toBe(false)
    expect(externalAutoReviewRequested({ ...base, externalAutoReview: false } as never)).toBe(false)
    expect(externalAutoReviewRequested({ ...base, externalAutoReview: true } as never)).toBe(true)
    // A wiring fault must not silently become either Auto or an ordinary session.
    for (const value of ['yes', 1, null, {}])
      expect(() =>
        externalAutoReviewRequested({ ...base, externalAutoReview: value } as never),
      ).toThrow(/Auto Review/)
  })

  it('carries the opt-in to the bridge only for an Auto record', async () => {
    const home = await scratch()
    const ctx = {
      get: () => undefined,
      credentials: { resolve: async () => ({ value: 'test-key' }) },
    } as unknown as Context
    const options = {
      home,
      command: process.execPath,
      grokCommand: process.execPath,
      nativeBridgePath: '/owned/native-harness-bridge.mjs',
    }
    const ordinary = await adapterFor('codex', base.modelRef)!.prepare!(ctx, base, options)
    expect(ordinary.env.OPL_NATIVE_AUTO_REVIEW).toBeUndefined()
    const auto = await adapterFor('codex', base.modelRef)!.prepare!(
      ctx,
      { ...base, externalAutoReview: true } as never,
      options,
    )
    expect(auto.env.OPL_NATIVE_AUTO_REVIEW).toBe('1')
    // Nothing else about the launch may change: same program, same argument vector.
    expect(auto.command).toBe(ordinary.command)
    expect(auto.args).toEqual(ordinary.args)
    expect(auto.env.OPL_NATIVE_PERMISSION).toBe('workspace')
  })

  it('refuses to launch when the persisted flag is not a boolean', async () => {
    const home = await scratch()
    const ctx = {
      get: () => undefined,
      credentials: { resolve: async () => ({ value: 'test-key' }) },
    } as unknown as Context
    await expect(
      adapterFor('codex', base.modelRef)!.prepare!(
        ctx,
        { ...base, externalAutoReview: 'auto' } as never,
        {
          home,
          command: process.execPath,
          grokCommand: process.execPath,
          nativeBridgePath: '/owned/native-harness-bridge.mjs',
        },
      ),
    ).rejects.toThrow(/Auto Review/)
  })
})

describe('Codex CLI official auto reviewer', () => {
  /**
   * Run one ACP session against the Codex fixture.
   * @param autoReview - whether the bridge is asked for the official Auto route.
   * @param echo - what the fixture reports back as the thread's effective reviewer/policy.
   * @returns the ACP outcome and the requests the fixture actually received.
   */
  async function runCodex(
    autoReview: boolean,
    echo: { reviewer?: string; policy?: string } = {},
  ): Promise<{
    session: any
    prompt: any
    failure?: string
    diagnostics: string
    log: { method: string; params: any }[]
  }> {
    const root = await scratch()
    // The bridge launches `command app-server --stdio`, and a `.mjs` under the working
    // directory runs with the current Node binary even when extensionless.
    await writeFile(join(root, 'app-server'), CODEX_FIXTURE)
    const log = join(root, 'requests.jsonl')
    const bridge = await openBridge(
      {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        TEMP: root,
        TMP: root,
        OPL_NATIVE_HARNESS: 'codex',
        OPL_NATIVE_COMMAND: process.execPath,
        OPL_NATIVE_MODEL: 'gpt-current',
        OPL_NATIVE_PERMISSION: 'workspace',
        OPL_NATIVE_BASE_URL: 'http://127.0.0.1:1/v1',
        OPL_NATIVE_API_KEY: 'fixture',
        OPL_FIXTURE_LOG: log,
        // Diagnostics carry the bridge's own refusal reason on stderr. The ACP error stays
        // opaque by design, so this is how a test proves which refusal fired instead of
        // merely that something failed.
        OPL_NATIVE_DIAGNOSTICS: '1',
        ...(echo.reviewer ? { OPL_FIXTURE_REVIEWER: echo.reviewer } : {}),
        ...(echo.policy ? { OPL_FIXTURE_POLICY: echo.policy } : {}),
        ...(autoReview ? { OPL_NATIVE_AUTO_REVIEW: '1' } : {}),
      },
      root,
    )
    try {
      await bridge.call('initialize')
      let session: any
      let failure: string | undefined
      try {
        // The recorded params are asserted through the fixture's own log, so a subtle
        // argument change is caught even when the call itself succeeds.
        session = await bridge.call('session/new', { cwd: root, mcpServers: [] })
      } catch (error) {
        failure = (error as Error).message
      }
      let prompt: any
      if (session) {
        try {
          prompt = await bridge.call('session/prompt', {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'hello' }],
          })
        } catch (error) {
          failure = (error as Error).message
        }
      }
      const log_ = await requests(log)
      // stderr travels on its own pipe, so give the refusal line a moment to land before the
      // conversation is torn down.
      await new Promise((resolve) => setTimeout(resolve, 150))
      return { session, prompt, failure, diagnostics: bridge.stderr(), log: log_ }
    } finally {
      await bridge.close()
    }
  }
  const threadStart = (log: { method: string; params: any }[]) =>
    log.find((entry) => entry.method === 'thread/start')
  const turnStart = (log: { method: string; params: any }[]) =>
    log.find((entry) => entry.method === 'turn/start')

  it('routes thread/start to the official reviewer under a policy that raises requests', async () => {
    const { session, prompt, failure, log } = await runCodex(true)
    expect(failure).toBeUndefined()
    expect(session.sessionId).toBeTruthy()
    expect(prompt).toEqual({ stopReason: 'end_turn' })
    expect(threadStart(log)?.params).toMatchObject({
      approvalsReviewer: 'auto_review',
      approvalPolicy: 'on-request',
      modelProvider: 'opl-gateway',
    })
  })

  it('refuses a thread whose reported reviewer is not the official one', async () => {
    // A build that ignores `approvalsReviewer` reports `user`, the protocol default.
    const { session, failure, diagnostics } = await runCodex(true, { reviewer: 'user' })
    expect(session).toBeUndefined()
    expect(failure).toMatch(/HARNESS_UNKNOWN/)
    expect(failure).toMatch(/官方 Harness 调用未完成/)
    expect(diagnostics).toMatch(/审批审核者是 user/)
    expect(diagnostics).toMatch(/不能把普通审批策略当成官方 Auto/)
  })

  it('refuses a thread that reports approvalPolicy never, where the reviewer is unreachable', async () => {
    const { session, failure, diagnostics } = await runCodex(true, {
      reviewer: 'auto_review',
      policy: 'never',
    })
    expect(session).toBeUndefined()
    expect(failure).toMatch(/HARNESS_UNKNOWN/)
    expect(diagnostics).toMatch(/审批策略是 never/)
    expect(diagnostics).toMatch(/拒绝以 never 冒充官方 Auto/)
  })

  it('accepts the legacy guardian_subagent spelling the app-server still publishes', async () => {
    const { session, failure } = await runCodex(true, { reviewer: 'guardian_subagent' })
    expect(failure).toBeUndefined()
    expect(session.sessionId).toBeTruthy()
  })

  it('leaves an ordinary session on never with no reviewer field at all', async () => {
    const { session, prompt, failure, log } = await runCodex(false)
    expect(failure).toBeUndefined()
    expect(session.sessionId).toBeTruthy()
    expect(prompt).toEqual({ stopReason: 'end_turn' })
    const params = threadStart(log)?.params ?? {}
    expect(params.approvalPolicy).toBe('never')
    // The field must be absent, not merely falsy: sending `user` would be a request to
    // change the reviewer of a session that never asked to change it.
    expect(Object.hasOwn(params, 'approvalsReviewer')).toBe(false)
    expect(turnStart(log)?.params).toMatchObject({
      threadId: session.sessionId,
      model: 'gpt-current',
    })
  })

  it('refuses an unreadable opt-in instead of running the session without it', async () => {
    const root = await scratch()
    await writeFile(join(root, 'app-server'), CODEX_FIXTURE)
    const bridge = await openBridge(
      {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        TEMP: root,
        TMP: root,
        OPL_NATIVE_HARNESS: 'codex',
        OPL_NATIVE_COMMAND: process.execPath,
        OPL_NATIVE_MODEL: 'gpt-current',
        OPL_NATIVE_PERMISSION: 'workspace',
        OPL_NATIVE_BASE_URL: 'http://127.0.0.1:1/v1',
        OPL_NATIVE_API_KEY: 'fixture',
        OPL_NATIVE_AUTO_REVIEW: 'yes',
      },
      root,
    )
    try {
      await expect(bridge.call('initialize')).rejects.toThrow(/HARNESS_UNKNOWN/)
    } finally {
      await bridge.close()
    }
  })
})

describe('Claude Code official auto permission mode', () => {
  /** Read the option value from either spelling the official SDK can pass to the CLI. */
  function option(argv: string[], name: string): string | undefined {
    const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`))
    if (index < 0) return undefined
    const argument = argv[index]!
    return argument === name ? argv[index + 1] : argument.slice(name.length + 1)
  }

  /**
   * Run one ACP prompt against the Claude fixture through the real Agent SDK.
   * @param autoReview - whether the bridge is asked for the official Auto route.
   * @param reportedMode - the permission mode the stand-in CLI reports it really took.
   * @param askTool - when set, the stand-in CLI raises a permission prompt for this tool and
   * reports the decision the host callback gave it.
   * @returns the ACP outcome, the callback's own decision, and the operator approvals asked.
   */
  async function runClaude(
    autoReview: boolean,
    reportedMode: string,
    askTool?: string,
  ): Promise<{
    prompt: any
    failure?: string
    diagnostics: string
    decision?: any
    argv: string[]
    permissionAsks: { title: string }[]
  }> {
    const root = await scratch()
    const fixture = join(root, 'claude-fixture.mjs')
    await writeFile(fixture, CLAUDE_FIXTURE)
    const decisionFile = join(root, 'callback-decision.json')
    const argvFile = join(root, 'cli-argv.json')
    // The bridge asks the SDK for this project's existing transcript, so the config home is
    // redirected into the scratch directory rather than left pointing at the developer's own.
    const configHome = join(root, 'claude-home')
    const bridge = await openBridge(
      {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        TEMP: root,
        TMP: root,
        HOME: root,
        USERPROFILE: root,
        CLAUDE_CONFIG_DIR: configHome,
        OPL_NATIVE_HARNESS: 'claude',
        // The Agent SDK runs a `.mjs` executable path with the current Node binary.
        OPL_NATIVE_COMMAND: fixture,
        OPL_NATIVE_MODEL: 'claude-sonnet-current',
        OPL_NATIVE_PERMISSION: 'workspace',
        OPL_NATIVE_BASE_URL: 'http://127.0.0.1:1',
        OPL_NATIVE_API_KEY: 'fixture',
        OPL_FIXTURE_PERMISSION_MODE: reportedMode,
        OPL_NATIVE_DIAGNOSTICS: '1',
        OPL_FIXTURE_ARGV: argvFile,
        ...(askTool ? { OPL_FIXTURE_ASK_TOOL: askTool, OPL_FIXTURE_DECISION: decisionFile } : {}),
        ...(autoReview ? { OPL_NATIVE_AUTO_REVIEW: '1' } : {}),
      },
      root,
    )
    try {
      await bridge.call('initialize')
      const session = await bridge.call('session/new', { cwd: root, mcpServers: [] })
      let prompt: any
      let failure: string | undefined
      try {
        prompt = await bridge.call('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'hello' }],
        })
      } catch (error) {
        failure = (error as Error).message
      }
      // stderr travels on its own pipe, so give the refusal line a moment to land before the
      // conversation is torn down.
      await new Promise((resolve) => setTimeout(resolve, 150))
      let decision: any
      if (askTool) {
        try {
          decision = JSON.parse(await readFile(decisionFile, 'utf8'))
        } catch {
          decision = undefined
        }
      }
      let argv: string[] = []
      try {
        argv = JSON.parse(await readFile(argvFile, 'utf8'))
      } catch {
        argv = []
      }
      return {
        prompt,
        failure,
        diagnostics: bridge.stderr(),
        decision,
        argv,
        permissionAsks: bridge.permissionAsks,
      }
    } finally {
      await bridge.close()
    }
  }

  it('runs under the official auto mode the CLI reports back', { timeout: 30000 }, async () => {
    const { prompt, failure, argv } = await runClaude(true, 'auto')
    expect(failure).toBeUndefined()
    expect(prompt).toEqual({ stopReason: 'end_turn' })
    // The official switch that removes this session's host approval surface, verified in the
    // argument vector the installed CLI actually receives rather than in the options object.
    expect(option(argv, '--permission-prompts')).toBe('none')
    expect(option(argv, '--permission-prompt-tool')).toBe('stdio')
  })

  it(
    'refuses the turn when the CLI reports a mode other than auto',
    { timeout: 30000 },
    async () => {
      const { prompt, failure, diagnostics } = await runClaude(true, 'default')
      expect(prompt).toBeUndefined()
      expect(failure).toMatch(/HARNESS_UNKNOWN/)
      expect(diagnostics).toMatch(/permission mode 是 default/)
      expect(diagnostics).toMatch(/拒绝把普通 permission mode 当成官方 Auto/)
    },
  )

  it(
    'leaves an ordinary session alone when it reports the default mode',
    { timeout: 30000 },
    async () => {
      // No Auto opt-in: the same expectation must not turn into a refusal.
      const { prompt, failure, argv } = await runClaude(false, 'default')
      expect(failure).toBeUndefined()
      expect(prompt).toEqual({ stopReason: 'end_turn' })
      // An ordinary session keeps its host approval surface: the CLI is told a host answers.
      expect(option(argv, '--permission-prompts')).not.toBe('none')
    },
  )

  it(
    'fails closed on every callback fallback an Auto session can reach',
    { timeout: 60000 },
    async () => {
      // Each of these would be allowed by the ordinary profile: the harness MCP namespace and
      // the read-only allow-list are allowed outright, and `Bash` is allowed under `workspace`.
      // An Auto session has no official review behind an allow, so all three must be refused
      // by the callback itself and must never be escalated to the operator instead.
      for (const tool of ['mcp__opl-harness__files', 'Read', 'Bash']) {
        const { failure, decision, permissionAsks } = await runClaude(true, 'auto', tool)
        expect(failure, tool).toBeUndefined()
        expect(decision, tool).toMatchObject({ behavior: 'deny' })
        expect(permissionAsks, tool).toEqual([])
      }
    },
  )

  it(
    'keeps the ordinary allow-list and operator prompt when the session is not Auto',
    { timeout: 60000 },
    async () => {
      // The same callback, without the Auto opt-in, must behave exactly as before: the
      // read-only allow-list and the workspace `Bash` rule still allow, and a tool with no
      // standing rule still reaches the operator rather than being denied on its behalf.
      for (const tool of ['Read', 'Bash']) {
        const { failure, decision, permissionAsks } = await runClaude(false, 'default', tool)
        expect(failure, tool).toBeUndefined()
        expect(decision, tool).toMatchObject({ behavior: 'allow' })
        expect(permissionAsks, tool).toEqual([])
      }
      const escalated = await runClaude(false, 'default', 'SomeUnlistedTool')
      expect(escalated.decision).toMatchObject({ behavior: 'deny' })
      expect(escalated.permissionAsks).toHaveLength(1)
      expect(escalated.permissionAsks[0]?.title).toContain('SomeUnlistedTool')
    },
  )
})
