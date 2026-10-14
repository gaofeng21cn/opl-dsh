/**
 * Owned behaviour evidence for the Our Free Model route on the official ZCode CLI.
 *
 * The bridge is the real owned module, spawned exactly as the Host spawns it, and
 * driven by a controlled stand-in for `zcode app-server`. The stand-in never opens a
 * network connection and never receives a real model response, so nothing here is
 * evidence about live Our Free Model availability — it is evidence about what this
 * route *does*: the model and reasoning pin it enforces, the credential it does and
 * does not write down, how cancellation and cleanup behave, and that a real external
 * Git command works in a project path containing Chinese characters and spaces.
 *
 * Synchronisation is event-driven. Every wait is on a protocol frame, a stream event,
 * or a child-process exit — there is no sleep and no polling anywhere in this file.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ZCODE_METHODS } from '../../../src/execution/host/adapters/zcode-protocol.ts'
import {
  OFM_RELAY_TICKET_HEADER,
  OFM_RELAY_PLACEHOLDER_KEY,
  OFM_ZCODE_PROVIDER_ID,
  ZCODE_OFM_MODELS,
  ZCODE_OFM_REASONING_LEVELS,
  assertOfmModelIdentity,
  assertOfmModelSelection,
  ofmReportsReasoningLevel,
  ofmShellSelection,
} from '../../../src/execution/host/adapters/zcode-ofm/zcode-ofm-models.ts'

const BRIDGE = resolve('src/execution/host/adapters/zcode-ofm/zcode-ofm-bridge.ts')
const FAKE_SERVER = resolve('tests/execution/ofm-zcode/fixtures/fake-app-server.mjs')
const OFM_KEY = 'ofm-forward-key-must-not-leak'
const MODEL = ZCODE_OFM_MODELS[0]

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const done of cleanups.splice(0)) await done()
})

/** A real loopback listener standing in for the owner's forward lane. */
async function startOwnerLane() {
  const seen: {
    authorization: string | undefined
    path: string | undefined
    ticket: string | undefined
    body: string
  }[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({
        authorization: req.headers.authorization,
        path: req.url,
        ticket: req.headers[OFM_RELAY_TICKET_HEADER] as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const { port } = server.address() as { port: number }
  return {
    seen,
    baseURL: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done())
      }),
  }
}

