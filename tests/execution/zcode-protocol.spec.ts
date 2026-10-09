import { describe, expect, test, vi } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { zcodeModeForSandbox } from '../../src/execution/host/adapters/zcode.ts'
import {
  HUAWEI_MAAS_BASE_URL,
  HUAWEI_RELAY_ALLOWED_PATHS,
  HUAWEI_RELAY_TICKET_HEADER,
  HUAWEI_MAAS_MODEL,
  HUAWEI_MAAS_PROVIDER_ID,
  ZCODE_APP_SERVER_ARGS,
  ZCODE_METHODS,
  ZCODE_PROVIDER_CONFIG_FILE_ENV,
  acpPermissionOptions,
  acpUpdatesForEvent,
  assertModelSelection,
  assertSessionMode,
  assertProtocolIdentity,
  buildBuiltinProviderConfig,
  buildPersonalProviderConfig,
  HUAWEI_DEFAULT_REASONING_LEVEL,
  modelSelection,
  redactSecret,
  startHuaweiRelay,
  resolvePermissionResponse,
  type ZcodeEvent,
} from '../../src/execution/host/adapters/zcode-protocol.ts'

const BRIDGE = resolve('src/execution/host/adapters/zcode-harness-bridge.ts')
const API_KEY = 'fake-huawei-key-must-not-leak'
const WORKSPACE = process.cwd()

/**
 * Stand-in for `zcode app-server` speaking the official ZCode Protocol: newline
 * delimited JSON-RPC, requests answered with `{id, result}` / `{id, error}`, live stream
 * pushed as `session/event` notifications, and lifecycle calls answered with the
 * official session state snapshot. It never opens a network connection, so no test can
 * reach a real model or send a real prompt.
 *
 * Behaviour switches: SEND_ERROR, TURN_FAIL, HANG, PERMISSION, FAKE_MODE, FAKE_MODEL.
 */
const FAKE_SERVER = `
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n')
const trace = (v) => appendFileSync(process.env.TRACE_FILE, JSON.stringify(v) + '\\n')
trace({ env: {
  builtinProviderConfig: process.env.${ZCODE_PROVIDER_CONFIG_FILE_ENV},
  personalProviderConfig: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
} })
let seq = 0
let permissionId = null
let sessionId = null
let deferredCreate = null
const snapshot = (id) => ({
  protocol: { name: 'ZCode Protocol', version: 1 },
  session: {
    sessionId: id,
    workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
    sessionKind: 'interactive',
    title: 'test',
    mode: process.env.FAKE_MODE || 'yolo',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
  },
  settings: {
    model: {
      available: [{ providerId: 'huawei-maas', modelId: 'glm-5.2' }],
      current: {
        providerId: process.env.FAKE_MODEL_PROVIDER || 'huawei-maas',
        modelId: process.env.FAKE_MODEL || 'glm-5.2',
      },
    },
    thoughtLevel: { enabled: false, available: [] },
    mode: { current: process.env.FAKE_MODE || 'yolo' },
  },
  projection: {},
  runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
  messages: [],
  slashCommands: [],
})
const event = (sid, type, payload) =>
  send({ method: 'session/event', params: {
    eventId: 'e' + (++seq), sessionId: sid, seq, timestamp: seq, type, payload } })
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id !== undefined && !m.method) {
    trace({ clientResponse: m })
    // The create result is withheld until the client has answered the server's
    // runtime-preferences request, exactly as the real runtime behaves. A client that
    // ignores that request never gets a session.
    if (m.id === 800 && deferredCreate) {
      const deferred = deferredCreate
      deferredCreate = null
      send(deferred)
    }
    if (m.id === permissionId) {
      permissionId = null
      event(sessionId, 'part.delta', { messageId: 'm1', partId: 'pt', field: 'text', delta: 'after-approval' })
      event(sessionId, 'turn.completed', { response: 'done', tokenCount: 1, toolCallCount: 0, duration: 1 })
    }
    return
  }
  trace({ method: m.method, params: m.params })
  if (m.method === '${ZCODE_METHODS.runtimeCapabilities}')
    return send({ id: m.id, result: { protocol: { name: 'ZCode Protocol', version: 1 }, capabilities: {} } })
  if (m.method === '${ZCODE_METHODS.sessionCreate}') {
    sessionId = 'sess-new'
    if (process.env.FAKE_NO_HANDSHAKE) return send({ id: m.id, result: snapshot(sessionId) })
    deferredCreate = { id: m.id, result: snapshot(sessionId) }
    // The official client asks for runtime preferences while creating a session.
    send({ id: 800, method: '${ZCODE_METHODS.sessionRequestRuntimePreferences}',
      params: { sessionId, scope: 'runtime-materialization' } })
    return
  }
  if (m.method === '${ZCODE_METHODS.sessionResume}') {
    sessionId = m.params.sessionId
    return send({ id: m.id, result: snapshot(sessionId) })
  }
  if (m.method === '${ZCODE_METHODS.sessionSubscribe}')
    return send({ id: m.id, result: {
      sessionId: m.params.sessionId,
      eventSeq: 0,
      events: [],
      ...(m.params.includeSnapshot ? { snapshot: snapshot(m.params.sessionId) } : {}),
    } })
  if (m.method === '${ZCODE_METHODS.sessionStop}') {
    send({ id: m.id, result: {} })
    return event(sessionId, 'turn.completed', { response: '', tokenCount: 0, toolCallCount: 0, duration: 0 })
  }
  if (m.method === '${ZCODE_METHODS.sessionSend}') {
    if (process.env.SEND_ERROR)
      return send({ id: m.id, error: { code: -32000, message: 'upstream refused ${API_KEY}' } })
    send({ id: m.id, result: { sessionId: m.params.sessionId, accepted: true, stateRevision: 1 } })
    if (process.env.PERMISSION) {
      permissionId = 900
      return send({ id: permissionId, method: 'interaction/requestPermission', params: {
        requestId: 'r1', sessionId, toolCallId: 'c1', toolName: 'bash',
        reason: 'run a command', riskLevel: 'medium', input: { command: 'ls' },
        options: [
          { optionId: 'yes', kind: 'allow', name: '允许', response: { decision: 'allow' } },
          { optionId: 'no', kind: 'deny', name: '拒绝', response: { decision: 'deny' } },
          { optionId: 'esc', kind: 'escalate', name: '升级', response: { decision: 'escalate' } },
        ],
      } })
    }
    if (process.env.RELEASED_EVENTS) {
      event(sessionId, 'model.streaming', { assistantMessageId: 'm1', partId: 'p2', kind: 'reasoning_delta', delta: 'think' })
      event(sessionId, 'tool.updated', { kind: 'scheduled', toolCallId: 'bash-1', toolName: 'Bash', input: { command: 'pwd' } })
      event(sessionId, 'tool.updated', { kind: 'result', toolCallId: 'bash-1', toolName: 'Bash', result: { output: 'C:/src/opl-dsh' }, duration: 1 })
      event(sessionId, 'model.streaming', { assistantMessageId: 'm1', partId: 'p1', kind: 'text_delta', delta: 'hello ' })
      return event(sessionId, 'turn.completed', { response: 'hello ', tokenCount: 1, toolCallCount: 1, duration: 1, resultType: process.env.RESULT_TYPE || 'success' })
    }
    event(sessionId, 'part.delta', { messageId: 'm1', partId: 'p1', field: 'text', delta: 'hello ' })
    event(sessionId, 'part.delta', { messageId: 'm1', partId: 'p2', field: 'reasoning', delta: 'think' })
    event(sessionId, 'part.delta', { messageId: 'm1', partId: 'p3', field: 'output', delta: 'tool-io-only' })
    if (process.env.TURN_FAIL)
      return event(sessionId, 'turn.failed', {
        error: { type: 'provider_error', message: 'model rejected the request' }, turnPhase: 'generate' })
    if (!process.env.HANG)
      event(sessionId, 'turn.completed', { response: 'done', tokenCount: 1, toolCallCount: 0, duration: 1 })
    return
  }
  send({ id: m.id, error: { code: -32601, message: 'method not found' } })
})
`

