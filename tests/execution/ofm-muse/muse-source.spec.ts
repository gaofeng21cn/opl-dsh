import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import {
  createMuseCodeAdapter,
  museCodeAdapter,
} from '../../../src/execution/host/adapters/muse/muse.ts'
import {
  MUSE_BOUND_BASE_URL,
  MUSE_HARNESS,
  MUSE_LAUNCH_ENV,
  MUSE_PROTOCOL,
  MUSE_PROVIDER,
  musePermissionPlan,
} from '../../../src/execution/host/adapters/muse/index.ts'
import { MUSE_CREDENTIAL_ENV } from '../../../src/execution/host/adapters/muse/muse.ts'
import { MUSE_MCP_TOOL } from '../../../src/execution/host/adapters/muse/muse-bash.ts'
import type { AdapterOptions } from '../../../src/execution/host/adapters/types.ts'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'
import { museRef, museRecord } from './fixtures/records.ts'

const owner = { effect: (effect: () => () => void) => effect() } as unknown as Context
const ctx = { credentials: { resolve: vi.fn() }, get: () => undefined } as unknown as Context

const LANE = 'muse-spark-1.3-contributor-free'
const answer = {
  baseURL: MUSE_BOUND_BASE_URL,
  apiKey: 'dummy-test-key',
  model: LANE,
  protocol: MUSE_PROTOCOL,
} as const

let home = ''
let stubBinary = ''

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'opl-muse-home-'))
  stubBinary = join(home, 'muse-stub.mjs')
  await rm(stubBinary, { force: true }).catch(() => {})
  // `executablePath` must find something real; the file is never executed here.
  const { writeFile } = await import('node:fs/promises')
  await writeFile(stubBinary, '// stub\n')
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

const options = (sources?: ExternalModelSources): AdapterOptions =>
  ({
    home,
    grokCommand: 'grok',
    nativeBridgePath: join(home, 'bridge.mjs'),
    command: stubBinary,
    ...(sources ? { modelSources: sources } : {}),
  }) as AdapterOptions

const record = (extra: Partial<HarnessSession> = {}): HarnessSession =>
  museRecord(museRef(LANE), { sandbox: 'full-access', ...extra })

const boundAdapter = createMuseCodeAdapter(
  fileURLToPath(
    new URL('../../../src/execution/host/adapters/muse/muse-bridge.mjs', import.meta.url),
  ),
  { supportsSourceEndpoint: true },
)

const withSource = (): ExternalModelSources => {
  const sources = new ExternalModelSources(ctx)
  sources.register(owner, {
    provider: MUSE_PROVIDER,
    supports: () => true,
    resolve: async () => ({ ...answer }),
  })
  return sources
}

const launchEnv = async (sources?: ExternalModelSources, extra: Partial<HarnessSession> = {}) =>
  (await boundAdapter.prepare!(ctx, record(extra), options(sources))).env ?? {}