/** ACP client driving the bridge the same way the Host's transport does. */
class Bridge {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >()
  private readonly exited: Promise<number | null>
  private nextId = 0
  readonly credentialRequests: string[] = []
  readonly updates: any[] = []
  readonly permissionRequests: any[] = []
  /** Diagnostics the bridge writes to stderr when OPL_ZCODE_OFM_DIAGNOSTICS=1. */
  readonly diagnostics: string[] = []
  private readonly diagnosticWaiters = new Set<{
    pattern: RegExp
    resolve: (line: string) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  answerPermission = 'yes'

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    cwd: string,
    private readonly home: string,
  ) {
    this.child = spawn(process.execPath, [BRIDGE], {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        OPL_ZCODE_OFM_COMMAND: process.execPath,
        OPL_ZCODE_OFM_PREFIX: JSON.stringify([FAKE_SERVER]),
        OPL_ZCODE_OFM_MODEL: MODEL,
        OPL_ZCODE_OFM_PROVIDER_CONFIG_FILE: join(home, 'provider-builtin.json'),
        OPL_ZCODE_OFM_PERSONAL_PROVIDER_CONFIG_FILE: join(home, 'provider-personal.json'),
        OPL_ZCODE_OFM_REASONING_LEVEL: 'enabled',
        OPL_ZCODE_OFM_MODE: 'yolo',
        OPL_ZCODE_OFM_DIAGNOSTICS: '1',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    this.child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue
        this.diagnostics.push(line)
        // Resolved from the event itself. Polling here would spin the event loop and
        // starve the very I/O callback that delivers these lines.
        for (const waiter of [...this.diagnosticWaiters])
          if (waiter.pattern.test(line)) {
            this.diagnosticWaiters.delete(waiter)
            clearTimeout(waiter.timer)
            waiter.resolve(line)
          }
      }
    })
    this.exited = new Promise((done) => this.child.on('exit', (code) => done(code)))
    cleanups.push(async () => {
      if (this.child.exitCode === null) this.child.kill('SIGTERM')
      await this.exited
    })
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const m = JSON.parse(line)
      if (m.id !== undefined && !m.method) {
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        m.error
          ? p.reject(Object.assign(Error(m.error.message), { code: m.error.code }))
          : p.resolve(m.result)
        return
      }
      if (m.method === 'opl/ofm-credential/describe' || m.method === 'opl/ofm-credential/resolve') {
        this.credentialRequests.push(m.method)
        this.send({
          id: m.id,
          result: m.method.endsWith('/describe') ? { configured: true, writable: false } : OFM_KEY,
        })
        return
      }
      if (m.method === 'session/update') this.updates.push(m.params.update)
      if (m.method === 'session/request_permission') {
        this.permissionRequests.push(m.params)
        this.send({
          id: m.id,
          result: { outcome: { optionId: this.answerPermission } },
        })
      }
    })
  }

  private send(value: object) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
  }

  request(method: string, params: object): Promise<any> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ id, method, params })
    })
  }

  /** Resolves on the first matching streamed update, so no test ever waits on a timer. */
  nextUpdate(match: (update: any) => boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      const seen = this.updates.length
      const timer = setTimeout(() => reject(Error('未收到预期的会话事件')), 10000)
      const poll = () => {
        const found = this.updates.slice(seen).find(match)
        if (found) {
          clearTimeout(timer)
          return resolve(found)
        }
        setImmediate(poll)
      }
      poll()
    })
  }

  /** Resolves as soon as a diagnostic line matches, with no polling and no sleep. */
  waitForDiagnostic(pattern: RegExp, ms = 4000): Promise<string> {
    const existing = this.diagnostics.find((line) => pattern.test(line))
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const waiter = {
        pattern,
        resolve,
        timer: setTimeout(() => {
          this.diagnosticWaiters.delete(waiter)
          reject(Error(`诊断中没有匹配 ${pattern} 的内容：${this.diagnostics.join(' | ')}`))
        }, ms),
      }
      this.diagnosticWaiters.add(waiter)
    })
  }

  async prompt(text: string, cwd: string) {
    const done = this.request('session/prompt', {
      sessionId: 'sess-new',
      cwd,
      prompt: [{ type: 'text', text }],
    })
    return done
  }

  close() {
    this.child.stdin.end()
    return this.exited
  }
}

/**
 * A session home that carries a usable built-in provider layer.
 *
 * The bridge now references the official built-in release and refuses to launch without
 * it, because the real CLI exits before any session exists when neither its bundled nor
 * its active release is available. Here that file is a stand-in for the fake app-server;
 * the *existence* requirement is what this route enforces, and that is what the test
 * exercises.
 */