/** Minimal ACP client that drives the bridge exactly as the host harness does. */
class Bridge {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >()
  readonly updates: any[] = []
  readonly permissionRequests: any[] = []
  readonly diagnostics: string[] = []
  private nextId = 0
  answerPermission = 'yes'

  constructor(
    command: string,
    providerConfigFile: string,
    private readonly traceFile: string,
    env: NodeJS.ProcessEnv = {},
  ) {
    this.child = spawn(process.execPath, [BRIDGE], {
      cwd: WORKSPACE,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        OPL_ZCODE_COMMAND: command,
        OPL_ZCODE_MODEL: HUAWEI_MAAS_MODEL,
        OPL_ZCODE_PROVIDER_ID: HUAWEI_MAAS_PROVIDER_ID,
        OPL_ZCODE_PROVIDER_CONFIG_FILE: join(providerConfigFile, '..', 'provider-builtin.json'),
        OPL_ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(
          providerConfigFile,
          '..',
          'provider-personal.json',
        ),
        OPL_ZCODE_REASONING_LEVEL: 'enabled',
        OPL_ZCODE_MODE: 'yolo',
        OPL_ZCODE_PREFIX: JSON.stringify([]),
        OPL_ZCODE_DIAGNOSTICS: '1',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const m = JSON.parse(line)
      if (m.id !== undefined && !m.method) {
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        m.error
          ? p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }))
          : p.resolve(m.result)
        return
      }
      if (m.method === 'session/update') this.updates.push(m.params.update)
      else if (m.method === 'session/request_permission') {
        this.permissionRequests.push(m.params)
        this.child.stdin.write(
          JSON.stringify({ id: m.id, result: { outcome: { optionId: this.answerPermission } } }) +
            '\n',
        )
      }
    })
    createInterface({ input: this.child.stderr }).on('line', (line) => this.diagnostics.push(line))
  }

  request(method: string, params: object): Promise<any> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`bridge timeout: ${method}`))
      }, 20000)
    })
  }

  async until(predicate: (update: any) => boolean, ms = 20000): Promise<any> {
    const deadline = Date.now() + ms
    for (;;) {
      const hit = this.updates.find(predicate)
      if (hit) return hit
      if (Date.now() > deadline) throw new Error('bridge timeout waiting for update')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  /** Requests the fake official CLI actually received, read from its trace file. */
  traced(): any[] {
    if (!existsSync(this.traceFile)) return []
    return readFileSync(this.traceFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return undefined
        }
      })
      .filter((entry): entry is any => Boolean(entry))
  }

  close() {
    this.child.kill('SIGTERM')
  }
}

/**
 * Install the fake CLI inside a directory whose name contains a space, so the Windows
 * `cmd.exe` launch path is exercised with the same shape a real `Program Files` install
 * has. The launcher forwards its arguments, proving `app-server` reaches the CLI.
 */
