/**
 * Isolated acceptance against the **real** official MiMo Code CLI.
 *
 * Scope of the evidence produced here, stated up front so it cannot be over-read:
 * this proves the official protocol, the official default shell tool, Git Bash, real
 * `git` subprocesses, non-ASCII working directories, session load, cancellation and
 * cleanup. It does **not** prove model availability, latency, or quality: the model
 * is a local, keyless OpenAI-compatible stub that this test controls, so no hosted
 * model and no account is ever contacted.
 *
 * Isolation: the CLI is launched by the adapter's own `prepare`, so it inherits the
 * suite-owned `MIMOCODE_HOME` profile and the verified Git Bash shell. `HOME` and
 * `CODEX_HOME` are never redefined, no global MiMo profile is read or written, and no
 * credential is read.
 *
 * The binary is the pinned official portable release; see the report for version,
 * hash and source URL. Set MIMO_OFFICIAL_BIN to opt into the official-binary checks.
 * An explicitly selected missing binary fails; ordinary keyless unit runs skip them.
 */
import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { appendFileSync, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AcpProcess } from '../../../src/execution/host/acp.ts'
import type { AcpRequestSurface } from '../../../src/execution/host/adapters/types.ts'
import {
  buildMimoRouteConfig,
  mimoCodeAdapter,
  mimoCodeModels,
  mimoModelValue,
  mimoProfileHome,
  MIMO_OFM_MODEL,
} from '../../../src/execution/host/adapters/mimo/index.ts'
import { resolveGitBashPath } from '../../../src/shell/host/git-bash.ts'

const exec = promisify(execFile)
const OWNED = 'C:/Users/root/Documents/Codex/repair-20261013/ofm-harness-adaptation/mimo'
/** Extracted from the pinned official portable release; never installed globally. */
const MIMO_BINARY = process.env.MIMO_OFFICIAL_BIN ?? ''
const MODEL_VALUE = mimoModelValue(MIMO_OFM_MODEL)
const CWD_NAME = '中文 项目 dir'
const TIMEOUT = 180_000
/**
 * A fresh profile pays a one-time SQLite migration before the first reply, so every
 * request carries an explicit budget instead of AcpProcess's 30s default.
 */
const REQUEST_MS = 180_000

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** One tool exchange driven by the controlled model, and the server that produced it. */
interface Stub {
  readonly port: number
  readonly close: () => Promise<void>
  /** Every chat request the CLI made, so tool names are read, never assumed. */
  readonly requests: any[]
  /** Bash tool name discovered from the request the CLI actually sent. */
  readonly bashTool: () => string | undefined
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((done, failed) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => done(body))
    request.on('error', failed)
  })

const FRAME = `${'\n\n'}`

/**
 * OpenAI-compatible **streaming** chat completions.
 *
 * The official CLI requests `stream: true`, so a plain JSON reply is a parse failure
 * and the CLI silently retries; the stub must emit the SSE framing the AI SDK expects.
 * The shell tool and its argument schema are read from the request the CLI actually
 * sent, so nothing about the tool contract is assumed here.
 */