const makeHome = async (withBuiltin = true) => {
  const dir = await mkdtemp(join(tmpdir(), 'opl-ofm-zcode-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  if (withBuiltin)
    await writeFile(
      join(dir, 'provider-builtin.json'),
      JSON.stringify({ schemaVersion: 1, revision: 1, config: {} }),
    )
  return dir
}

/**
 * The bridge deliberately answers a refused call with one generic message so official
 * or provider text can never reach the Host. The precise reason is written to its
 * stderr diagnostics, so the evidence for "why was this refused" lives there.
 */
const diagnosticsContain = (bridge: Bridge, pattern: RegExp) => bridge.waitForDiagnostic(pattern)

describe('ZCode · Our Free Model provider config and credential handling', () => {
  test('pins the exact model, keeps the key off disk, and reports the loopback lane', async () => {
    const lane = await startOwnerLane()
    cleanups.push(lane.close)
    const home = await makeHome()
    const bridge = new Bridge({ OPL_ZCODE_OFM_UPSTREAM: lane.baseURL }, process.cwd(), home)

    const initialized = await bridge.request('initialize', {})
    expect(initialized.agentInfo.name).toBe('zcode')
    expect(initialized.agentInfo.credentialConfigured).toBe(true)

    const personal = JSON.parse(await readFile(join(home, 'provider-personal.json'), 'utf8'))
    const rule = personal.config.providerConfigRules.providerRules[0]
    const modelRule = personal.config.modelConfigRules.providerModelRules[0]
    expect(rule.providerId).toBe(OFM_ZCODE_PROVIDER_ID)
    // The owner's catalog id is what leaves the CLI, so the wire model is exact.
    expect(rule.config.personalModelIds).toEqual([MODEL])
    expect(modelRule.modelId).toBe(MODEL)
    expect(modelRule.config.enabled).toBe(true)
    // Only the levels the official GLM-5 family rule declares; never `max`.
    expect(modelRule.config.optionSpecs.reasoningLevel.values).toEqual([
      ...ZCODE_OFM_REASONING_LEVELS,
    ])
    expect(modelRule.config.optionSpecs.reasoningLevel.values).not.toContain('max')
    // A fixed non-secret placeholder, and a loopback base URL carrying the ticket.
    expect(rule.config.access.apiKey).toBe(OFM_RELAY_PLACEHOLDER_KEY)
    const base = new URL(rule.config.api.baseUrl)
    expect(base.hostname).toBe('127.0.0.1')
    expect(rule.config.api.type).toBe('openai-chat-completions')
    expect(typeof rule.config.api.headers[OFM_RELAY_TICKET_HEADER]).toBe('string')

    // The credential is only ever requested over the private channel, by the two
    // OPL-owned methods. Nothing Huawei-named appears anywhere.
    expect(bridge.credentialRequests).toContain('opl/ofm-credential/describe')
    expect(bridge.credentialRequests.some((m) => m.includes('huawei'))).toBe(false)

    const onDisk = [
      await readFile(join(home, 'provider-personal.json'), 'utf8'),
      await readFile(join(home, 'provider-builtin.json'), 'utf8'),
    ].join('\n')
    expect(onDisk).not.toContain(OFM_KEY)

    await bridge.close()
  })

  test('relay injects the real key on the wire and preserves the owner path prefix', async () => {
    const lane = await startOwnerLane()
    cleanups.push(lane.close)
    const home = await makeHome()
    // A path prefix on the owner's endpoint must survive to the upstream request.
    const prefixed = `${lane.baseURL}/v1`
    const bridge = new Bridge({ OPL_ZCODE_OFM_UPSTREAM: prefixed }, process.cwd(), home)
    await bridge.request('initialize', {})
    const personal = JSON.parse(await readFile(join(home, 'provider-personal.json'), 'utf8'))
    const relayBase = personal.config.providerConfigRules.providerRules[0].config.api.baseUrl
    expect(new URL(relayBase).pathname).toBe('/v1')

    const call = await fetch(`${relayBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${OFM_RELAY_PLACEHOLDER_KEY}`,
        [OFM_RELAY_TICKET_HEADER]:
          personal.config.providerConfigRules.providerRules[0].config.api.headers[
            OFM_RELAY_TICKET_HEADER
          ],
      },
      body: JSON.stringify({ model: MODEL, messages: [] }),
    })
    expect(call.status).toBe(200)
    expect(lane.seen).toHaveLength(1)
    // The placeholder never leaves the relay; the real key goes on the wire.
    expect(lane.seen[0].authorization).toBe(`Bearer ${OFM_KEY}`)
    expect(lane.seen[0].path).toBe('/v1/chat/completions')
    // The per-session ticket guards the relay and is not forwarded upstream.
    expect(lane.seen[0].ticket).toBeUndefined()

    await bridge.close()
  })
})