async function installFakeCli(root: string) {
  const directory = join(root, 'ZCode CLI')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'fake-server.mjs'), FAKE_SERVER)
  const command = join(directory, 'zcode.cmd')
  await writeFile(
    command,
    `@echo off\r\n"${process.execPath}" "${join(directory, 'fake-server.mjs')}" %*\r\n`,
  )
  return { command, directory }
}

/** Every file under `dir`, as a single searchable string. */
function allFileContents(dir: string): string {
  const files: string[] = []
  const walk = (path: string) => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry)
      if (statSync(child).isDirectory()) walk(child)
      else files.push(readFileSync(child, 'utf8'))
    }
  }
  walk(dir)
  return files.join('\n')
}

async function withHarness<T>(
  run: (
    bridge: Bridge,
    cli: { command: string; directory: string },
    providerConfigFile: string,
  ) => Promise<T>,
  env: NodeJS.ProcessEnv = {},
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'opl-zcode-'))
  let bridge: Bridge | undefined
  try {
    const cli = await installFakeCli(root)
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    const providerConfigFile = join(home, 'provider.json')
    const traceFile = join(root, 'trace.ndjson')
    await writeFile(traceFile, '')
    // The bridge writes both provider files once the relay port is known.
    bridge = new Bridge(cli.command, providerConfigFile, traceFile, {
      TRACE_FILE: traceFile,
      ...env,
    })
    return await run(bridge, cli, providerConfigFile)
  } finally {
    bridge?.close()
    await rm(root, { recursive: true, force: true })
  }
}

describe('official ZCode Protocol wire contract', () => {
  test('uses the official subcommand, method literals and env variable', () => {
    expect([...ZCODE_APP_SERVER_ARGS]).toEqual(['app-server'])
    expect(ZCODE_METHODS).toEqual({
      runtimeCapabilities: 'runtime/capabilities',
      sessionRequestRuntimePreferences: 'session/requestRuntimePreferences',
      sessionCreate: 'session/create',
      sessionResume: 'session/resume',
      sessionSubscribe: 'session/subscribe',
      sessionSend: 'session/send',
      sessionStop: 'session/stop',
    })
    expect(ZCODE_PROVIDER_CONFIG_FILE_ENV).toBe('ZCODE_BUILTIN_PROVIDER_CONFIG_FILE')
    expect(HUAWEI_MAAS_BASE_URL).toBe('https://api.modelarts-maas.com/openai/v1')
    expect(modelSelection(HUAWEI_MAAS_PROVIDER_ID, HUAWEI_MAAS_MODEL).providerId).toBe(
      'huawei-maas',
    )
    expect(modelSelection(HUAWEI_MAAS_PROVIDER_ID, HUAWEI_MAAS_MODEL).modelId).toBe('glm-5.2')
  })

  test('allows full access and refuses restricted requests without an OS sandbox', () => {
    expect(zcodeModeForSandbox('full-access')).toBe('yolo')
    expect(() => zcodeModeForSandbox('read-only')).toThrow(/仅支持/)
    // No OS sandbox seam exists here, so anything else is refused rather than widened.
    expect(() => zcodeModeForSandbox('workspace')).toThrow(/仅支持/)
    expect(() => zcodeModeForSandbox('unknown')).toThrow(/仅支持/)
    expect(() => zcodeModeForSandbox('')).toThrow(/仅支持/)
  })

  test('personal layer matches the official personal schema', () => {
    const config = buildPersonalProviderConfig({
      providerId: 'huawei-maas',
      providerName: 'Huawei MaaS',
      baseUrl: 'http://127.0.0.1:9999/openai/v1',
      modelId: 'glm-5.2',
      headers: { 'x-opl-relay-ticket': 'non-secret' },
    }) as any
    // The personal schema rejects `revision`.
    expect(config.revision).toBeUndefined()
    expect(config.schemaVersion).toBe(1)
    // `providerRules` must be an array; a map makes the whole layer fall back.
    expect(Array.isArray(config.config.providerConfigRules.providerRules)).toBe(true)
    const rule = config.config.providerConfigRules.providerRules[0]
    expect(rule.providerId).toBe('huawei-maas')
    expect(rule.enabled).toBe(true)
    // Personal layer carries personalModelIds and never builtinModelIds.
    expect(rule.config.personalModelIds).toEqual(['glm-5.2'])
    expect(rule.config.builtinModelIds).toBeUndefined()
    expect(rule.config.modelOrder).toBeUndefined()
    expect(rule.config.access).toEqual({
      type: 'api-key',
      apiKey: 'opl-relay-placeholder',
      apiKeyManagementUrl: null,
    })
    expect(rule.config.api.type).toBe('openai-chat-completions')
    expect(rule.config.api.headers).toEqual({ 'x-opl-relay-ticket': 'non-secret' })
    // `modelConfigRules` requires both arrays, and `enabled` is compared strictly.
    expect(Array.isArray(config.config.modelConfigRules.providerModelRules)).toBe(true)
    expect(Array.isArray(config.config.modelConfigRules.manualProviderModelRules)).toBe(true)
    const model = config.config.modelConfigRules.providerModelRules[0]
    expect(model.config.enabled).toBe(true)
    expect(model.config.properties.contextWindow).toBe(1000000)
    expect(model.config.optionSpecs.maxOutputTokens.map).toBe(
      "{'max_completion_tokens': maxOutputTokens}",
    )
    expect(model.config.optionSpecs.maxOutputTokens.max).toBe(128000)
    expect(model.config.optionSpecs.reasoningLevel.map).toBe(
      "{'chat_template_kwargs': {'thinking': reasoningLevel == 'enabled'}}",
    )
    expect(model.config.optionSpecs.reasoningLevel.values).toEqual(['disabled', 'enabled'])
    expect(config.config.defaultModelSelection).toEqual({
      providerId: 'huawei-maas',
      modelId: 'glm-5.2',
      options: { reasoningLevel: 'enabled' },
    })
    expect(JSON.stringify(config)).not.toContain(API_KEY)
  })

  test('builtin layer carries none of the personal vocabulary', () => {
    const config = buildBuiltinProviderConfig() as any
    expect(config.schemaVersion).toBe(1)
    expect(typeof config.revision).toBe('number')
    expect(Array.isArray(config.config.providerConfigRules.templateRules)).toBe(true)
    expect(Array.isArray(config.config.providerConfigRules.providerRules)).toBe(true)
    // The builtin schema forbids these outright.
    const text = JSON.stringify(config)
    expect(text).not.toContain('standard-personal')
    expect(text).not.toContain('personalModelIds')
    expect(text).not.toContain('modelOrder')
  })

  test('sends a reasoning level, which the runtime requires for this model', () => {
    expect(modelSelection('huawei-maas', 'glm-5.2')).toEqual({
      providerId: 'huawei-maas',
      modelId: 'glm-5.2',
      options: { reasoningLevel: 'enabled' },
    })
    expect(modelSelection('huawei-maas', 'glm-5.2', 'enabled').options?.reasoningLevel).toBe(
      'enabled',
    )
    expect(HUAWEI_DEFAULT_REASONING_LEVEL).toBe('enabled')
  })

  test('verifies protocol identity from the session snapshot', () => {
    expect(() =>
      assertProtocolIdentity({ protocol: { name: 'ZCode Protocol', version: 1 } }),
    ).not.toThrow()
    expect(() =>
      assertProtocolIdentity({ protocol: { name: 'Something Else', version: 1 } }),
    ).toThrow(/协议身份/)
    expect(() => assertProtocolIdentity({})).toThrow(/缺少 protocol/)
  })

  test('fails closed when the session is on another model or mode', () => {
    const good = {
      session: { mode: 'plan' },
      settings: {
        model: { current: { providerId: 'huawei-maas', modelId: 'glm-5.2' } },
        mode: { current: 'yolo' },
        permission: { mode: 'yolo' },
      },
    }
    expect(() => assertModelSelection(good, 'huawei-maas', 'glm-5.2')).not.toThrow()
    expect(() => assertModelSelection(good, 'huawei-maas', 'glm-9')).toThrow()
    expect(() => assertModelSelection(good, 'other', 'glm-5.2')).toThrow()
    expect(() => assertModelSelection({}, 'huawei-maas', 'glm-5.2')).toThrow()
    expect(() => assertSessionMode(good, 'yolo')).not.toThrow()
    expect(() => assertSessionMode(good, 'plan')).toThrow()
    // `session.mode` is a session-info field and must never be the source of truth.
    expect(() => assertSessionMode({ session: { mode: 'yolo' } }, 'yolo')).toThrow()
    expect(() => assertSessionMode({}, 'yolo')).toThrow()
  })
})