async function startStub(
  plan: (
    turn: number,
    body: any,
    shell: any,
  ) => { message: object; finish: string } | Promise<{ message: object; finish: string }>,
): Promise<Stub> {
  const requests: any[] = []
  let shell: any
  const server: Server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(404, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ error: 'not found' }))
    }
    const body = JSON.parse(await readBody(request))
    requests.push(body)
    const turn = requests.length
    // The CLI's first turn advertises only its structured-output tool; the shell tool
    // appears from the second turn on, so it is discovered rather than assumed.
    if (!shell)
      shell = (body.tools ?? []).find(
        (tool: any) => tool?.function?.name && /bash|shell|terminal/i.test(tool.function.name),
      )
    const { message, finish } = await plan(turn, body, shell)
    const base = { id: `s${turn}`, object: 'chat.completion.chunk', created: 0, model: body.model }
    const chunks: object[] = []
    const calls = (message as any).tool_calls
    if (calls) {
      for (const [index, call] of calls.entries())
        chunks.push({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index,
                    id: call.id,
                    type: 'function',
                    function: { name: call.function.name, arguments: '' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })
      for (const [index, call] of calls.entries())
        chunks.push({
          ...base,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index, function: { arguments: call.function.arguments } }] },
              finish_reason: null,
            },
          ],
        })
    } else {
      chunks.push({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })
      chunks.push({
        ...base,
        choices: [
          { index: 0, delta: { content: (message as any).content ?? '' }, finish_reason: null },
        ],
      })
    }
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })
    const sse =
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}${FRAME}`).join('') +
      `data: [DONE]${FRAME}`
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.end(sse)
  })
  // The bound port must be read after listen, otherwise the CLI is handed port 0 and
  // never reaches the stub at all.
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  let closed: Promise<void> = Promise.resolve()
  return {
    port,
    requests,
    bashTool: () => shell?.function?.name,
    close: () =>
      (closed = closed.then(() => new Promise<void>((done) => server.close(() => done())))),
  }
}

/**
 * Build a shell tool call from the tool's own advertised schema.
 *
 * The official bash tool requires a description alongside the command and rejects a
 * call that omits any required field, so arguments are assembled from the schema the
 * CLI actually advertised rather than from a guessed parameter list.
 */
function shellToolCall(tool: any, command: string): object {
  const schema = tool?.function?.parameters ?? {}
  const properties: string[] = Object.keys(schema.properties ?? {})
  const required: string[] = Array.isArray(schema.required) ? schema.required : []
  const args: Record<string, unknown> = {}
  const commandKey = properties.find((name) => /command|cmd|script/i.test(name)) ?? 'command'
  for (const name of required) {
    if (/command|cmd|script/i.test(name)) args[name] = command
    else if (/desc/i.test(name)) args[name] = '官方 shell 工具隔离验收'
    else args[name] = ''
  }
  if (args[commandKey] === undefined) args[commandKey] = command
  return {
    role: 'assistant',
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: tool.function.name, arguments: JSON.stringify(args) },
      },
    ],
  }
}

/** Launch the official CLI exactly the way the suite launches it. */
async function launchOfficial(
  cwd: string,
  profileHome: string,
  baseURL: string,
  apiKey: string,
  onPermission: (id: string | number, acp: AcpProcess) => void,
): Promise<{ acp: AcpProcess; updates: any[]; environment: NodeJS.ProcessEnv }> {
  const record = { ...sessionRecord(), cwd } as never
  const launch = await mimoCodeAdapter.prepare!({} as never, record, {
    home: profileHome,
    command: MIMO_BINARY,
    grokCommand: 'grok',
    nativeBridgePath: 'bridge.js',
    modelSources: {
      supports: () => true,
      lease: () => ({ assertCurrent: () => {} }),
      resolve: async () => ({ baseURL, model: MIMO_OFM_MODEL, apiKey, protocol: 'chat' }),
    },
  } as never)
  const updates: any[] = []
  const acp = new AcpProcess(
    launch.command,
    launch.args,
    cwd,
    launch.env,
    (value) => {
      updates.push(value)
      step(`update ${JSON.stringify(value).slice(0, 220)}`)
    },
    (id, _value) => {
      step(`permission-request ${String(id)}`)
      onPermission(id, acp)
    },
    () => step('child exited'),
  )
  cleanups.push(() => acp.dispose())
  return { acp, updates, environment: launch.env }
}

const openSession = async (
  acp: AcpProcess,
  method: 'session/new' | 'session/load',
  cwd: string,
  sessionId?: string,
) =>
  (await acp.request(
    method,
    { cwd, mcpServers: [], ...(sessionId ? { sessionId } : {}) },
    REQUEST_MS,
  )) as Record<string, any>

/**
 * Pay the one-time profile migration before the measured flow, so the evidence below
 * is about the protocol and tools rather than about first-run setup latency.
 */
async function warmProfile(
  cwd: string,
  profileHome: string,
  baseURL: string,
  apiKey: string,
): Promise<void> {
  const record = sessionRecord() as never
  const launch = await mimoCodeAdapter.prepare!({} as never, record, {
    home: profileHome,
    command: MIMO_BINARY,
    grokCommand: 'grok',
    nativeBridgePath: 'bridge.js',
    modelSources: {
      supports: () => true,
      lease: () => ({ assertCurrent: () => {} }),
      resolve: async () => ({ baseURL, model: MIMO_OFM_MODEL, apiKey, protocol: 'chat' }),
    },
  } as never)
  const probe = new AcpProcess(
    launch.command,
    launch.args,
    cwd,
    launch.env,
    () => {},
    () => {},
    () => {},
  )
  try {
    await probe.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, REQUEST_MS)
  } finally {
    await probe.dispose()
  }
}

/** Wait for a real ACP notification; never a fixed sleep. */
async function untilUpdate(updates: any[], match: (value: any) => boolean, deadlineMs = TIMEOUT) {
  const existing = updates.find(match)
  if (existing) return existing
  return new Promise((done, failed) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const found = updates.find(match)
      if (found) {
        clearInterval(timer)
        done(found)
      } else if (Date.now() - started > deadlineMs) {
        clearInterval(timer)
        failed(Error('等待官方 ACP 通知超时'))
      }
    }, 25)
  })
}

/**
 * Step trace written straight to an owned file. The reporter buffers console output, so
 * a trace that only goes to the console cannot name the phase of a failure.
 */
const TRACE = process.env.MIMO_ACCEPTANCE_TRACE ?? join(tmpdir(), 'opl-mimo-acceptance-steps.log')
let startedAt = Date.now()
const step = (label: string) => {
  const line = `[+${Date.now() - startedAt}ms] ${label}