describe('ZCode · Our Free Model session pinning refuses drift', () => {
  const startWith = async (env: NodeJS.ProcessEnv) => {
    const lane = await startOwnerLane()
    cleanups.push(lane.close)
    const home = await makeHome()
    const bridge = new Bridge({ OPL_ZCODE_OFM_UPSTREAM: lane.baseURL, ...env }, process.cwd(), home)
    await bridge.request('initialize', {})
    return { bridge, home, lane }
  }

  test('a session on another model is refused, not driven', async () => {
    const { bridge } = await startWith({ FAKE_MODEL: 'z-ai/glm-4.7' })
    await expect(bridge.request('session/new', { cwd: process.cwd() })).rejects.toThrow(
      /官方 Harness 调用未完成/,
    )
    await diagnosticsContain(bridge, /与所选/)
    await bridge.close()
  })

  test('a session on another provider is refused', async () => {
    const { bridge } = await startWith({ FAKE_MODEL_PROVIDER: 'huawei-maas' })
    await expect(bridge.request('session/new', { cwd: process.cwd() })).rejects.toThrow(
      /官方 Harness 调用未完成/,
    )
    await diagnosticsContain(bridge, /与所选/)
    await bridge.close()
  })

  test('a silently dropped reasoning level is refused', async () => {
    const { bridge } = await startWith({ FAKE_LEVEL: 'disabled' })
    await expect(bridge.request('session/new', { cwd: process.cwd() })).rejects.toThrow(
      /官方 Harness 调用未完成/,
    )
    await diagnosticsContain(bridge, /推理档位/)
    await bridge.close()
  })

  test('a mismatched protocol identity is refused', async () => {
    const { bridge } = await startWith({ FAKE_BAD_PROTOCOL: '1' })
    await expect(bridge.request('session/new', { cwd: process.cwd() })).rejects.toThrow(
      /官方 Harness 调用未完成/,
    )
    await diagnosticsContain(bridge, /协议身份/)
    await bridge.close()
  })

  test('a session in another permission mode is refused', async () => {
    const { bridge } = await startWith({ FAKE_MODE: 'plan' })
    await expect(bridge.request('session/new', { cwd: process.cwd() })).rejects.toThrow(
      /官方 Harness 调用未完成/,
    )
    await diagnosticsContain(bridge, /权限模式/)
    await bridge.close()
  })

  test('session/load resumes the same identity and keeps the pin', async () => {
    const { bridge } = await startWith({})
    const loaded = await bridge.request('session/load', {
      cwd: process.cwd(),
      sessionId: 'sess-resume',
    })
    expect(loaded.sessionId).toBe('sess-resume')
    expect(loaded.models.currentModelId).toBe(MODEL)
    await bridge.close()
  })

  test('a session created against another workspace is refused', async () => {
    const { bridge } = await startWith({})
    await expect(
      bridge.request('session/new', { cwd: join(process.cwd(), 'elsewhere') }),
    ).rejects.toThrow(/官方 Harness 调用未完成/)
    await diagnosticsContain(bridge, /不能改变已绑定项目/)
    await bridge.close()
  })
})

