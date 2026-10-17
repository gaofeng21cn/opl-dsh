/**
 * Session-level behavior evidence for the official Kilo adaptation.
 *
 * These tests drive the adapter's real launch vector against an executable ACP fixture over
 * a live stdio transport. The fixture derives its model advertisement from the
 * `KILO_CONFIG_CONTENT` the adapter actually produced, so a pinning assertion cannot pass by
 * matching the adapter's own constants.
 *
 * The fixture also reproduces three behaviors measured on the pinned `@kilocode/cli@7.8.8`
 * binary, so the adapter is tested against the interface it will really meet:
 *   - `session/load` comes back on the CLI's own default model, not the pinned one.
 *   - `session/cancel` answers `-32601 "Method not found"`.
 *   - the advertised `effort` option offers no values for a route model and refuses writes.
 *
 * Every wait is condition-driven: a journal entry, an ACP notification, or a request reply.
 * No test sleeps for a fixed duration and then assumes an event happened.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpProcess } from '../../../src/execution/host/acp.ts'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import type { ExternalModelRoute } from '../../../src/execution/host/model-sources.ts'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'
import type { AdapterOptions } from '../../../src/execution/host/adapters/types.ts'
import {
  kiloAdapter,
  kiloLaunch,
  kiloModelValue,
  KILO_HARNESS,
  KILO_OFM_MODELS,
  KILO_OFM_PROVIDER,
} from '../../../src/execution/host/adapters/kilo/index.ts'

const exec = promisify(execFile)
const FIXTURE = resolve('tests/execution/ofm-kilo/fixtures/kilo-acp-agent.mjs')
/** A slash-and-colon bearing id, matching what the pinned binary really accepted. */
const MODEL = 'dots-studio/dots-3-note-preview:free'
const MODEL_VALUE = kiloModelValue(MODEL)
const FAKE_KEY = 'opl-test-key-do-not-use'
const ROUTE: ExternalModelRoute = {
  baseURL: 'https://ofm.example.test/v1',
  model: MODEL,
  apiKey: FAKE_KEY,
  protocol: 'chat',
}

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function workspace(prefix: string, name = '中文 项目 dir'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  return dir
}

/** The exact environment the adapter really produced, wired to the fixture. */
async function preparedEnv(dir: string, overrides: Partial<HarnessSession> = {}) {
  const sources = new ExternalModelSources({} as never, () => {})
  const release = sources.register({ effect: (fn: () => unknown) => fn() } as never, {
    provider: KILO_OFM_PROVIDER,
    supports: () => true,
    resolve: async () => ROUTE,
  })
  const options: AdapterOptions = {
    home: join(dir, 'opl-home'),
    command: process.execPath,
    modelSources: sources,
    grokCommand: 'grok',
    nativeBridgePath: 'bridge.js',
  }
  const launch = await kiloAdapter.prepare!(
    {} as never,
    {
      id: 's1',
      combination: `${KILO_HARNESS}/${MODEL}`,
      harnessRef: KILO_HARNESS,
      modelRef: { provider: KILO_OFM_PROVIDER, model: MODEL },
      cwd: dir,
      acpSessionId: '',
      origin: { kind: 'harness', sessionId: 's1' },
      title: 't',
      sandbox: 'full-access',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      turns: [],
      ...overrides,
    },
    options,
  )
  return { launch, release, options }
}

interface Entry {
  method?: string
  event?: string
  params?: Record<string, any>
  result?: Record<string, any>
}

/** Wait for a journal entry matching `match`, polling on a deadline rather than sleeping. */
async function until(journal: string, match: (entry: Entry) => boolean): Promise<Entry> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const text = await readFile(journal, 'utf8').catch(() => '')
    const entry = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Entry)
      .find(match)
    if (entry) return entry
    if (Date.now() > deadline) throw Error(`等待事件超时：${match.toString()}`)
    await new Promise((done) => setTimeout(done, 10))
  }
}