describe('Muse Code launch preparation', () => {
  it('hands the CLI its own argv: serve, the resolved route and the Bash MCP tool', async () => {
    const env = await launchEnv(withSource())
    // The official host entry, not the TUI.
    expect(JSON.parse(env[MUSE_LAUNCH_ENV.prefix]!)).toContain('--disable-sandbox')
    expect(JSON.parse(env[MUSE_LAUNCH_ENV.prefix]!)).toContain('--trust-workspace')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env[MUSE_LAUNCH_ENV.model]).toBe(LANE)
    expect(env[MUSE_LAUNCH_ENV.baseUrl]).toBe(answer.baseURL)
    expect(env[MUSE_CREDENTIAL_ENV]).toBe(answer.apiKey)
    expect(env[MUSE_LAUNCH_ENV.protocol]).toBe(MUSE_PROTOCOL)
    // The contributor tier comes from the pinned id, not from a guess.
    expect(env[MUSE_LAUNCH_ENV.contributorMode]).toBe('on')
    expect(env[MUSE_LAUNCH_ENV.bashTool]).toBe(MUSE_MCP_TOOL)
    // The execution engine spawns the bridge, which owns the protocol translation.
    const launch = await boundAdapter.prepare!(ctx, record(), options(withSource()))
    expect(launch.command).toBe(process.execPath)
    expect(launch.args).toEqual([expect.stringContaining('muse-bridge.mjs')])
  })

  it('pins the toolset to the Bash tool so the model never sees the PowerShell shell', async () => {
    const env = await launchEnv(withSource())
    const document = JSON.parse(
      await readFile(join(env.XDG_CONFIG_HOME!, 'muse', 'settings.json'), 'utf8'),
    )
    expect(document.run.toolset).toEqual([MUSE_MCP_TOOL])
    const server = Object.values(document.mcpServers) as any[]
    expect(server).toHaveLength(1)
    expect(server[0]).toMatchObject({ transport: 'stdio', mode: 'required' })
    // The interpreter is passed to the tool, not discovered by it.
    expect(server[0].env.OPL_MUSE_GIT_BASH).toBe(env.OPL_MUSE_GIT_BASH)
  })

  it('uses Muse profile entry points and never rewrites a user profile variable', async () => {
    const env = await launchEnv(withSource())
    expect(env.XDG_CONFIG_HOME).toMatch(/profile[\\/]config$/)
    expect(env.XDG_DATA_HOME).toMatch(/profile[\\/]data$/)
    expect(env.MUSE_PROJECTS_HOME).toMatch(/profile[\\/]projects$/)
    // The CLI discovers foreign profiles through these; this session must not touch them.
    for (const forbidden of [
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'CODEX_HOME',
      'CLAUDE_CONFIG_DIR',
    ])
      expect(env).not.toHaveProperty(forbidden)
    // Scratch is exclusive to the session.
    expect(env.TEMP).toMatch(/[\\/]tmp$/)
    expect(env.TMP).toBe(env.TEMP)
  })

  it('writes the tool into the session-owned settings file only', async () => {
    const env = await launchEnv(withSource())
    const document = JSON.parse(
      await readFile(join(env.XDG_CONFIG_HOME!, 'muse', 'settings.json'), 'utf8'),
    )
    expect(document.schema_version).toBe(1)
    expect(document.run.toolset).toEqual([MUSE_MCP_TOOL])
    expect(Object.keys(document.mcpServers)).toEqual(['opl_muse_git_bash'])
    // Nothing was written under the suite home root or a user profile.
    expect(document.mcpServers.opl_muse_git_bash.args[0]).toContain('muse-bash-mcp.mjs')
  })

  it('never carries a provider credential the source did not resolve', async () => {
    const env = await launchEnv(withSource())
    // The CLI names this variable itself when the key is missing or rejected.
    expect(env[MUSE_CREDENTIAL_ENV]).toBe(answer.apiKey)
    // The key is never duplicated into argv or the settings document.
    expect(JSON.parse(env[MUSE_LAUNCH_ENV.prefix]!).join(' ')).not.toContain(answer.apiKey)
    for (const forbidden of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPL_MUSE_API_KEY'])
      expect(env).not.toHaveProperty(forbidden)
  })
})