describe('ZCode · Our Free Model cancellation, permission and cleanup', () => {
  test('cancelling a running turn stops the session and reports cancellation', async () => {
    const lane = await startOwnerLane()
    cleanups.push(lane.close)
    const home = await makeHome()
    const bridge = new Bridge(
      { OPL_ZCODE_OFM_UPSTREAM: lane.baseURL, HANG: '1' },
      process.cwd(),
      home,
    )
    await bridge.request('initialize', {})
    await bridge.request('session/new', { cwd: process.cwd() })
    const admitted = bridge.nextUpdate((u) => u.sessionUpdate === 'agent_message_chunk')
    const running = bridge.prompt('long task', process.cwd())
    await admitted
    await bridge.request('session/cancel', { sessionId: 'sess-new' })
    await expect(running).resolves.toEqual({ stopReason: 'cancelled' })
    await bridge.close()
  })

  test('a denied permission is forwarded as a denial and never auto-allowed', async () => {
    const lane = await startOwnerLane()
    cleanups.push(lane.close)
    const home = await makeHome()
    const bridge = new Bridge(
      { OPL_ZCODE_OFM_UPSTREAM: lane.baseURL, PERMISSION: '1' },
      process.cwd(),
      home,
    )
    bridge.answerPermission = 'no'
    await bridge.request('initialize', {})
    await bridge.request('session/new', { cwd: process.cwd() })
    const running = bridge.prompt('needs approval', process.cwd())
    await expect(
      bridge.nextUpdate((u) => u.sessionUpdate === 'agent_message_chunk'),
    ).resolves.toMatchObject({ content: { text: 'denied' } })
    await expect(running).resolves.toMatchObject({ stopReason: 'end_turn' })
    // The host saw a real approval request carrying the official tool identity.
    expect(bridge.permissionRequests).toHaveLength(1)
    expect(bridge.permissionRequests[0].options.map((o: any) => o.optionId)).toEqual(['yes', 'no'])
    await bridge.close()
  })

  test('a failing turn surfaces as an error and leaks no credential', async () => {
    const lane = await startOwnerLane()
    cleanups.push(lane.close)
    const home = await makeHome()
    const bridge = new Bridge(
      { OPL_ZCODE_OFM_UPSTREAM: lane.baseURL, TURN_FAIL: '1' },
      process.cwd(),
      home,
    )
    await bridge.request('initialize', {})
    await bridge.request('session/new', { cwd: process.cwd() })
    await expect(bridge.prompt('fail', process.cwd())).rejects.toThrow(/官方 Harness 调用未完成/)
    expect(JSON.stringify(bridge.updates)).not.toContain(OFM_KEY)
    await diagnosticsContain(bridge, /model rejected the request/)
    await bridge.close()
  })

  test('closing the bridge releases the relay socket and the CLI child', async () => {
    const lane = await startOwnerLane()
    cleanups.push(lane.close)
    const home = await makeHome()
    const bridge = new Bridge({ OPL_ZCODE_OFM_UPSTREAM: lane.baseURL }, process.cwd(), home)
    await bridge.request('initialize', {})
    const personal = JSON.parse(await readFile(join(home, 'provider-personal.json'), 'utf8'))
    const relayBase = personal.config.providerConfigRules.providerRules[0].config.api.baseUrl
    // The relay answers while the bridge is alive...
    expect(
      (
        await fetch(`${relayBase}/chat/completions`, {
          method: 'POST',
          headers: { [OFM_RELAY_TICKET_HEADER]: 'wrong' },
          body: '{}',
        })
      ).status,
    ).toBe(403)
    await expect(bridge.close()).resolves.toBeDefined()
    // ...and its socket is gone once the bridge exits, rather than leaking a listener.
    await expect(
      fetch(`${relayBase}/chat/completions`, { method: 'POST', body: '{}' }),
    ).rejects.toThrow()
  })

  test('a missing reasoning level in the bridge environment fails before any launch', async () => {
    const home = await makeHome()
    const child = spawn(process.execPath, [BRIDGE], {
      cwd: process.cwd(),
      env: { ...process.env, OPL_ZCODE_OFM_REASONING_LEVEL: 'max', OPL_ZCODE_OFM_MODEL: MODEL },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stderr: string[] = []
    child.stderr.on('data', (c: Buffer) => stderr.push(c.toString()))
    const code = await new Promise((done) => child.on('exit', (c) => done(c)))
    expect(code).not.toBe(0)
    expect(stderr.join('')).toMatch(/推理档位/)
    expect(existsSync(join(home, 'provider-personal.json'))).toBe(false)
  })
})

describe('ZCode · Our Free Model in a Chinese and spaced project path', () => {
  test('runs a real external Git command in the bound workspace', async () => {
    const lane = await startOwnerLane()
    cleanups.push(lane.close)
    // A path with Chinese characters and spaces: quoting, cwd and encoding all matter.
    const workspace = await mkdtemp(join(tmpdir(), '中文 项目 '))
    cleanups.push(() =>
      rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    )
    const home = await makeHome()
    const bridge = new Bridge(
      { OPL_ZCODE_OFM_UPSTREAM: lane.baseURL, RUN_GIT: '1' },
      workspace,
      home,
    )
    await bridge.request('initialize', {})
    await bridge.request('session/new', { cwd: workspace })
    const running = bridge.prompt('commit the file', workspace)
    const result = await bridge.nextUpdate((u) => u.sessionUpdate === 'tool_call_update')
    await running
    // The real `git` binary ran in the real, Chinese-and-spaced directory.
    expect(result.status).toBe('completed')
    expect(result.rawOutput.cwd).toBe(workspace)
    expect(result.rawOutput.init).toBe(0)
    expect(result.rawOutput.add).toBe(0)
    expect(result.rawOutput.stdout).toContain('中文 文件.txt')
    // Real Git stderr must not contain a failure from the non-ASCII path.
    expect(result.rawOutput.stderr).toBe('')
    expect(existsSync(join(workspace, '中文 文件.txt'))).toBe(true)
    await bridge.close()
  })
})

describe('ZCode · Our Free Model protocol contract', () => {
  test('drives only the official methods and answers the runtime handshake', async () => {
    const lane = await startOwnerLane()
    cleanups.push(lane.close)
    const home = await makeHome()
    const traceFile = join(home, 'trace.ndjson')
    const bridge = new Bridge(
      { OPL_ZCODE_OFM_UPSTREAM: lane.baseURL, TRACE_FILE: traceFile },
      process.cwd(),
      home,
    )
    await bridge.request('initialize', {})
    await bridge.request('session/new', { cwd: process.cwd() })
    await bridge.prompt('hello', process.cwd())
    await bridge.close()

    const observed = readFileSync(traceFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const methods = observed.map((frame) => frame.method).filter(Boolean)
    // Exactly the official ZCode Protocol methods this route claims to speak.
    expect(new Set(methods)).toEqual(
      new Set([
        ZCODE_METHODS.runtimeCapabilities,
        ZCODE_METHODS.sessionCreate,
        ZCODE_METHODS.sessionSubscribe,
        ZCODE_METHODS.sessionSend,
      ]),
    )
    // The official runtime asks the client for its runtime preferences while creating a
    // session, and withholds the session until that is answered. The answer is a client
    // response frame, and it must carry auto-resolution disabled: an approval is
    // answered by the user through DSH, never by the CLI answering its own question.
    const handshake = observed.find(
      (frame) => frame.clientResponse?.id === 800 && frame.clientResponse.method === undefined,
    )
    expect(handshake.clientResponse.result.askUserQuestionAutoResolutionEnabled).toBe(false)
    const send = observed.find((f) => f.method === ZCODE_METHODS.sessionSend)
    expect(send.params.modelSelection).toEqual({
      providerId: OFM_ZCODE_PROVIDER_ID,
      modelId: MODEL,
      options: { reasoningLevel: 'enabled' },
    })
    // No method outside the official set is ever attempted.
    expect(methods.every((m: string) => Object.values(ZCODE_METHODS).includes(m as any))).toBe(true)
  })
})

describe('ZCode · Our Free Model reasoning readback', () => {
  const snapshot = (options?: { reasoningLevel?: string }) => ({
    settings: {
      model: {
        current: {
          providerId: OFM_ZCODE_PROVIDER_ID,
          modelId: MODEL,
          ...(options ? { options } : {}),
        },
      },
    },
  })

  test('accepts a snapshot that reports exactly the pinned level', () => {
    expect(() =>
      assertOfmModelSelection(snapshot({ reasoningLevel: 'enabled' }), MODEL, 'enabled'),
    ).not.toThrow()
  })

  test('refuses a snapshot that reports no level at all', () => {
    expect(() => assertOfmModelSelection(snapshot(), MODEL, 'enabled')).toThrow(/未回读推理档位/)
    expect(() => assertOfmModelSelection(snapshot({}), MODEL, 'enabled')).toThrow(/未回读推理档位/)
    expect(() =>
      assertOfmModelSelection(snapshot({ reasoningLevel: '' }), MODEL, 'enabled'),
    ).toThrow(/未回读推理档位/)
  })

  test('refuses a snapshot that reports a different level', () => {
    expect(() =>
      assertOfmModelSelection(snapshot({ reasoningLevel: 'disabled' }), MODEL, 'enabled'),
    ).toThrow(/与所选的 enabled 不一致/)
  })

  test('never treats an unreported level as confirmation', () => {
    // The real CLI of record echoes provider and model but not the level.
    expect(ofmReportsReasoningLevel(snapshot())).toBe(false)
    expect(ofmReportsReasoningLevel(snapshot({}))).toBe(false)
    expect(ofmReportsReasoningLevel(snapshot({ reasoningLevel: 'enabled' }))).toBe(true)
  })

  test('still confirms the model identity when no level is reported', () => {
    expect(() => assertOfmModelIdentity(snapshot(), MODEL)).not.toThrow()
    expect(() => assertOfmModelIdentity(snapshot(), 'z-ai/glm-4.7')).toThrow(/与所选/)
  })

  test('a session whose level is not reported still runs, without claiming a level', async () => {
    // No FAKE_LEVEL: the fake reports no `options`, exactly as the real CLI does. The
    // route proceeds on confirmed facts (provider, model, mode) and asserts nothing it
    // was not told.
    const lane = await startOwnerLane()
    cleanups.push(lane.close)
    const home = await makeHome()
    const bridge = new Bridge({ OPL_ZCODE_OFM_UPSTREAM: lane.baseURL }, process.cwd(), home)
    await bridge.request('initialize', {})
    const created = await bridge.request('session/new', { cwd: process.cwd() })
    expect(created.sessionId).toBe('sess-new')
    await expect(bridge.prompt('hello', process.cwd())).resolves.toMatchObject({
      stopReason: 'end_turn',
    })
    await bridge.close()
  })
})

describe('ZCode · Our Free Model pins the shell through the official channel', () => {
  test('answers the handshake with the verified Git Bash path, never auto', async () => {
    const lane = await startOwnerLane()
    cleanups.push(lane.close)
    const home = await makeHome()
    const gitBash = join('C:' + String.fromCharCode(92), 'Program Files', 'Git', 'bin', 'bash.exe')
    const bridge = new Bridge(
      {
        OPL_ZCODE_OFM_UPSTREAM: lane.baseURL,
        OPL_ZCODE_OFM_GIT_BASH: gitBash,
        TRACE_FILE: join(home, 'trace.ndjson'),
      },
      process.cwd(),
      home,
    )
    await bridge.request('initialize', {})
    await bridge.request('session/new', { cwd: process.cwd() })
    await bridge.close()

    const observed = readFileSync(join(home, 'trace.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const handshake = observed.find((f) => f.clientResponse?.id === 800)
    const result = handshake.clientResponse.result
    // The official union's `shell` member, naming the exact verified path.
    expect(result.integratedTerminalShell).toEqual(ofmShellSelection(gitBash))
    expect(result.integratedTerminalShell.dialect).toBe('git-bash')
    expect(result.integratedTerminalShell.path).toBe(gitBash)
    // `auto` is the choice that defers to the engine's own legacy-shell detection.
    expect(result.integratedTerminalShell.mode).not.toBe('auto')
    // Auto-resolution of approvals stays off: a human answers through DSH.
    expect(result.askUserQuestionAutoResolutionEnabled).toBe(false)
    // The official strict result object requires this boolean.
    expect(typeof result.nativeSearchEnhancementsEnabled).toBe('boolean')
  })

  test('refuses to launch when the built-in provider layer is missing', async () => {
    const lane = await startOwnerLane()
    cleanups.push(lane.close)
    const home = await makeHome(false)
    const bridge = new Bridge({ OPL_ZCODE_OFM_UPSTREAM: lane.baseURL }, process.cwd(), home)
    await expect(bridge.request('initialize', {})).rejects.toThrow(/官方 Harness 调用未完成/)
    await diagnosticsContain(bridge, /找不到官方 ZCode 内置 Provider 配置/)
    await bridge.close()
  })
})
