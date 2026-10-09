import { mkdir, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
  type GenerateOptions,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { HarnessSessionStore } from '../../src/execution/host/session-store.ts'
import {
  HarnessService,
  GROK_COMBINATION,
  grokConfiguration,
} from '../../src/execution/host/harness.ts'
import { adapterFor } from '../../src/execution/host/adapters/index.ts'
import { commandLaunch } from '../../src/execution/host/harness-registry.ts'
import { systemEnvironment } from '../../src/execution/host/adapters/environment.ts'
import { resolveGatewayExecution } from '../../src/gateway/host/execution-access.ts'
import { GROK_API_KEY_REF } from '../../src/gateway/host/config.ts'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})

/**
 * Run the generic ACP transport and lifecycle cases against a Node fixture agent.
 *
 * Every case in this file drives the harness' own persistence, approvals, deduplication,
 * concurrency, resume, cancellation and conversation streaming against
 * `tests/fixtures/acp-agent.mjs`. None of them is a test of an official CLI's OS sandbox.
 *
 * Production Grok deliberately refuses restricted tiers on Windows, because its official
 * sandbox has no backend on this platform. That refusal is correct, and it is verified
 * separately against the real adapter in the Grok suite. To keep this file about the harness,
 * the adapter's `prepare` step is replaced for exactly this Node fixture:
 *
 * - only the adapter's launch step is replaced; the `HarnessService` under test stays real;
 * - the configuration file and gateway-key handling stay real, reusing the production helpers;
 * - no production module gains a test hook, no platform is faked, and no lifecycle, approval,
 *   permission or deduplication assertion is removed or weakened.
 *
 * A passing case here therefore says nothing about whether an official CLI's sandbox works.
 * @returns nothing; installs the fixture-only adapter preparation.
 */
function useNodeAcpFixtureAgent() {
  const adapter = adapterFor('grok-build', {
    provider: 'opl-gateway',
    model: 'grok::grok-4.7',
  })
  if (!adapter) throw Error('fixture seam requires the Grok adapter entry')
  vi.spyOn(adapter, 'prepare').mockImplementation(async (ctx, record, options) => {
    if (
      options.prefix?.length !== 1 ||
      options.prefix[0] !== resolve('tests/fixtures/acp-agent.mjs')
    )
      throw Error('The fixture adapter only launches the Node ACP fixture')
    const route = await resolveGatewayExecution(ctx, record.modelRef, options.resolveKey)
    const home = join(options.home, 'harnesses', 'grok-build')
    await mkdir(home, { recursive: true, mode: 0o700 })
    // The real configuration layout is still written, so the credential assertions below
    // still hold.
    const config = join(home, 'config.toml'),
      bytes = grokConfiguration(route.baseURL)
    const current = await readFile(config, 'utf8').catch(() => undefined)
    if (current === undefined) await writeFile(config, bytes, { mode: 0o600, flag: 'wx' })
    else if (current !== bytes) await writeFile(config, bytes, { mode: 0o600 })
    // A Node fixture agent has no OS sandbox, so it takes neutral fixture flags. These say
    // nothing about the official Grok tiers.
    const launch = commandLaunch(process.execPath, [
      ...(options.prefix ?? []),
      '--cwd',
      record.cwd,
      '--model',
      'grok-4.7',
      '--sandbox',
      record.sandbox === 'read-only' ? 'read-only' : 'workspace-write',
      '--permission-mode',
      'default',
      'agent',
      '--no-leader',
      'stdio',
    ])
    return {
      home,
      ...launch,
      env: {
        ...systemEnvironment(),
        GROK_HOME: home,
        [GROK_API_KEY_REF]: route.apiKey,
        GROK_DEFAULT_SELECTED_PERMISSION: 'allow_once',
      },
    }
  })
}