describe('ZCode event to ACP update projection', () => {
  const event = (type: string, payload: Record<string, unknown>): ZcodeEvent => ({
    eventId: 'e1',
    sessionId: 's1',
    seq: 1,
    timestamp: 1,
    type,
    payload,
  })

  test('streams text and reasoning but drops tool IO fields', () => {
    const streamed = new Set<string>()
    expect(
      acpUpdatesForEvent(
        event('part.delta', { partId: 'p1', field: 'text', delta: 'a' }),
        streamed,
      ),
    ).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } }])
    expect(
      acpUpdatesForEvent(
        event('part.delta', { partId: 'p2', field: 'reasoning', delta: 'b' }),
        streamed,
      ),
    ).toEqual([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'b' } }])
    expect(
      acpUpdatesForEvent(
        event('part.delta', { partId: 'p3', field: 'output', delta: 'c' }),
        streamed,
      ),
    ).toEqual([])
    expect(
      acpUpdatesForEvent(
        event('part.delta', { partId: 'p4', field: 'input', delta: 'c' }),
        streamed,
      ),
    ).toEqual([])
  })

  test('projects the released app-server live stream and tool results', () => {
    const streamed = new Set<string>()
    expect(
      acpUpdatesForEvent(
        event('model.streaming', {
          kind: 'reasoning_delta',
          partId: 'thought',
          delta: 'checking',
        }),
        streamed,
      ),
    ).toEqual([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'checking' } },
    ])
    expect(
      acpUpdatesForEvent(
        event('model.streaming', {
          kind: 'text_delta',
          partId: 'answer',
          delta: 'done',
        }),
        streamed,
      ),
    ).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }])
    expect(
      acpUpdatesForEvent(
        event('model.streaming', {
          kind: 'tool_input_delta',
          delta: 'not assistant text',
        }),
        streamed,
      ),
    ).toEqual([])
    expect(
      acpUpdatesForEvent(
        event('part.upserted', {
          part: { type: 'text', partId: 'answer', text: 'done' },
        }),
        streamed,
      ),
    ).toEqual([])
    expect(
      acpUpdatesForEvent(
        event('tool.updated', {
          kind: 'scheduled',
          toolCallId: 'bash-1',
          toolName: 'Bash',
          input: { command: 'pwd' },
        }),
        streamed,
      ),
    ).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'bash-1',
        title: 'Bash',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'pwd' },
      },
    ])
    expect(
      acpUpdatesForEvent(
        event('tool.updated', {
          kind: 'result',
          toolCallId: 'bash-1',
          toolName: 'Bash',
          result: { output: 'C:/src/opl-dsh' },
        }),
        streamed,
      ),
    ).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'bash-1',
        title: 'Bash',
        kind: 'execute',
        status: 'completed',
        rawOutput: { output: 'C:/src/opl-dsh' },
      },
    ])
    expect(
      acpUpdatesForEvent(
        event('tool.updated', {
          kind: 'error',
          toolCallId: 'bash-1',
          error: { message: 'failed' },
        }),
        streamed,
      ),
    ).toMatchObject([{ status: 'failed', rawOutput: { message: 'failed' } }])
    expect(
      acpUpdatesForEvent(event('session.titleUpdated', { title: 'Read-only check' }), streamed),
    ).toEqual([{ sessionUpdate: 'session_info_update', title: 'Read-only check' }])
  })

  test('does not re-emit a streamed part as a full upsert, but does replay a cold part', () => {
    const streamed = new Set<string>()
    acpUpdatesForEvent(event('part.delta', { partId: 'p1', field: 'text', delta: 'a' }), streamed)
    expect(
      acpUpdatesForEvent(
        event('part.upserted', { part: { type: 'text', partId: 'p1', text: 'a' } }),
        streamed,
      ),
    ).toEqual([])
    expect(
      acpUpdatesForEvent(
        event('part.upserted', { part: { type: 'text', partId: 'p9', text: 'cold' } }),
        streamed,
      ),
    ).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cold' } }])
  })

  test('maps the official tool state machine onto tool_call and tool_call_update', () => {
    const streamed = new Set<string>()
    const part = (status: string) => ({
      part: {
        type: 'tool',
        partId: 'p',
        messageId: 'm',
        sessionId: 's',
        callId: 'c1',
        tool: 'bash',
        state: { status },
      },
    })
    expect(acpUpdatesForEvent(event('part.upserted', part('running')), streamed)).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'bash',
        kind: 'other',
        status: 'in_progress',
      },
    ])
    expect(acpUpdatesForEvent(event('part.upserted', part('completed')), streamed)).toEqual([
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', kind: 'other', status: 'completed' },
    ])
    expect(acpUpdatesForEvent(event('part.upserted', part('error')), streamed)).toEqual([
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', kind: 'other', status: 'failed' },
    ])
  })
})