const entries = async (journal: string): Promise<Entry[]> =>
  (await readFile(journal, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entry)

/** Boot the fixture with the adapter's real launch environment. */
async function agent(
  dir: string,
  extra: Record<string, string> = {},
  answerPermission?: (id: string | number, acp: AcpProcess) => void,
) {
  const { launch } = await preparedEnv(dir)
  const journal = join(dir, 'journal.jsonl')
  const updates: unknown[] = []
  const waiters: ((value: any) => void)[] = []
  // The executable is Node and the fixture stands in for the official CLI, so the adapter's
  // own argument vector is reused verbatim with the fixture inserted as prefix.
  const started = kiloLaunch(launch.command, dir, [FIXTURE])
  const acp = new AcpProcess(
    started.command,
    started.args,
    dir,
    { ...(launch.env as Record<string, string>), KILO_JOURNAL: journal, ...extra },
    (value) => {
      updates.push(value)
      for (const done of waiters.splice(0)) done(value)
    },
    (id) => answerPermission?.(id, acp),
    () => {},
  )
  cleanups.push(() => acp.dispose())
  return {
    acp,
    journal,
    updates,
    waitUpdate: (match: (value: any) => boolean) =>
      new Promise((done) => {
        const existing = updates.find(match)
        if (existing) return done(existing)
        waiters.push((value) => {
          if (match(value)) done(value)
        })
      }),
  }
}

const sessionRecord = (sessionId = ''): HarnessSession => ({
  id: 's1',
  combination: `${KILO_HARNESS}/${MODEL}`,
  harnessRef: KILO_HARNESS,
  modelRef: { provider: KILO_OFM_PROVIDER, model: MODEL },
  cwd: 'C:/work',
  acpSessionId: sessionId,
  origin: { kind: 'harness', sessionId: 's1' },
  title: 't',
  sandbox: 'full-access',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  turns: [],
})

/**
 * The request surface the transport hands to `configureSession`.
 *
 * It forwards to the *live* ACP process, so the adapter's own request crosses a real stdio
 * transport and lands in the fixture's journal. A test therefore covers the wire method name
 * and parameters, not an in-process stand-in.
 */
const surface = (acp: AcpProcess, log: string[]) => ({
  request: (method: string, params: object) => {
    log.push(method)
    return acp.request(method, params)
  },
})

const agentSnapshot = { agentInfo: { name: 'Kilo', version: '7.8.8' } }
const openSession = async (acp: AcpProcess, cwd: string) =>
  (await acp.request('session/new', { cwd, mcpServers: [] })) as Record<string, any>

describe('Kilo 会话固定模型', () => {
  it('新建会话后用官方配置接口固定模型并回读一致', async () => {
    const dir = await workspace('opl-kilo-pin-')
    const { acp, journal } = await agent(dir)
    await acp.request('initialize', { protocolVersion: 1 })
    const created = await openSession(acp, dir)
    // The fixture advertises from the launch config, so the pinned value must be the one
    // the adapter constructed from the owner's route.
    const advertised = (created.configOptions as any[]).find((o) => o.id === 'model')
    expect(advertised.options.map((o: any) => o.value)).toContain(MODEL_VALUE)

    const log: string[] = []
    const configured = await kiloAdapter.configureSession!(
      surface(acp, log),
      sessionRecord(created.sessionId),
      { agent: agentSnapshot, session: created, configOptions: created.configOptions },
    )
    // The read-back advertisement is the agent's own, and it reports the pinned value.
    const readBack = (configured as any).configOptions.find((o: any) => o.id === 'model')
    expect(readBack.currentValue).toBe(MODEL_VALUE)
    expect(readBack.options.map((o: any) => o.value)).toContain(MODEL_VALUE)
    expect(log).toEqual(['session/set_config_option'])

    const write = await until(journal, (entry) => entry.method === 'session/set_config_option')
    expect(write.params!.configId).toBe('model')
    expect(write.params!.value).toBe(MODEL_VALUE)
    expect(write.params!.sessionId).toBe(created.sessionId)
    // 适配器不写 effort：官方对该组合的模型没有可用档位，写了也会被拒。
    expect((await entries(journal)).filter((e) => e.params?.configId === 'effort')).toHaveLength(0)
  })

  it('每个声明模型都能逐字固定并回读，free/auto 路由不被替换', async () => {
    const dir = await workspace('opl-kilo-each-')
    for (const model of KILO_OFM_MODELS) {
      const sources = new ExternalModelSources({} as never, () => {})
      sources.register({ effect: (fn: () => unknown) => fn() } as never, {
        provider: KILO_OFM_PROVIDER,
        supports: () => true,
        resolve: async () => ({ ...ROUTE, model }),
      })
      const home = join(dir, 'opl-home')
      const launch = await kiloAdapter.prepare!(
        {} as never,
        { ...sessionRecord(), modelRef: { provider: KILO_OFM_PROVIDER, model } },
        {
          home,
          command: process.execPath,
          modelSources: sources,
          grokCommand: 'grok',
          nativeBridgePath: 'bridge.js',
        },
      )
      const journal = join(dir, `journal-${model.replace(/[^a-z0-9]/gi, '_')}.jsonl`)
      const started = kiloLaunch(launch.command, dir, [FIXTURE])
      const acp = new AcpProcess(
        started.command,
        started.args,
        dir,
        { ...(launch.env as Record<string, string>), KILO_JOURNAL: journal },
        () => {},
        () => {},
        () => {},
      )
      cleanups.push(() => acp.dispose())
      await acp.request('initialize', { protocolVersion: 1 })
      const created = await openSession(acp, dir)
      const value = kiloModelValue(model)
      const configured = await kiloAdapter.configureSession!(
        surface(acp, []),
        { ...sessionRecord(created.sessionId), modelRef: { provider: KILO_OFM_PROVIDER, model } },
        { agent: agentSnapshot, session: created, configOptions: created.configOptions },
      )
      const readBack = (configured as any).configOptions.find((o: any) => o.id === 'model')
      expect(readBack.currentValue).toBe(value)
    }
  })

  it('恢复会话后模型回到官方默认值，适配器必须重新固定而不是沿用', async () => {
    const dir = await workspace('opl-kilo-load-')
    const { acp } = await agent(dir, { KILO_LOAD_RESETS_MODEL: '1' })
    await acp.request('initialize', { protocolVersion: 1 })
    const created = await openSession(acp, dir)
    const restored = (await acp.request('session/load', {
      sessionId: created.sessionId,
      cwd: dir,
      mcpServers: [],
    })) as Record<string, any>
    const drifted = (restored.configOptions as any[]).find((o) => o.id === 'model')
    // 实测：load 之后广告的是 CLI 自带默认模型，不是固定值。
    expect(drifted.currentValue).toBe('kilo/google/gemini-3-pro-image')

    const log: string[] = []
    await kiloAdapter.configureSession!(surface(acp, log), sessionRecord(created.sessionId), {
      agent: agentSnapshot,
      session: restored,
      configOptions: restored.configOptions,
    })
    // The pin happens after load, rather than trusting the previous value.
    expect(log).toEqual(['session/set_config_option'])
  })

  it('写入后回读漂移时明确失败，不会带着别的模型继续', async () => {
    const dir = await workspace('opl-kilo-drift-')
    const { acp } = await agent(dir, { KILO_DRIFT_AFTER_SET: '1' })
    await acp.request('initialize', { protocolVersion: 1 })
    const created = await openSession(acp, dir)
    await expect(
      kiloAdapter.configureSession!(surface(acp, []), sessionRecord(created.sessionId), {
        agent: agentSnapshot,
        session: created,
        configOptions: created.configOptions,
      }),
    ).rejects.toThrow(/会话当前模型与要求的 .* 不一致/)
  })

  it('官方拒绝写入时明确失败，且不发送任何任务', async () => {
    const dir = await workspace('opl-kilo-reject-')
    const { acp, journal } = await agent(dir, { KILO_REJECT_SET: '1' })
    await acp.request('initialize', { protocolVersion: 1 })
    const created = await openSession(acp, dir)
    await expect(
      kiloAdapter.configureSession!(surface(acp, []), sessionRecord(created.sessionId), {
        agent: agentSnapshot,
        session: created,
        configOptions: created.configOptions,
      }),
    ).rejects.toThrow(/未接受该配置/)
    // No prompt was sent.
    expect((await entries(journal)).filter((e) => e.method === 'session/prompt')).toHaveLength(0)
  })

  it('发送前复核广告，模型不一致即失败关闭', async () => {
    const dir = await workspace('opl-kilo-verify-')
    const { acp } = await agent(dir)
    await acp.request('initialize', { protocolVersion: 1 })
    const created = await openSession(acp, dir)
    const optionsOf = (value: string) => [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: value,
        options: [{ value: MODEL_VALUE, name: MODEL_VALUE }],
      },
    ]
    // The session was switched to another model: re-check must refuse.
    expect(() =>
      kiloAdapter.verifySession!(sessionRecord(created.sessionId), {
        agent: agentSnapshot,
        session: created,
        configOptions: optionsOf('kilo/stealth/glyph-cluster'),
      }),
    ).toThrow(/会话当前模型与要求的/)
    expect(() =>
      kiloAdapter.verifySession!(sessionRecord(created.sessionId), {
        agent: agentSnapshot,
        session: created,
        configOptions: optionsOf(MODEL_VALUE),
      }),
    ).not.toThrow()
  })

  it('本组合之外的模型在固定阶段就被拒绝', async () => {
    const dir = await workspace('opl-kilo-other-')
    const { acp } = await agent(dir)
    await acp.request('initialize', { protocolVersion: 1 })
    const created = await openSession(acp, dir)
    await expect(
      kiloAdapter.configureSession!(
        surface(acp, []),
        {
          ...sessionRecord(created.sessionId),
          modelRef: { provider: KILO_OFM_PROVIDER, model: 'not-declared-here' },
        },
        { agent: agentSnapshot, session: created, configOptions: created.configOptions },
      ),
    ).rejects.toThrow(/不属于本适配声明的 Kilo 组合/)
  })
})