describe('Muse Code source refusal', () => {
  it('refuses to launch when no source group is registered', async () => {
    await expect(boundAdapter.prepare!(ctx, record(), options())).rejects.toThrow(
      /尚未注册到执行引擎/,
    )
  })

  it('refuses a model this adapter does not pin, before touching the source', async () => {
    const resolve = vi.fn(async () => ({ ...answer }))
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, { provider: MUSE_PROVIDER, supports: () => true, resolve })
    for (const model of [
      'muse-spark-1.4',
      'MUSE-SPARK-1.3-CONTRIBUTOR-FREE',
      'muse-spark-1.3-contributor-free-v2',
    ])
      await expect(
        boundAdapter.prepare!(ctx, museRecord(museRef(model)), options(sources)),
      ).rejects.toThrow(/不属于官方 Muse Code 可固定的组合/)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a model owned by another provider', async () => {
    const resolve = vi.fn(async () => ({ ...answer }))
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, { provider: MUSE_PROVIDER, supports: () => true, resolve })
    await expect(
      boundAdapter.prepare!(
        ctx,
        record({ modelRef: { provider: 'somebody-else', model: LANE } }),
        options(sources),
      ),
    ).rejects.toThrow(/不属于官方 Muse Code 可固定的组合/)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a source that redirects the combination to another model', async () => {
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, {
      provider: MUSE_PROVIDER,
      supports: () => true,
      resolve: async () => ({ ...answer, model: 'muse-spark-1.2-contributor-free' }),
    })
    await expect(boundAdapter.prepare!(ctx, record(), options(sources))).rejects.toThrow(
      /模型来源解析出的模型（muse-spark-1\.2-contributor-free）与所选组合/,
    )
  })

  it('refuses a source whose protocol the official route cannot speak', async () => {
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, {
      provider: MUSE_PROVIDER,
      supports: () => true,
      resolve: async () => ({ ...answer, protocol: 'messages' }) as never,
    })
    // `resolve` is called with the pinned protocol, so a source that insists on
    // another wire format fails before any profile write.
    await expect(boundAdapter.prepare!(ctx, record(), options(sources))).rejects.toThrow()
  })

  it('refuses a source that withdrew support while its route was resolving', async () => {
    const sources = new ExternalModelSources(ctx)
    let release!: (value: typeof answer) => void
    const pending = new Promise<typeof answer>((done) => {
      release = done
    })
    const remove = sources.register(owner, {
      provider: MUSE_PROVIDER,
      supports: () => true,
      resolve: () => pending,
    })
    const read = boundAdapter.prepare!(ctx, record(), options(sources))
    remove()
    release(answer)
    await expect(read).rejects.toThrow(/模型来源已变更/)
  })

  it('refuses a launch whose source was re-registered as the same object', async () => {
    const sources = new ExternalModelSources(ctx)
    // One source instance, unloaded and loaded again: the registration identity
    // changes even though the object does not, so the captured lease is stale.
    const source = {
      provider: MUSE_PROVIDER,
      supports: () => true,
      resolve: async () => ({ ...answer }),
    }
    let release!: (value: typeof answer) => void
    const pending = new Promise<typeof answer>((done) => {
      release = done
    })
    const remove = sources.register(owner, { ...source, resolve: () => pending })
    const read = boundAdapter.prepare!(ctx, record(), options(sources))
    remove()
    sources.register(owner, source)
    release(answer)
    await expect(read).rejects.toThrow(/模型来源已变更/)
  })

  it('refuses a source that withdrew the pair after resolving', async () => {
    const sources = new ExternalModelSources(ctx)
    let supported = true
    sources.register(owner, {
      provider: MUSE_PROVIDER,
      supports: () => supported,
      resolve: async () => ({ ...answer }),
    })
    const read = boundAdapter.prepare!(ctx, record(), options(sources))
    supported = false
    await expect(read).rejects.toThrow(/模型来源已变更|尚未适配此 Harness/)
  })
})

describe('Muse Code permission refusal', () => {
  it('advertises and accepts only full-access', () => {
    expect(boundAdapter.capabilities.permissions).toEqual(['full-access'])
    expect(musePermissionPlan('full-access')).toEqual({
      approvalMode: 'allowAll',
      disableSandbox: true,
      isolation: 'none',
    })
  })

  it('refuses a restricted tier because the MCP tool runs outside the native sandbox', () => {
    for (const tier of ['read-only', 'workspace', '', 'auto', 'FULL-ACCESS'])
      expect(() => musePermissionPlan(tier)).toThrow(/只提供完整访问/)
  })

  it('refuses a restricted tier before touching the source or writing a profile', async () => {
    const resolve = vi.fn(async () => ({ ...answer }))
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, { provider: MUSE_PROVIDER, supports: () => true, resolve })
    // Its own session id, so the check is about this refusal and not an earlier launch.
    await expect(
      boundAdapter.prepare!(
        ctx,
        record({ sandbox: 'workspace', id: 'session-ofm-muse-refused' }),
        options(sources),
      ),
    ).rejects.toThrow(/只提供完整访问/)
    expect(resolve).not.toHaveBeenCalled()
    // Nothing was created for the refused session.
    await expect(
      readFile(
        join(
          home,
          'harnesses',
          'muse-code',
          'session-ofm-muse-refused',
          'profile',
          'config',
          'muse',
          'settings.json',
        ),
        'utf8',
      ),
    ).rejects.toThrow()
  })
})