describe('permission and secret handling', () => {
  const options = [
    { optionId: 'yes', kind: 'k', name: '允许', response: { decision: 'allow' as const } },
    { optionId: 'no', kind: 'k', name: '拒绝', response: { decision: 'deny' as const } },
    { optionId: 'esc', kind: 'k', name: '升级', response: { decision: 'escalate' as const } },
  ]

  test('drops ZCode decisions ACP cannot represent', () => {
    expect(acpPermissionOptions(options)).toEqual([
      { optionId: 'yes', name: '允许', kind: 'allow_once' },
      { optionId: 'no', name: '拒绝', kind: 'reject_once' },
    ])
  })

  test('fails closed when the answer does not match a known option', () => {
    expect(resolvePermissionResponse(options, 'yes')).toEqual({ decision: 'allow' })
    expect(resolvePermissionResponse(options, 'missing')).toEqual({ decision: 'deny' })
    expect(resolvePermissionResponse(options, undefined).decision).toBe('deny')
    expect(resolvePermissionResponse([options[0]], 'unknown').decision).toBe('deny')
  })

  test('redacts the credential from anything surfaced', () => {
    expect(redactSecret(`boom ${API_KEY}`, API_KEY)).toBe('boom [REDACTED]')
    expect(redactSecret('boom', undefined)).toBe('boom')
  })
})