async function setup() {
  useNodeAcpFixtureAgent()
  const root = await mkdtemp(join(tmpdir(), 'opl-acp-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const options = {
    home: join(root, 'state'),
    command: process.execPath,
    prefix: [resolve('tests/fixtures/acp-agent.mjs')],
    resolveKey: async () => 'test-grok-key',
  }
  const ctx = { get: () => undefined, agents: { get: () => undefined } } as unknown as Context
  const service = new HarnessService(ctx, options)
  cleanups.push(() => service.dispose())
  return { root, options, ctx, service }
}
const start = (s: HarnessService, cwd: string, taskId = 'task') =>
  s.start({
    combination: GROK_COMBINATION,
    cwd,
    taskId,
    origin: { kind: 'codex', sessionId: 'parent' },
  })
const wait = (s: HarnessService, id: string) => s.wait({ sessionId: id }, AbortSignal.timeout(8000))
async function nativeSetup(
  models = [
    { id: 'codex::test-model', name: 'Test Model' },
    { id: 'deepseek-flash', name: 'DeepSeek' },
  ],
  providers = [{ id: 'opl-gateway', name: 'OPL Gateway' }],
) {
  const { root, options, service: initial } = await setup()
  await initial.executionCatalog()
  await initial.dispose()
  let current = { provider: 'opl-gateway', model: 'codex::test-model' }
  const session = {
    id: 'native-session',
    header: { cwd: root },
    append: vi.fn(),
    snapshotEvents: () => [],
  }
  const ctx = {
    get: () => undefined,
    agents: { get: () => undefined },
    sessions: { get: () => session },
    llm: {
      listProviders: () => providers,
      listConfigurableProviders: () => [],
      listModels: async () => models,
    },
    sessionProjections: { snapshot: () => ({ values: { modelSelection: { next: current } } }) },
    typertGateway: {
      invoke: async ({ method, args }: any) => {
        if (method === 'modelCatalog') return { default: current, groups: [] }
        if (method === 'selectModel') {
          const { provider, model } = args.request
          current = { provider, model }
        }
      },
    },
  } as unknown as Context
  const service = new HarnessService(ctx, options)
  cleanups.push(() => service.dispose())
  return {
    root,
    options,
    ctx,
    service,
    session,
    changeModel: () => {
      current = { provider: 'opl-gateway', model: 'deepseek-flash' }
    },
  }
}
describe('native conversation combinations', () => {
  it.each(['aws', 'kiro'])(
    'routes the first ordinary %s request through Claude without a picker binding',
    async (channel) => {
      const ref = { provider: 'opl-gateway', model: channel + '::claude-opus-5-5' }
      const { service, ctx, root, session } = await nativeSetup([{ id: ref.model, name: 'Claude' }])
      const settings = {
        describe: () => [{ ns: 'opl-suite', value: { gatewayGroups: { kiro: true } } }],
      }
      Object.assign(ctx, {
        settings,
        get: (name: string) => (name === 'settings' ? settings : undefined),
      })
      const adapter = adapterFor('claude', ref)!
      vi.spyOn(adapter, 'prepare').mockImplementation(async () => ({
        home: root,
        command: process.execPath,
        args: [resolve('tests/fixtures/acp-agent.mjs')],
        env: { ...systemEnvironment(), OPL_FIXTURE_MODEL: 'claude-opus-5-5' },
      }))
      const next = vi.fn(async function* () {
        throw Error('unexpected direct Gateway request')
      })
      const options = {
        ...ref,
        sessionId: session.id,
        messages: [
          createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'first-' + channel }],
          }),
        ],
      } as GenerateOptions
      const chunks = await Array.fromAsync(service.conversationStream(options, next))
      expect(next).not.toHaveBeenCalled()
      expect(await readFile(join(root, 'calls.txt'), 'utf8')).toContain('first-' + channel)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      const record = (await service.list()).sessions.find(
        (item) => item.origin.kind === 'dsh' && item.origin.sessionId === session.id,
      )!
      expect(record).toMatchObject({ harnessRef: 'claude', modelRef: ref })
    },
  )

  it('routes a default external model on first send without selecting its combination', async () => {
    const { service, root, session } = await nativeSetup([{ id: 'grok::grok-4.7', name: 'Grok' }])
    const next = vi.fn(async function* () {
      throw Error('direct provider must not receive this model')
    })
    const options = {
      sessionId: session.id,
      provider: 'opl-gateway',
      model: 'grok::grok-4.7',
      messages: [
        createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'first-send' }],
        }),
      ],
    } as GenerateOptions
    const chunks = await Array.fromAsync(service.conversationStream(options, next))
    expect(next).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toContain('first-send')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('hands off tool history through the official conversation stream and sends only new input on continuation', async () => {
    const { service, root, session } = await nativeSetup([{ id: 'grok::grok-4.7', name: 'Grok' }])
    await service.selectCombination({ sessionId: session.id, combination: GROK_COMBINATION })
    const callId = 'read-1' as ToolCallId
    const messages = [
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'read README' }],
      }),
      createAssistantMessage({
        source: { provider: 'opl-gateway', model: 'deepseek-flash' },
        content: [
          { type: 'reasoning', text: 'private-reasoning' },
          { type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"README.md"}' },
        ],
      }),
      createToolResultMessage({
        callId,
        isError: false,
        content: [{ type: 'text', text: 'cedar-271' }],
      }),
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'continue-here' }],
      }),
    ]
    const options = {
      sessionId: session.id,
      provider: 'opl-gateway',
      model: 'grok::grok-4.7',
      messages,
    } as GenerateOptions
    const next = vi.fn(async function* () {})
    const chunks = await Array.fromAsync(service.conversationStream(options, next))
    const prompt = await readFile(join(root, 'calls.txt'), 'utf8')
    expect(next).not.toHaveBeenCalled()
    expect(prompt).toContain('历史工具调用 read (read-1): {"path":"README.md"}')
    expect(prompt).toContain('tool (read-1): cedar-271')
    expect(prompt).toContain('不要重新执行历史任务或工具调用')
    expect(prompt).toContain('当前用户请求：\nuser: continue-here')
    expect(prompt).not.toContain('private-reasoning')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const followup = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'next-turn' }],
    })
    await Array.fromAsync(
      service.conversationStream({ ...options, messages: [...messages, followup] }, next),
    )
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe(prompt + 'user: next-turn\n')
  })
  it('rejects real attachments without dispatching a prompt', async () => {
    const { service, root, session } = await nativeSetup([{ id: 'grok::grok-4.7', name: 'Grok' }])
    await service.selectCombination({ sessionId: session.id, combination: GROK_COMBINATION })
    const messages = [
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: {} as never }],
      }),
    ]
    await expect(
      Array.fromAsync(
        service.conversationStream(
          {
            sessionId: session.id,
            provider: 'opl-gateway',
            model: 'grok::grok-4.7',
            messages,
          } as GenerateOptions,
          async function* () {},
        ),
      ),
    ).rejects.toMatchObject({ code: 'HARNESS_INPUT' })
    await expect(access(join(root, 'calls.txt'))).rejects.toThrow()
  })
  it('defaults Claude delegation to Kiro while preserving an explicit AWS combination', async () => {
    const { service, root } = await nativeSetup([
      { id: 'aws::claude-opus-5-5', name: 'Claude' },
      { id: 'kiro::claude-opus-5-5', name: 'Claude' },
    ])
    const catalog = await service.executionCatalog()
    const kiro = catalog.combinations.find(
      (item) => item.modelRef.model === 'kiro::claude-opus-5-5',
    )!
    const aws = catalog.combinations.find((item) => item.modelRef.model === 'aws::claude-opus-5-5')!
    const statuses = vi
      .spyOn(service, 'combinations')
      .mockResolvedValue([{ id: kiro.id, available: true }] as never)
    const start = vi.spyOn(service, 'start').mockRejectedValue(Error('selected'))
    const input = {
      model: 'claude-opus-5-5',
      cwd: root,
      task: 'test',
      taskId: 'test',
      operationId: 'initial',
    }
    const origin = { kind: 'codex', sessionId: 'parent' } as const
    try {
      await expect(service.delegateFrom(origin, input)).rejects.toThrow('selected')
      expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ combination: kiro.id }))
      await expect(service.delegateFrom(origin, { ...input, combination: aws.id })).rejects.toThrow(
        'selected',
      )
      expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ combination: aws.id }))
    } finally {
      statuses.mockRestore()
      start.mockRestore()
    }
  })
  it('inherits DSH permissions for generated combinations without elevating other origins', async () => {
    const { service, root } = await nativeSetup()
    const automatic = (await service.executionCatalog()).combinations.find(
      (item) => item.generated && item.modelRef.model === 'codex::test-model',
    )!
    const dsh = await service.start(
      {
        combination: automatic.id,
        cwd: root,
        taskId: 'dsh-workspace',
        origin: { kind: 'dsh', sessionId: 'native-session' },
        sandbox: 'workspace',
      },
      true,
    )
    expect(dsh.sandbox).toBe('workspace')
    const codex = await service.start(
      {
        combination: automatic.id,
        cwd: root,
        taskId: 'codex-workspace',
        origin: { kind: 'codex', sessionId: 'parent' },
        sandbox: 'workspace',
      },
      true,
    )
    expect(codex.sandbox).toBe('read-only')
  })
  it('retries a failed final session write on graceful shutdown', async () => {
    const { service, root, options } = await setup()
    const session = await start(service, root)
    const original = HarnessSessionStore.prototype.saveChanged
    let failed = false
    const spy = vi
      .spyOn(HarnessSessionStore.prototype, 'saveChanged')
      .mockImplementation(function (records) {
        const values = [...records]
        if (!failed && values.some((record) => record.turns.at(-1)?.state === 'completed')) {
          failed = true
          return Promise.reject(Error('temporary disk failure'))
        }
        return original.call(this, values)
      })
    try {
      await service.prompt({ sessionId: session.id, text: 'persist', operationId: 'one' })
      await vi.waitFor(async () => {
        expect((await service.snapshot({ sessionId: session.id })).turns.at(-1)?.error).toContain(
          '结果未能持久保存',
        )
      })
      await service.dispose()
      const records = await new HarnessSessionStore(options.home).load()
      expect(records.find((record) => record.id === session.id)?.turns.at(-1)).toMatchObject({
        state: 'failed',
        error: '结果未能持久保存，请检查磁盘后重试读取',
      })
    } finally {
      spy.mockRestore()
    }
  })
  it('filters retired provider models and combinations from the live catalog', async () => {
    const { service } = await nativeSetup([
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'codex::gpt-5', name: 'GPT-5' },
      { id: 'codex::gpt-5-mini', name: 'GPT-5 Mini' },
      { id: 'deepseek-flash', name: 'DeepSeek' },
    ])
    const catalog = await service.executionCatalog()
    expect(catalog.models.map((item) => item.ref.model)).not.toEqual(
      expect.arrayContaining(['deepseek-v4-pro', 'codex::gpt-5', 'codex::gpt-5-mini']),
    )
    expect(catalog.combinations.map((item) => item.modelRef.model)).not.toEqual(
      expect.arrayContaining(['deepseek-v4-pro', 'codex::gpt-5', 'codex::gpt-5-mini']),
    )
  })
  it('does not expose the built-in DeepSeek catalog without its own credential', async () => {
    const { service } = await nativeSetup(
      [
        { id: 'deepseek-flash', name: 'DeepSeek' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
      [{ id: 'deepseek-official', name: 'DeepSeek 官方' }],
    )
    const catalog = await service.executionCatalog()
    expect(
      catalog.models.filter((item) => item.ref.provider === 'deepseek-official'),
    ).toMatchObject([{ available: false, reason: '凭据未配置' }])
    expect(
      catalog.combinations.filter((item) => item.modelRef.provider === 'deepseek-official'),
    ).toEqual([])
  })
  it('creates independently named combinations for explicit Gateway channels', async () => {
    // This assertion lists every available model, so the machine's own official CLIs
    // must not leak into it: an installed MiniMax Code would legitimately add its own
    // account models and make the expected list environment-dependent.
    vi.stubEnv('USERPROFILE', join(tmpdir(), 'opl-absent-cli'))
    vi.stubEnv('HOME', join(tmpdir(), 'opl-absent-cli'))
    vi.stubEnv('MINIMAX_DATA_DIR', join(tmpdir(), 'opl-absent-cli'))
    vi.stubEnv('PATH', '')
    const { service } = await nativeSetup([
      { id: 'deepseek-flash', name: 'DeepSeek' },
      { id: 'codex::deepseek-flash', name: 'DeepSeek' },
    ])
    const catalog = await service.executionCatalog()
    expect(
      catalog.combinations.filter(
        (item) => item.harnessRef === 'dsh' && item.modelRef.model.includes('deepseek-flash'),
      ),
    ).toHaveLength(2)
    expect(catalog.models.filter((item) => item.available).map((item) => item.source)).toEqual([
      'OPL Gateway',
      'OPL Gateway',
    ])
  })
  it('restores the chosen combination among bindings to the same model without elevating permissions', async () => {
    const { service, ctx, options, session, changeModel } = await nativeSetup()
    const catalog = await service.executionCatalog()
    const modelRef = { provider: 'opl-gateway', model: 'codex::test-model' }
    catalog.combinations.push(
      {
        id: 'review',
        name: 'Review',
        modelRef,
        harnessRef: 'dsh',
        permissionPolicy: 'read-only',
        isDefault: false,
        enabled: true,
      },
      {
        id: 'work',
        name: 'Work',
        modelRef,
        harnessRef: 'dsh',
        permissionPolicy: 'workspace',
        isDefault: false,
        enabled: true,
      },
    )
    await service.saveExecutionCatalog(catalog)
    await service.selectCombination({ sessionId: session.id, combination: 'review' })
    expect(session.append).toHaveBeenCalledExactlyOnceWith('sandbox/mode', { mode: 'read-only' })
    await service.selectCombination({ sessionId: session.id, combination: 'work' })
    expect(session.append).toHaveBeenCalledTimes(1)
    await service.dispose()
    const restored = new HarnessService(ctx, options)
    cleanups.push(() => restored.dispose())
    expect((await restored.modelSelection(session.id)).combination).toBe('work')
    changeModel()
    expect((await restored.modelSelection(session.id)).combination).toBeUndefined()
  })
  it('preserves a disabled automatic combination instead of generating a duplicate', async () => {
    const { service } = await nativeSetup(),
      catalog = await service.executionCatalog()
    const automatic = catalog.combinations.find(
      (item) => item.generated && item.modelRef.model === 'codex::test-model',
    )!
    automatic.generated = false
    automatic.enabled = false
    const saved = await service.saveExecutionCatalog(catalog)
    expect(saved.combinations.filter((item) => item.id === automatic.id)).toHaveLength(1)
    expect(saved.combinations.find((item) => item.id === automatic.id)?.enabled).toBe(false)
  })
  it('does not mark an external combination ready when its model is absent', async () => {
    const { service } = await nativeSetup()
    expect(
      (await service.list()).combinations.find((item) => item.id === GROK_COMBINATION),
    ).toMatchObject({ available: false, reason: '模型未配置或分组未授权' })
  })
})
describe('external Harness production transport', () => {
  it('parses ACP envelopes, deduplicates task/operation, preserves results and restores native sessions', async () => {
    const { root, service, ctx, options } = await setup()
    const [a, b] = await Promise.all([start(service, root), start(service, root)])
    expect(a.id).toBe(b.id)
    await service.prompt({ sessionId: a.id, text: 'remember-721', operationId: 'one' })
    const first = await wait(service, a.id)
    expect(first.turns[0]).toMatchObject({ state: 'completed', text: 'result:remember-721' })
    expect(first.turns[0]?.tools).toHaveLength(1)
    await service.prompt({ sessionId: a.id, text: 'remember-721', operationId: 'one' })
    await expect(
      service.prompt({ sessionId: a.id, text: 'changed', operationId: 'one' }),
    ).rejects.toThrow('operation')
    expect((await readFile(join(root, 'calls.txt'), 'utf8')).trim().split('\n')).toHaveLength(1)
    await service.dispose()
    const resumed = new HarnessService(ctx, options)
    cleanups.push(() => resumed.dispose())
    await resumed.start({ combination: GROK_COMBINATION, cwd: root, existingSessionId: a.id })
    await resumed.prompt({ sessionId: a.id, text: 'recall', operationId: 'two' })
    expect((await wait(resumed, a.id)).turns[1]?.text).toBe('remember-721')
    const launch = JSON.parse(await readFile(join(root, 'launch.json'), 'utf8'))
    expect(launch).toMatchObject({ envKey: true, hasCodex: false })
    expect(
      await readFile(join(options.home, 'harnesses/grok-build/config.toml'), 'utf8'),
    ).not.toContain('test-grok-key')
  })
  it('holds permission until explicit choice and denies without file writes', async () => {
    const { root, service } = await setup()
    const a = await start(service, root)
    await service.prompt({ sessionId: a.id, text: 'deny-write', operationId: 'deny' })
    const pending = await wait(service, a.id)
    expect(pending.state).toBe('waiting_approval')
    expect(
      await access(join(root, 'controlled.txt')).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    const ask = pending.approvals[0]!
    expect(ask.command).toBe('printf approved > controlled.txt')
    await expect(
      service.answer({ sessionId: a.id, approvalId: ask.id, optionId: 'invalid' }),
    ).rejects.toThrow()
    await service.answer({ sessionId: a.id, approvalId: ask.id, optionId: 'no' })
    expect((await wait(service, a.id)).turns[0]?.text).toBe('denied')
    expect(
      await access(join(root, 'controlled.txt')).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    await service.prompt({ sessionId: a.id, text: 'allow-write', operationId: 'allow' })
    const approval = (await wait(service, a.id)).approvals[0]!
    await service.answer({ sessionId: a.id, approvalId: approval.id, optionId: 'yes' })
    await wait(service, a.id)
    expect(await readFile(join(root, 'controlled.txt'), 'utf8')).toBe('approved')
  })
  it('cancels with a notification and rejects parallel prompts and mismatched resumes', async () => {
    const { root, service } = await setup()
    const a = await start(service, root)
    await service.prompt({ sessionId: a.id, text: 'wait', operationId: 'one' })
    await expect(
      service.prompt({ sessionId: a.id, text: 'again', operationId: 'two' }),
    ).rejects.toThrow('执行')
    expect((await service.cancel({ sessionId: a.id })).state).toBe('cancelled')
    await expect(service.start({ combination: 'fake', cwd: root })).rejects.toThrow()
    await expect(
      service.start({ combination: GROK_COMBINATION, cwd: root, existingSessionId: 'missing' }),
    ).rejects.toThrow('不存在')
    await expect(
      service.start({ combination: GROK_COMBINATION, cwd: tmpdir(), existingSessionId: a.id }),
    ).rejects.toThrow('不一致')
  })
  it('fails closed without a Grok key and never falls back to machine credentials', async () => {
    const { root, ctx, options } = await setup()
    const service = new HarnessService(ctx, { ...options, resolveKey: async () => undefined })
    cleanups.push(() => service.dispose())
    await expect(start(service, root)).rejects.toThrow('渠道凭据')
    expect(grokConfiguration()).toContain('env_key = "OPL_GATEWAY_GROK_API_KEY"')
  })
  it('shares one cold connection across concurrent retries after restart', async () => {
    const { root, service, ctx, options } = await setup()
    const a = await start(service, root)
    await service.dispose()
    const resumed = new HarnessService(ctx, options)
    cleanups.push(() => resumed.dispose())
    const request = { sessionId: a.id, text: 'wait', operationId: 'retry' }
    await Promise.all([resumed.prompt(request), resumed.prompt(request)])
    expect((await readFile(join(root, 'connections.txt'), 'utf8')).trim().split('\n')).toEqual([
      'session/new',
      'session/load',
    ])
    // prompt() resolves once the turn is admitted and the request has been written to the
    // child's stdin; the child appends to calls.txt only after it handles session/prompt.
    // Wait for that child-side evidence, never for admission alone, and give the wait a
    // real bound instead of a fixed sleep.
    await vi.waitFor(
      async () =>
        expect((await readFile(join(root, 'calls.txt'), 'utf8')).trim().split('\n')).toEqual([
          'wait',
        ]),
      { timeout: 5000 },
    )
    expect((await resumed.snapshot({ sessionId: a.id })).turns).toHaveLength(1)
    expect((await resumed.cancel({ sessionId: a.id })).state).toBe('cancelled')
  })
  it('inherits project permissions and cancels child work with its parent', async () => {
    const { root, service } = await setup()
    const a = await start(service, root)
    const narrow = await service.start({
      combination: GROK_COMBINATION,
      cwd: root,
      origin: { kind: 'harness', sessionId: a.id },
      sandbox: 'read-only',
    })
    expect(narrow.sandbox).toBe('read-only')
    await expect(
      service.start({
        combination: GROK_COMBINATION,
        cwd: root,
        origin: { kind: 'harness', sessionId: narrow.id },
        sandbox: 'workspace',
      }),
    ).rejects.toThrow('权限边界')
    const child = await service.start({
      combination: GROK_COMBINATION,
      cwd: root,
      origin: { kind: 'harness', sessionId: a.id },
    })
    await service.prompt({ sessionId: a.id, text: 'wait', operationId: 'parent' })
    await service.prompt({ sessionId: child.id, text: 'wait', operationId: 'child' })
    await service.cancel({ sessionId: a.id })
    expect((await service.snapshot({ sessionId: child.id })).state).toBe('cancelled')
  })
})

describe('shared collaboration owner', () => {
  it('separates delivery from acceptance, binds the parent and continues the same task', async () => {
    const { root, service } = await setup(),
      parent = await start(service, root, 'parent')
    const origin = { kind: 'harness' as const, sessionId: parent.id }
    const input = {
      combination: GROK_COMBINATION,
      task: 'deliver-one',
      taskId: 'child',
      operationId: 'one',
    }
    const first = await service.delegateFrom(origin, input)
    expect(first.turns[0]).toMatchObject({
      state: 'completed',
      review: { decision: 'pending' },
      delivery: { state: 'delivered' },
    })
    expect((await service.delegateFrom(origin, input)).id).toBe(first.id)
    expect(await service.tasksFor(origin)).toHaveLength(1)
    await expect(
      service.reviewTask(
        { kind: 'codex', sessionId: 'other' },
        { sessionId: first.id, operationId: 'one', decision: 'accepted', note: 'fake' },
      ),
    ).rejects.toThrow('当前对话')
    await service.reviewTask(origin, {
      sessionId: first.id,
      operationId: 'one',
      decision: 'changes_requested',
      note: '需要补充',
    })
    const second = await service.delegateFrom(origin, {
      ...input,
      sessionId: first.id,
      task: 'deliver-two',
      operationId: 'two',
    })
    expect(second.id).toBe(first.id)
    expect(second.assignment?.revisions).toBe(1)
    await expect(
      service.reviewTask(origin, {
        sessionId: first.id,
        operationId: 'one',
        decision: 'accepted',
        note: 'stale',
      }),
    ).rejects.toThrow('已变化')
    const accepted = await service.reviewTask(origin, {
      sessionId: first.id,
      operationId: 'two',
      decision: 'accepted',
      note: '已核对',
    })
    expect(accepted.turns.at(-1)?.review?.decision).toBe('accepted')
    expect(
      (
        await service.reviewTask(origin, {
          sessionId: first.id,
          operationId: 'two',
          decision: 'accepted',
          note: '已核对',
        })
      ).turns,
    ).toHaveLength(2)
  })
  it('queues writers and cancels queued descendants without executing them', async () => {
    const { root, service } = await setup(),
      parent = await start(service, root, 'parent')
    await service.prompt({ sessionId: parent.id, text: 'wait', operationId: 'hold' })
    const child = await service.delegateFrom(
      { kind: 'harness', sessionId: parent.id },
      {
        combination: GROK_COMBINATION,
        task: 'must-not-execute',
        taskId: 'child',
        operationId: 'one',
        wait: false,
      },
    )
    expect(child.state).toBe('queued')
    await service.cancel({ sessionId: parent.id })
    expect((await service.snapshot({ sessionId: child.id })).state).toBe('cancelled')
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).not.toContain('must-not-execute')
  })
  it('releases a waiting parent, reports approval and resumes without redispatch', async () => {
    const { root, service } = await setup(),
      parent = await start(service, root, 'parent'),
      origin = { kind: 'harness' as const, sessionId: parent.id }
    await service.prompt({ sessionId: parent.id, text: 'wait', operationId: 'hold' })
    const child = await service.delegateFrom(origin, {
      combination: GROK_COMBINATION,
      task: 'deny-write',
      taskId: 'permission',
      operationId: 'one',
    })
    expect(child.state).toBe('waiting_approval')
    const ask = child.approvals[0]!
    await service.answer({ sessionId: child.id, approvalId: ask.id, optionId: 'no' })
    const result = await service.resultFor(origin, { sessionId: child.id, wait: true })
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]?.text).toBe('denied')
    await service.cancel({ sessionId: parent.id })
  })
  it('freezes the model binding across configuration edits and restart', async () => {
    const { root, service, ctx, options } = await setup(),
      parent = await start(service, root, 'parent'),
      origin = { kind: 'harness' as const, sessionId: parent.id }
    const child = await service.delegateFrom(origin, {
      combination: GROK_COMBINATION,
      task: 'first',
      taskId: 'child',
      operationId: 'one',
    })
    const catalog = await service.executionCatalog()
    catalog.combinations = catalog.combinations.filter((c) => c.id !== GROK_COMBINATION)
    await service.saveExecutionCatalog(catalog)
    await service.dispose()
    const restored = new HarnessService(ctx, options)
    cleanups.push(() => restored.dispose())
    const continued = await restored.delegateFrom(origin, {
      sessionId: child.id,
      task: 'second',
      taskId: 'child',
      operationId: 'two',
    })
    expect(continued.modelRef).toEqual(child.modelRef)
    expect(continued.turns).toHaveLength(2)
  })
})