`
  try {
    appendFileSync(TRACE, line)
  } catch {
    /* tracing must never fail the acceptance run */
  }
}
beforeEach(() => (startedAt = Date.now()))

/** Bounded condition wait; never an unbounded loop or a fixed sleep. */
async function until(match: () => boolean, message: string, deadlineMs = 60_000) {
  const started = Date.now()
  while (!match()) {
    if (Date.now() - started > deadlineMs) throw Error(message)
    await new Promise((done) => setTimeout(done, 25))
  }
}

/**
 * One turn through the official default shell tool.
 *
 * This release streams no tool-call status, so each fact is written to its own file by
 * the tool itself and read back afterwards. That is stronger than matching a
 * transcript: it shows which shell actually ran, that a real `git` subprocess ran, and
 * that a path containing both Chinese characters and a space survived the round trip.
 *
 * The tool runs with the session's working directory, so every path is relative to the
 * non-ASCII directory the session was opened in.
 */
function bashCommand(): string[] {
  return [
    'mkdir -p 子目录',
    'printf 你好 > 子目录/说明.txt',
    'uname -s > ev-uname.txt',
    'git init -q',
    'git rev-parse --is-inside-work-tree > ev-git.txt',
    'cat 子目录/说明.txt > ev-cat.txt',
    'which bash > ev-bash.txt',
  ]
}

describe.skipIf(!process.env.MIMO_OFFICIAL_BIN)('官方 MiMo Code 隔离验收', () => {
  it('用官方 CLI 完成会话、默认 shell 工具、Git Bash、git 与中文空格读写', async () => {
    if (!existsSync(MIMO_BINARY))
      throw Error(
        `官方 CLI 未就绪：${MIMO_BINARY}\n` +
          '请先执行报告中的下载与解压命令；本测试不会静默跳过，也不会自行安装到全局目录。',
      )
    const root = await mkdtemp(join(tmpdir(), 'opl-mimo-official-'))
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
    const cwd = join(root, CWD_NAME)
    const profileHome = join(root, 'profile')
    await mkdir(cwd, { recursive: true })
    await mkdir(profileHome, { recursive: true })

    const stub = await startStub((turn, body, shell) => {
      step(`stub turn ${turn} tools=${(body.tools ?? []).length} shell=${Boolean(shell)}`)
      if (!shell) return { message: { role: 'assistant', content: '继续' }, finish: 'stop' }
      if (turn > 3) return { message: { role: 'assistant', content: '已完成' }, finish: 'stop' }
      return { message: shellToolCall(shell, bashCommand().join(' && ')), finish: 'tool_calls' }
    })
    cleanups.push(() => stub.close())

    const route = {
      baseURL: `http://127.0.0.1:${stub.port}/v1`,
      model: MIMO_OFM_MODEL,
      apiKey: 'official-acceptance-stub-key',
      protocol: 'chat' as const,
    }
    step('warm-up start')
    await warmProfile(cwd, profileHome, route.baseURL, route.apiKey)
    step('warm-up done')

    const asked: any[] = []
    const { acp, updates, environment } = await launchOfficial(
      cwd,
      profileHome,
      route.baseURL,
      route.apiKey,
      (id, process) => {
        asked.push(id)
        throw Error('chief fixture refuses unexpected permission request')
      },
    )

    // Suite-owned profile isolation, and HOME/CODEX_HOME left untouched.
    expect(environment.MIMOCODE_HOME).toBe(mimoProfileHome(profileHome))
    expect(environment.HOME).toBe(process.env.HOME)
    expect(environment.CODEX_HOME).toBeUndefined()

    step('launched')
    const agent = (await acp.request(
      'initialize',
      { protocolVersion: 1, clientCapabilities: {} },
      REQUEST_MS,
    )) as Record<string, any>
    expect(agent.protocolVersion).toBe(1)
    expect(agent.agentCapabilities?.loadSession).toBe(true)

    step('initialize ok')
    const created = await openSession(acp, 'session/new', cwd)
    step('session/new ok')
    // 官方广告里必须出现本套件按 record 固定的那个取值。
    const advertised = (created.configOptions ?? []).find((option: any) => option.id === 'model')
    expect(advertised.options.map((option: any) => option.value)).toContain(MODEL_VALUE)

    const configured = await mimoCodeAdapter.configureSession!(
      acp as unknown as AcpRequestSurface,
      record0(),
      { agent, session: created, configOptions: created.configOptions },
    )
    const pinned = (configured!.configOptions as any[]).find((option) => option.id === 'model')
    expect(pinned.currentValue).toBe(MODEL_VALUE)

    step('configure ok')
    const result = (await acp.request(
      'session/prompt',
      {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: '用 shell 工具验证 Git Bash、git 与中文空格路径读写' }],
      },
      REQUEST_MS,
    )) as Record<string, any>
    step('prompt ok')
    expect(result.stopReason).toBe('end_turn')

    // 工具名来自官方实际发出的请求，不是猜测。
    expect(stub.bashTool()).toBeTruthy()
    expect(stub.requests.length).toBeGreaterThanOrEqual(2)

    // 由官方默认 shell 工具真实写出的证据。
    await expect(readFile(join(cwd, 'ev-uname.txt'), 'utf8')).resolves.toMatch(/MINGW|MSYS/)
    await expect(readFile(join(cwd, 'ev-git.txt'), 'utf8')).resolves.toContain('true')
    await expect(readFile(join(cwd, 'ev-cat.txt'), 'utf8')).resolves.toContain('你好')
    await expect(readFile(join(cwd, 'ev-bash.txt'), 'utf8')).resolves.toMatch(/bash/)
    // 真实 git 仓库在中文加空格目录里被创建。
    expect(existsSync(join(cwd, '.git'))).toBe(true)
    // 中文加空格文件名完整往返。
    expect(existsSync(join(cwd, '子目录', '说明.txt'))).toBe(true)
    await expect(readFile(join(cwd, '子目录', '说明.txt'), 'utf8')).resolves.toContain('你好')
    // MIMOCODE_HOME 隔离：官方 profile 落在套件目录内，未触碰全局 MiMo 目录。
    for (const child of ['config', 'data', 'state']) {
      expect(existsSync(join(profileHome, 'mimocode', child))).toBe(true)
    }

    // 恢复：同一官方 profile 下重新载入并再次固定模型。
    const loaded = await openSession(acp, 'session/load', cwd, created.sessionId)
    expect(loaded.sessionId).toBeTruthy()
    await mimoCodeAdapter.verifySession!(record0(), {
      agent,
      session: loaded,
      configOptions: loaded.configOptions,
    })

    // Observed, not assumed: this pinned release completed the shell turn without raising
    // any `session/request_permission` back to the client, so this run deliberately makes no
    // claim about the approval path. The count is recorded for the report instead.
    step(`permission requests observed: ${asked.length}`)
  }, 100_000)

  it('取消由原 prompt 回执确认，进程与受控端点都被清理', async () => {
    if (!existsSync(MIMO_BINARY))
      throw Error(`官方 CLI 未就绪：${MIMO_BINARY}；请先按报告解压官方便携文件。`)
    const root = await mkdtemp(join(tmpdir(), 'opl-mimo-cancel-'))
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
    const cwd = join(root, CWD_NAME)
    const profileHome = join(root, 'profile')
    await mkdir(cwd, { recursive: true })

    // 第三轮起不再回应，直到收到取消，模拟一个正在运行的真实任务。
    let runningHeld = false
    let released = false
    let hold: (() => void) | undefined
    const held = new Promise<void>(
      (done) =>
        (hold = () => {
          released = true
          done()
        }),
    )
    // Hold the third actual provider request until cleanup; cancellation must finish
    // the pending prompt before that response is released.
    const stub = await startStub((turn, body, shell) => {
      if (!shell) return { message: { role: 'assistant', content: '继续' }, finish: 'stop' }
      if (turn >= 3) {
        runningHeld = true
        return held.then(() => ({
          message: { role: 'assistant', content: 'released' },
          finish: 'stop',
        }))
      }
      return { message: shellToolCall(shell, `printf 'tick'`), finish: 'tool_calls' }
    })
    cleanups.push(async () => {
      hold?.()
      await stub.close()
    })

    await warmProfile(
      cwd,
      profileHome,
      `http://127.0.0.1:${stub.port}/v1`,
      'official-acceptance-stub-key',
    )
    const { acp } = await launchOfficial(
      cwd,
      profileHome,
      `http://127.0.0.1:${stub.port}/v1`,
      'official-acceptance-stub-key',
      () => {
        throw Error('chief fixture refuses unexpected permission request')
      },
    )
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, REQUEST_MS)
    const created = await openSession(acp, 'session/new', cwd)
    const pending = acp.request(
      'session/prompt',
      {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: '开始一个不会立刻结束的任务' }],
      },
      REQUEST_MS,
    )
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await until(() => runningHeld, '官方 CLI 未进入挂起的真实请求', REQUEST_MS)
    expect(settled).toBe(false)
    acp.cancel(created.sessionId)
    const result = (await pending) as Record<string, any>
    expect(['cancelled', 'end_turn']).toContain(result.stopReason)
    expect(released).toBe(false)

    await acp.dispose()
    await acp.dispose()
    // 释放服务端挂起响应，确认子进程退出后没有遗留连接。
    hold?.()
    await stub.close()
  }, 100_000)
})

/** Minimal record matching the adapter's declared binding. */
function record0() {
  return {
    id: 'official',
    modelRef: mimoCodeModels()[0]!,
    acpSessionId: '',
  } as never
}

/** Full session record for the launch path. */
function sessionRecord() {
  return {
    id: 'official',
    combination: `mimo-code/${MIMO_OFM_MODEL}`,
    harnessRef: 'mimo-code',
    modelRef: mimoCodeModels()[0]!,
    cwd: '',
    acpSessionId: '',
    origin: { kind: 'harness', sessionId: 'official' },
    title: 'official',
    sandbox: 'full-access',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    turns: [],
  }
}