describe('bridge against a fake official app-server', () => {
  test('delivers the released runtime stream and tool output through ACP', async () => {
    await withHarness(
      async (bridge) => {
        await bridge.request('initialize', {})
        const created = await bridge.request('session/new', { cwd: WORKSPACE })
        const result = await bridge.request('session/prompt', {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'hi' }],
        })
        expect(result.stopReason).toBe('end_turn')
        expect(bridge.updates).toContainEqual({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello ' },
        })
        expect(bridge.updates).toContainEqual({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'think' },
        })
        expect(bridge.updates).toContainEqual({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'bash-1',
          title: 'Bash',
          kind: 'execute',
          status: 'completed',
          rawOutput: { output: 'C:/src/opl-dsh' },
        })
      },
      { RELEASED_EVENTS: '1' },
    )
  })

  test('rejects an execution error carried by turn.completed', async () => {
    await withHarness(
      async (bridge) => {
        await bridge.request('initialize', {})
        const created = await bridge.request('session/new', { cwd: WORKSPACE })
        await expect(
          bridge.request('session/prompt', {
            sessionId: created.sessionId,
            prompt: [{ type: 'text', text: 'hi' }],
          }),
        ).rejects.toThrow()
        expect(bridge.diagnostics.join('\n')).not.toContain(API_KEY)
      },
      { RELEASED_EVENTS: '1', RESULT_TYPE: 'error_during_execution' },
    )
  })

  test('creates a yolo session, sends per-request auth, streams and completes', async () => {
    await withHarness(async (bridge, _cli, providerConfigFile) => {
      const init = await bridge.request('initialize', {})
      expect(init.protocolVersion).toBe(1)
      expect(init.agentCapabilities.loadSession).toBe(true)

      const created = await bridge.request('session/new', { cwd: WORKSPACE })
      expect(created.sessionId).toBe('sess-new')

      const result = await bridge.request('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      })
      expect(result.stopReason).toBe('end_turn')

      expect(bridge.updates).toContainEqual({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello ' },
      })
      expect(bridge.updates).toContainEqual({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'think' },
      })
      // `field: "output"` is tool IO and must never surface as agent prose.
      expect(JSON.stringify(bridge.updates)).not.toContain('tool-io-only')

      const traced = bridge.traced()
      const createdTrace = traced.find((r) => r.method === ZCODE_METHODS.sessionCreate)
      expect(createdTrace.params.workspace).toEqual({
        workspacePath: WORKSPACE,
        workspaceKey: WORKSPACE,
      })
      // The authorized full-access mode, not a default.
      expect(createdTrace.params.mode).toBe('yolo')
      expect(createdTrace.params.model).toEqual({
        providerId: 'huawei-maas',
        modelId: 'glm-5.2',
        options: { reasoningLevel: 'enabled' },
      })

      const sends = traced.filter((r) => r.method === ZCODE_METHODS.sessionSend)
      expect(sends).toHaveLength(1)
      expect(sends[0].params.content).toBe('hi')
      expect(sends[0].params.modelSelection).toEqual({
        providerId: 'huawei-maas',
        modelId: 'glm-5.2',
        options: { reasoningLevel: 'enabled' },
      })
      // The credential is NOT sent through the protocol; a plain api-key provider
      // ignores requestAuth (runner.ts), so nothing secret may appear here.
      expect(sends[0].params.modelExecution).toBeUndefined()
      expect(JSON.stringify(sends[0].params)).not.toContain(API_KEY)
      // The mode is re-checked against live server state before the send.
      const probes = traced.filter(
        (r) => r.method === ZCODE_METHODS.sessionSubscribe && r.params.includeSnapshot === true,
      )
      expect(probes.length).toBeGreaterThanOrEqual(1)

      // The official CLI was pointed at the provider config this task owns, as a pair.
      expect(traced[0].env.builtinProviderConfig).toBe(
        join(providerConfigFile, '..', 'provider-builtin.json'),
      )
      expect(traced[0].env.personalProviderConfig).toBeTruthy()

      // Runtime preferences were answered, so session creation is not blocked.
      expect(traced.some((r) => r.method === ZCODE_METHODS.runtimeCapabilities)).toBe(true)
    })
  })

  test('answers runtime preferences so session creation is not blocked', async () => {
    await withHarness(async (bridge) => {
      await bridge.request('initialize', {})
      // `session/new` succeeds only if the bridge answered the runtime-preferences
      // request instead of rejecting every non-permission request.
      const created = await bridge.request('session/new', { cwd: WORKSPACE })
      expect(created.sessionId).toBe('sess-new')
      const answer = bridge
        .traced()
        .find((r) => r.clientResponse && r.clientResponse.result?.memoryEnabled !== undefined)
      expect(answer.clientResponse.result).toEqual({
        // Auto-resolution must be off: an approval is answered by the user, not the CLI.
        askUserQuestionAutoResolutionEnabled: false,
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: false,
        modelContextBudgetStrategy: 'preflight-v1',
      })
    })
  })

  test('writes no credential to any file on disk', async () => {
    await withHarness(async (bridge, _cli, providerConfigFile) => {
      await bridge.request('initialize', {})
      const personal = await readFile(
        join(providerConfigFile, '..', 'provider-personal.json'),
        'utf8',
      )
      // The relay base URL is loopback, not the Huawei origin: the CLI only ever talks
      // to this machine.
      expect(personal).toContain('http://127.0.0.1:')
      expect(personal).not.toContain(HUAWEI_MAAS_BASE_URL)
      expect(personal).toContain('opl-relay-placeholder')
      expect(personal).not.toContain(API_KEY)
      const home = join(providerConfigFile, '..')
      expect(allFileContents(home)).not.toContain(API_KEY)
    })
  })

  test('refuses a session that came back on another model', async () => {
    await withHarness(
      async (bridge) => {
        await bridge.request('initialize', {})
        await expect(bridge.request('session/new', { cwd: WORKSPACE })).rejects.toThrow(
          '官方 Harness 调用未完成',
        )
      },
      { FAKE_MODEL: 'glm-4' },
    )
  })

  test('refuses a session whose mode does not match the authorization', async () => {
    await withHarness(
      async (bridge) => {
        await bridge.request('initialize', {})
        await expect(bridge.request('session/new', { cwd: WORKSPACE })).rejects.toThrow(
          '官方 Harness 调用未完成',
        )
      },
      { FAKE_MODE: 'plan' },
    )
  })

  test('resumes an existing session and re-checks the mode before sending', async () => {
    await withHarness(async (bridge) => {
      await bridge.request('initialize', {})
      const loaded = await bridge.request('session/load', { cwd: WORKSPACE, sessionId: 'sess-old' })
      expect(loaded.sessionId).toBe('sess-old')
      const resume = bridge.traced().find((r) => r.method === ZCODE_METHODS.sessionResume)
      expect(resume.params.sessionId).toBe('sess-old')
      expect(resume.params).not.toHaveProperty('toolAllowlist')
      expect(resume.params).not.toHaveProperty('toolDenylist')
      const result = await bridge.request('session/prompt', {
        sessionId: 'sess-old',
        prompt: [{ type: 'text', text: 'again' }],
      })
      expect(result.stopReason).toBe('end_turn')
      const probes = bridge
        .traced()
        .filter(
          (r) => r.method === ZCODE_METHODS.sessionSubscribe && r.params.includeSnapshot === true,
        )
      expect(probes).toHaveLength(1)
    })
  })

  test('cancel issues session/stop and reports a cancelled turn', async () => {
    await withHarness(
      async (bridge) => {
        await bridge.request('initialize', {})
        const created = await bridge.request('session/new', { cwd: WORKSPACE })
        const pending = bridge.request('session/prompt', {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'stop me' }],
        })
        await bridge.until((u) => u.sessionUpdate === 'agent_message_chunk')
        await bridge.request('session/cancel', { sessionId: created.sessionId })
        expect((await pending).stopReason).toBe('cancelled')
        expect(bridge.traced().some((r) => r.method === ZCODE_METHODS.sessionStop)).toBe(true)
      },
      { HANG: '1' },
    )
  })

  test('routes a human approval to the host and returns the chosen decision', async () => {
    await withHarness(
      async (bridge) => {
        await bridge.request('initialize', {})
        const created = await bridge.request('session/new', { cwd: WORKSPACE })
        const result = await bridge.request('session/prompt', {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'approve' }],
        })
        expect(result.stopReason).toBe('end_turn')
        // The bridge asks; it never answers on the user's behalf.
        expect(bridge.permissionRequests).toHaveLength(1)
        expect(bridge.permissionRequests[0].options).toEqual([
          { optionId: 'yes', name: '允许', kind: 'allow_once' },
          { optionId: 'no', name: '拒绝', kind: 'reject_once' },
        ])
        const answer = bridge
          .traced()
          .map((r) => r.clientResponse)
          .find((m) => m?.result?.decision !== undefined)
        expect(answer.result).toEqual({ decision: 'allow' })
      },
      { PERMISSION: '1' },
    )
  })

  test('returns the deny decision when the user rejects', async () => {
    await withHarness(
      async (bridge) => {
        bridge.answerPermission = 'no'
        await bridge.request('initialize', {})
        const created = await bridge.request('session/new', { cwd: WORKSPACE })
        await bridge.request('session/prompt', {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'approve' }],
        })
        const answer = bridge
          .traced()
          .map((r) => r.clientResponse)
          .find((m) => m?.result?.decision !== undefined)
        expect(answer.result).toEqual({ decision: 'deny' })
      },
      { PERMISSION: '1' },
    )
  })

  test('a rejected send fails the turn and never echoes the credential', async () => {
    await withHarness(
      async (bridge) => {
        await bridge.request('initialize', {})
        const created = await bridge.request('session/new', { cwd: WORKSPACE })
        await expect(
          bridge.request('session/prompt', {
            sessionId: created.sessionId,
            prompt: [{ type: 'text', text: 'x' }],
          }),
        ).rejects.toThrow('官方 Harness 调用未完成')
        expect(bridge.diagnostics.join('\n')).not.toContain(API_KEY)
      },
      { SEND_ERROR: '1' },
    )
  })

  test('turn.failed fails the turn and redacts the credential in diagnostics only', async () => {
    await withHarness(
      async (bridge) => {
        await bridge.request('initialize', {})
        const created = await bridge.request('session/new', { cwd: WORKSPACE })
        // The host is told only that the call failed; the upstream reason is not
        // forwarded, so it cannot leak into a session record or a UI transcript.
        await expect(
          bridge.request('session/prompt', {
            sessionId: created.sessionId,
            prompt: [{ type: 'text', text: 'x' }],
          }),
        ).rejects.toThrow('官方 Harness 调用未完成')
        const diagnostics = bridge.diagnostics.join('\n')
        expect(diagnostics).toContain('model rejected the request')
        expect(diagnostics).not.toContain(API_KEY)
        expect(JSON.stringify(bridge.updates)).not.toContain(API_KEY)
      },
      { TURN_FAIL: '1' },
    )
  })

  test('a mismatched session id is refused', async () => {
    await withHarness(async (bridge) => {
      await bridge.request('initialize', {})
      await bridge.request('session/new', { cwd: WORKSPACE })
      await expect(
        bridge.request('session/prompt', {
          sessionId: 'not-the-bound-session',
          prompt: [{ type: 'text', text: 'x' }],
        }),
      ).rejects.toThrow('官方 Harness 调用未完成')
    })
  })

  test('proves a spaced Windows path is launched with app-server verbatim', async () => {
    await withHarness(async (bridge, cli) => {
      expect(cli.directory).toMatch(/ /)
      expect(cli.command).toMatch(/zcode\.cmd$/)
      const init = await bridge.request('initialize', {})
      expect(init.agentInfo.name).toBe('zcode')
      expect(init.agentInfo.version).toBe('ZCode Protocol 1')
    })
  })
})