describe('durable collaboration delivery', () => {
  it('delivers an asynchronous result once and preserves the receipt after restart', async () => {
    const { root, service, ctx, options } = await setup(),
      parent = await start(service, root, 'parent'),
      origin = { kind: 'harness' as const, sessionId: parent.id }
    const child = await service.delegateFrom(origin, {
      combination: GROK_COMBINATION,
      task: 'async-result',
      taskId: 'async',
      operationId: 'one',
      wait: false,
    })
    await vi.waitFor(async () =>
      expect((await service.snapshot({ sessionId: parent.id })).turns).toHaveLength(1),
    )
    await wait(service, parent.id)
    expect((await service.snapshot({ sessionId: child.id })).turns[0]?.delivery?.state).toBe(
      'delivered',
    )
    await service.dispose()
    const restored = new HarnessService(ctx, options)
    cleanups.push(() => restored.dispose())
    expect((await restored.snapshot({ sessionId: parent.id })).turns).toHaveLength(1)
    expect((await restored.snapshot({ sessionId: child.id })).turns[0]?.delivery?.state).toBe(
      'delivered',
    )
  })
  it('does not serialize independent read-only work behind a writer', async () => {
    const { root, service } = await setup(),
      writer = await start(service, root, 'writer')
    await service.prompt({ sessionId: writer.id, text: 'wait', operationId: 'hold' })
    const reader = await service.start({
      combination: GROK_COMBINATION,
      cwd: root,
      taskId: 'reader',
      sandbox: 'read-only',
    })
    await service.prompt({ sessionId: reader.id, text: 'read-result', operationId: 'one' })
    expect((await wait(service, reader.id)).state).toBe('completed')
    await service.cancel({ sessionId: writer.id })
  })
  it('runs declared disjoint writers concurrently while overlapping and undeclared writers wait', async () => {
    const { root, service } = await setup()
    const a = await start(service, root, 'scoped-a'),
      b = await start(service, root, 'scoped-b')
    const overlap = await start(service, root, 'scoped-overlap'),
      legacy = await start(service, root, 'unscoped')
    const request = {
      sessionId: a.id,
      text: 'wait',
      operationId: 'hold',
      writeScope: ['src/client'],
    }
    await service.prompt(request)
    await service.prompt({
      sessionId: b.id,
      text: 'wait',
      operationId: 'hold',
      writeScope: ['src/host'],
    })
    await vi.waitFor(async () => {
      const lines = (await readFile(join(root, 'calls.txt'), 'utf8')).trim().split('\n')
      expect(lines).toEqual(['wait', 'wait'])
    })
    expect((await service.snapshot({ sessionId: a.id })).state).toBe('running')
    expect((await service.snapshot({ sessionId: b.id })).state).toBe('running')
    await service.prompt({
      sessionId: overlap.id,
      text: 'overlap',
      operationId: 'one',
      writeScope: ['src/client/a.ts'],
    })
    await service.prompt({ sessionId: legacy.id, text: 'legacy', operationId: 'one' })
    expect((await service.snapshot({ sessionId: overlap.id })).state).toBe('queued')
    expect((await service.snapshot({ sessionId: legacy.id })).state).toBe('queued')
    await service.prompt(request)
    await expect(service.prompt({ ...request, writeScope: ['src/different'] })).rejects.toThrow(
      'operation',
    )
    await service.cancel({ sessionId: a.id })
    expect((await wait(service, overlap.id)).state).toBe('completed')
    expect((await service.snapshot({ sessionId: legacy.id })).state).toBe('queued')
    await service.cancel({ sessionId: b.id })
    expect((await wait(service, legacy.id)).state).toBe('completed')
    const lines = (await readFile(join(root, 'calls.txt'), 'utf8')).trim().split('\n')
    expect(lines).toEqual(['wait', 'wait', 'overlap', 'legacy'])
  })
  it('persists operation ownership and restores cancellation without replay', async () => {
    const { root, service, ctx, options } = await setup()
    const a = await start(service, root, 'restored-scope')
    const request = {
      sessionId: a.id,
      text: 'wait',
      operationId: 'one',
      writeScope: ['src/file.ts'],
    }
    await service.prompt(request)
    await vi.waitFor(async () =>
      expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe('wait\n'),
    )
    await service.cancel({ sessionId: a.id })
    await service.dispose()
    const restored = new HarnessService(ctx, options)
    cleanups.push(() => restored.dispose())
    expect((await restored.snapshot({ sessionId: a.id })).turns[0]?.writeScope).toHaveLength(1)
    await restored.prompt(request)
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe('wait\n')
    await restored.prompt({ ...request, operationId: 'two', text: 'next' })
    expect((await wait(restored, a.id)).state).toBe('completed')
  })
  it('does not cancel or launch another scoped writer when a queued writer is cancelled', async () => {
    const { root, service } = await setup()
    const a = await start(service, root, 'lock-holder'),
      b = await start(service, root, 'cancel-pending')
    await service.prompt({ sessionId: a.id, text: 'wait', operationId: 'one', writeScope: ['src'] })
    await vi.waitFor(async () =>
      expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe('wait\n'),
    )
    await service.prompt({
      sessionId: b.id,
      text: 'never-executed',
      operationId: 'one',
      writeScope: ['src/a.ts'],
    })
    await service.cancel({ sessionId: b.id })
    expect((await service.snapshot({ sessionId: b.id })).state).toBe('cancelled')
    expect((await service.snapshot({ sessionId: a.id })).state).toBe('running')
    await service.cancel({ sessionId: a.id })
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe('wait\n')
  })
})