describe('Kilo 取消与清理', () => {
  it('适配器不声明官方未实现的取消', () => {
    // Measured on the pinned release: -32601; therefore neither advertised nor pretended.
    expect(kiloAdapter.capabilities.cancel).toBe(false)
  })

  it('官方会话确实回答 Method not found，测试与真实行为一致', async () => {
    const dir = await workspace('opl-kilo-cancel-')
    const { acp, journal } = await agent(dir, { KILO_CANCEL_UNSUPPORTED: '1' })
    await acp.request('initialize', { protocolVersion: 1 })
    const created = await openSession(acp, dir)
    await expect(acp.request('session/cancel', { sessionId: created.sessionId })).rejects.toThrow(
      /不支持本次请求的协议方法/,
    )
    // The cancel request really went out; it was not swallowed on the client side.
    await until(journal, (entry) => entry.method === 'session/cancel')
  })

  it('进程可重复清理且不留未决请求', async () => {
    const dir = await workspace('opl-kilo-clean-')
    const { acp } = await agent(dir)
    await acp.request('initialize', { protocolVersion: 1 })
    await openSession(acp, dir)
    await acp.dispose()
    await acp.dispose()
    expect(acp.closed).toBe(true)
  })
})

describe('Kilo 人工审批', () => {
  it('真实审批请求转发到客户端，拒绝后不重试也不回退', async () => {
    const dir = await workspace('opl-kilo-approve-')
    const asked: unknown[] = []
    const { acp, journal } = await agent(dir, { KILO_ASK_PERMISSION: '1' }, (id, process) => {
      // A real refusal decision, not a test double that skips approval.
      asked.push(id)
      process.answer(id, 'reject')
    })
    await acp.request('initialize', { protocolVersion: 1 })
    const created = await openSession(acp, dir)
    const result = (await acp.request('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    })) as Record<string, any>
    expect(result.stopReason).toBe('refusal')
    expect(asked).toHaveLength(1)
    await until(journal, (entry) => entry.event === 'permission.settled')
    const text = await readFile(journal, 'utf8')
    // One approval, one prompt: after the refusal there is no retry or alternative path.
    expect(text.match(/session\/prompt/g)).toHaveLength(1)
    expect(text.match(/"event":"permission.settled"/g)).toHaveLength(1)
  })

  it('允许一次后轮次正常结束，仍不扩大到整会话', async () => {
    const dir = await workspace('opl-kilo-allow-')
    const { acp } = await agent(dir, { KILO_ASK_PERMISSION: '1' }, (id, process) => {
      process.answer(id, 'once')
    })
    await acp.request('initialize', { protocolVersion: 1 })
    const created = await openSession(acp, dir)
    const result = (await acp.request('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    })) as Record<string, any>
    expect(result.stopReason).toBe('end_turn')
  })
})

describe('Kilo 工作目录', () => {
  it('中文加空格目录下的真实文件往返', async () => {
    const dir = await workspace('opl-kilo-file-')
    const file = join(dir, '说明 文件.txt')
    await writeFile(file, '你好，Kilo\n', 'utf8')
    expect(await readFile(file, 'utf8')).toBe('你好，Kilo\n')
    const started = kiloLaunch(process.execPath, dir)
    expect(started.args[started.args.length - 1]).toBe(dir)
  })

  it('真实 Git 外部命令在该目录可运行', async () => {
    const dir = await workspace('opl-kilo-git-')
    const result = await exec('git', ['--version'], { cwd: dir })
    expect(result.stdout.trim()).toMatch(/^git version \d+\./)
  })
})