const SSE_FIRST = 'data: first'
const SSE_SECOND = 'data: second'

describe('loopback credential relay', () => {
  const httpGet = async (url: string, headers: Record<string, string>, method = 'POST') => {
    const { request } = await import('node:http')
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      // A fresh connection per request and a hard deadline, so a stuck socket fails
      // this assertion instead of silently consuming the whole test budget.
      const req = request(url, { method, headers, agent: false }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.setTimeout(3000, () => {
        req.destroy()
        reject(new Error(`relay request timed out: ${method} ${url}`))
      })
      req.on('error', reject)
      // Only methods that carry a body may send one; a body on HEAD/GET is rejected by
      // the parser before the relay ever sees it.
      if (method === 'POST' || method === 'PUT') req.end('{}')
      else req.end()
    })
  }

  test('refuses a request without the per-session ticket', async () => {
    const relay = await startHuaweiRelay(async () => 'never-used')
    try {
      const target = `${relay.baseUrl}/chat/completions`
      expect((await httpGet(target, {})).status).toBe(403)
      expect((await httpGet(target, { [HUAWEI_RELAY_TICKET_HEADER]: 'wrong' })).status).toBe(403)
      expect(
        (await httpGet(target, { [HUAWEI_RELAY_TICKET_HEADER]: relay.ticket })).status,
      ).not.toBe(403)
    } finally {
      relay.close()
    }
  })

  test('refuses every method except the completion POST', async () => {
    const relay = await startHuaweiRelay(async () => 'never-used')
    try {
      const headers = { [HUAWEI_RELAY_TICKET_HEADER]: relay.ticket }
      const url = `${relay.baseUrl}/chat/completions`
      for (const method of ['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
        const res = await httpGet(url, headers, method)
        expect([404, 405, 501]).toContain(res.status)
      }
    } finally {
      relay.close()
    }
  })

  test('refuses any path outside the fixed allow list', async () => {
    const relay = await startHuaweiRelay(async () => 'never-used')
    try {
      const headers = { [HUAWEI_RELAY_TICKET_HEADER]: relay.ticket }
      for (const path of ['/', '/admin', '/models', '/openai/v1/../../secrets']) {
        const res = await httpGet(`${relay.baseUrl}${path}`, headers)
        // Nothing outside the allow list is ever forwarded upstream.
        expect([404, 405]).toContain(res.status)
      }
    } finally {
      relay.close()
    }
  })

  test('refuses when no credential is available instead of sending unauthenticated', async () => {
    const relay = await startHuaweiRelay(async () => undefined)
    try {
      const res = await httpGet(`${relay.baseUrl}/chat/completions`, {
        [HUAWEI_RELAY_TICKET_HEADER]: relay.ticket,
      })
      expect(res.status).toBe(503)
    } finally {
      relay.close()
    }
  })

  test('binds loopback only and never exposes the upstream origin', async () => {
    const relay = await startHuaweiRelay(async () => 'k')
    try {
      expect(relay.baseUrl.startsWith('http://127.0.0.1:')).toBe(true)
      expect(relay.baseUrl).not.toContain('modelarts')
      // The ticket is per-session and not the credential.
      expect(relay.ticket).not.toBe('k')
    } finally {
      relay.close()
    }
  })

  test('swaps the placeholder for the real credential on the wire and streams back', async () => {
    const seen: any[] = []
    const chunks: string[] = []
    vi.doMock('node:https', async () => ({
      ...(await vi.importActual<typeof import('node:https')>('node:https')),
      request: (_url: string, options: any, cb: any) => {
        seen.push({ headers: options.headers })
        return {
          on: () => undefined,
          destroy: () => undefined,
          setTimeout: () => undefined,
          end: () => {
            // Two separate writes, so a pass-through relay and a buffered one differ.
            cb({
              statusCode: 200,
              headers: { 'content-type': 'text/event-stream' },
              on: (event: string, handler: (value: string) => void) => {
                if (event === 'data') handler(chunks.shift() ?? '')
              },
              pipe: (target: { write: (value: string) => void; end: () => void }) => {
                for (const chunk of chunks) target.write(chunk)
                target.end()
              },
            })
            chunks.length = 0
          },
        }
      },
    }))
    chunks.push(SSE_FIRST)
    const second = SSE_SECOND
    vi.resetModules()
    const { startHuaweiRelay: relayFactory } = await import(
      '../../src/execution/host/adapters/zcode-protocol.ts'
    )
    const relay = await relayFactory(async () => API_KEY)
    try {
      chunks.length = 0
      chunks.push(SSE_FIRST, second)
      const { request } = await import('node:http')
      const received: string[] = []
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          `${relay.baseUrl}/chat/completions`,
          { method: 'POST', headers: { [HUAWEI_RELAY_TICKET_HEADER]: relay.ticket } },
          (res) => {
            res.on('data', (c) => received.push(String(c)))
            res.on('end', () => resolve(res.statusCode ?? 0))
          },
        )
        req.on('error', reject)
        req.end('{"model":"glm-5.2"}')
      })
      expect(status).toBe(200)
      expect(seen).toHaveLength(1)
      // The real credential is substituted on the wire.
      expect(seen[0].headers.authorization).toBe(`Bearer ${API_KEY}`)
      // The placeholder never reaches the upstream request.
      expect(JSON.stringify(seen[0].headers)).not.toContain('opl-relay-placeholder')
      // Streaming content arrives through, and the key is not echoed back.
      expect(received.join('')).toContain(SSE_FIRST)
      expect(received.join('')).toContain(SSE_SECOND)
      expect(JSON.stringify(received)).not.toContain(API_KEY)
    } finally {
      relay.close()
      vi.doUnmock('node:https')
      vi.resetModules()
    }
  })
})