describe('restart and cancellation boundaries', () => {
  it('marks unfinished operations interrupted without issuing the task again', async () => {
    const { root, service, ctx, options } = await setup(),
      parent = await start(service, root, 'parent')
    await service.prompt({ sessionId: parent.id, text: 'wait', operationId: 'in-flight' })
    const filename = new HarnessSessionStore(options.home).filename(parent.id),
      before = await readFile(filename, 'utf8')
    await service.dispose()
    await writeFile(filename, before)
    const restored = new HarnessService(ctx, options)
    cleanups.push(() => restored.dispose())
    expect((await restored.snapshot({ sessionId: parent.id })).state).toBe('interrupted')
    expect((await readFile(join(root, 'calls.txt'), 'utf8')).trim().split('\n')).toEqual(['wait'])
  })
  it('does not automatically wake a parent after the user cancels it', async () => {
    const { root, service } = await setup(),
      parent = await start(service, root, 'parent')
    await service.prompt({ sessionId: parent.id, text: 'wait', operationId: 'hold' })
    const child = await service.delegateFrom(
      { kind: 'harness', sessionId: parent.id },
      {
        combination: GROK_COMBINATION,
        task: 'queued',
        taskId: 'child',
        operationId: 'one',
        wait: false,
      },
    )
    await service.cancel({ sessionId: parent.id })
    await vi.waitFor(async () =>
      expect((await service.snapshot({ sessionId: child.id })).turns[0]?.delivery?.state).toBe(
        'blocked',
      ),
    )
    expect((await service.snapshot({ sessionId: parent.id })).turns).toHaveLength(1)
  })
})