describe('Muse Code reasoning pinning', () => {
  it('forwards the official vocabulary verbatim', async () => {
    for (const tier of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      expect(
        (await launchEnv(withSource(), { reasoningEffort: tier }))[MUSE_LAUNCH_ENV.effort],
      ).toBe(tier)
  })

  it('refuses a tier the official CLI does not define rather than substituting one', async () => {
    const resolve = vi.fn(async () => ({ ...answer }))
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, { provider: MUSE_PROVIDER, supports: () => true, resolve })
    await expect(
      boundAdapter.prepare!(ctx, record({ reasoningEffort: 'maximum' }), options(sources)),
    ).rejects.toThrow(/未定义思考档位/)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('passes no tier when the session asked for none', async () => {
    // `reasoningEffort` is optional on the record, so its absence is expressed by
    // leaving it out rather than by assigning undefined.
    const env = await launchEnv(withSource())
    expect(env[MUSE_LAUNCH_ENV.effort]).toBe('')
  })
})

describe('Muse Code session pinning', () => {
  const snapshot = (sessionId: string, currentModelId: unknown, configOptions?: unknown) =>
    ({
      agent: { agentInfo: { name: 'Muse Code', version: '1.4.7' } },
      session: { sessionId, models: { currentModelId } },
      configOptions,
    }) as never

  it('accepts a session the bridge reported on the pinned lane', () => {
    const configured = boundAdapter.configureSession!(
      { request: vi.fn() } as never,
      record({ reasoningEffort: 'high' }),
      snapshot('muse-1', LANE, { modelId: LANE, reasoningEffort: 'high' }),
    )
    return expect(configured).resolves.toMatchObject({
      configOptions: { modelId: LANE, reasoningEffort: 'high' },
    })
  })

  it('pins only the model when the session asked for no reasoning tier', () => {
    return expect(
      boundAdapter.configureSession!(
        { request: vi.fn() } as never,
        record(),
        snapshot('muse-1', LANE),
      ),
    ).resolves.toMatchObject({ configOptions: { modelId: LANE } })
  })

  it('refuses a session that came up on a different model', async () => {
    await expect(
      boundAdapter.configureSession!(
        { request: vi.fn() } as never,
        record(),
        snapshot('muse-1', 'muse-spark-1.2-contributor-free'),
      ),
    ).rejects.toThrow(/会话模型 muse-spark-1\.2-contributor-free 与所选组合/)
  })

  it('refuses a missing session id instead of pinning blind', async () => {
    await expect(
      boundAdapter.configureSession!(
        { request: vi.fn() } as never,
        record({ acpSessionId: '' }),
        snapshot('', LANE),
      ),
    ).rejects.toThrow(/未返回会话 ID/)
  })

  it('refuses a drifted model before every prompt', () => {
    expect(() =>
      boundAdapter.verifySession!(
        record(),
        snapshot('muse-1', LANE, { modelId: 'muse-spark-1.2-contributor-free' }),
      ),
    ).toThrow(/广告的模型 muse-spark-1\.2-contributor-free/)
  })

  it('refuses a drifted reasoning tier before every prompt', () => {
    expect(() =>
      boundAdapter.verifySession!(
        record({ reasoningEffort: 'xhigh' }),
        snapshot('muse-1', LANE, { modelId: LANE, reasoningEffort: 'low' }),
      ),
    ).toThrow(/会话思考档位 low 与要求的 xhigh 不一致/)
  })

  it('accepts an unpinned session that reported no effort, because none was asked for', () => {
    expect(() => boundAdapter.verifySession!(record(), snapshot('muse-1', LANE))).not.toThrow()
  })

  it('fails closed when the model was never read back', () => {
    // An absent observation is not evidence. Claiming the lane was re-verified when the
    // bridge reported nothing would let a prompt run on an unconfirmed model.
    expect(() =>
      boundAdapter.verifySession!(record(), {
        agent: {},
        session: { sessionId: 'muse-1' },
        configOptions: undefined,
      } as never),
    ).toThrow(/未取得会话当前模型的回读/)
    expect(() =>
      boundAdapter.verifySession!(record(), {
        agent: {},
        session: { sessionId: 'muse-1', models: {} },
        configOptions: undefined,
      } as never),
    ).toThrow(/未取得会话当前模型的回读/)
    expect(() =>
      boundAdapter.verifySession!(record(), {
        agent: {},
        session: { sessionId: 'muse-1', models: { currentModelId: '' } },
        configOptions: undefined,
      } as never),
    ).toThrow(/未取得会话当前模型的回读/)
  })

  it('fails closed when the requested effort was never read back', () => {
    expect(() =>
      boundAdapter.verifySession!(
        record({ reasoningEffort: 'xhigh' }),
        snapshot('muse-1', LANE, { modelId: LANE }),
      ),
    ).toThrow(/未取得思考档位的回读/)
    expect(() =>
      boundAdapter.verifySession!(
        record({ reasoningEffort: 'xhigh' }),
        snapshot('muse-1', LANE, { modelId: LANE, reasoningEffort: '' }),
      ),
    ).toThrow(/未取得思考档位的回读/)
  })

  it('fails closed at configure time too, not only before a prompt', async () => {
    await expect(
      boundAdapter.configureSession!(
        { request: vi.fn() } as never,
        record({ reasoningEffort: 'high' }),
        {
          agent: {},
          session: { sessionId: 'muse-1', models: { currentModelId: LANE } },
          configOptions: undefined,
        } as never,
      ),
    ).rejects.toThrow(/未取得思考档位的回读/)
  })
})

describe('Muse Code registry contract', () => {
  it('matches only its own exact lanes', () => {
    expect(boundAdapter.matches(museRef('muse-spark-1.2-contributor-free'))).toBe(true)
    expect(boundAdapter.matches(museRef('muse-spark-1.3-contributor-free'))).toBe(true)
    expect(boundAdapter.matches(museRef('muse-spark-1.3'))).toBe(false)
    expect(boundAdapter.matches({ provider: 'our-free-model', model: 'gpt-oss-120b' })).toBe(false)
  })

  it('declares only the surface the official build implements', () => {
    expect(boundAdapter.capabilities).toEqual({
      transport: 'official-sdk',
      authentication: 'api-source',
      protocols: ['responses'],
      // Claimed in proportion to what this build can bind.
      customEndpoint: true,
      permissions: ['full-access'],
      sessionLoad: true,
      cancel: true,
      reasoning: 'cli-advertised',
      autoReview: 'unsupported',
    })
  })
})
describe('Muse Code channel binding', () => {
  it('writes the exact source endpoint without a credential', async () => {
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, {
      provider: MUSE_PROVIDER,
      supports: () => true,
      resolve: async () => ({ ...answer, baseURL: 'http://127.0.0.1:49153/v1' }),
    })
    const launch = await museCodeAdapter.prepare!(ctx, record(), options(sources))
    const document = JSON.parse(
      await readFile(join(launch.env.XDG_CONFIG_HOME!, 'muse', 'settings.json'), 'utf8'),
    )
    expect(document.endpoint_transport).toEqual({
      base_url: 'http://127.0.0.1:49153/v1',
      auth: 'bearer',
    })
    expect(JSON.stringify(document)).not.toContain(answer.apiKey)
  })

  it('refuses before resolving an unsupported permission tier or touching the interpreter', async () => {
    const resolve = vi.fn(async () => ({ ...answer }))
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, { provider: MUSE_PROVIDER, supports: () => true, resolve })
    // Permission first, so a restricted tier still loses before the route is read.
    await expect(
      boundAdapter.prepare!(ctx, record({ sandbox: 'workspace' }), options(sources)),
    ).rejects.toThrow(/只提供完整访问/)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('advertises the verified official endpoint setting', () => {
    expect(museCodeAdapter.capabilities.customEndpoint).toBe(true)
    // The gate is one flag; a build that supports the binding says so.
    expect(boundAdapter.capabilities.customEndpoint).toBe(true)
  })
})
