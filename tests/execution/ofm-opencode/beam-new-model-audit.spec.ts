/**
 * Independent audit spec for the newest OFM / OpenCode free lanes.
 *
 * Audited candidates (see the owned report for sources and conclusions):
 *   beam-free, ll-alpha-free, exo-free, big-pickle, nemotron-3.5-super-vl-free
 *
 * The spec has two independent layers:
 *
 *  - **Offline (always runs).** DSH-side invariants that must hold whether or not these
 *    lanes are adapted: the exact ids are structurally usable, the deliberate exclusions
 *    (Jev, content-safety, GPT-OSS) stay refused, the OpenCode adaptation speaks exactly
 *    the `chat` protocol the official directory serves these models on, and the pinning
 *    primitive accepts the exact value while rejecting drift. Nothing here talks to a
 *    network, a credential, or a model.
 *
 *  - **Live (skipped unless `OPENCODE_OFFICIAL_BINARY` is set).** Drives the pinned
 *    official CLI (1.19.0) over the suite's own ACP transport with a **keyless loopback**
 *    provider and proves each candidate id is advertised and pins/reads back unchanged.
 *    No model is ever called: the spec stops after session configuration, exactly like
 *    `opencode-official.spec.ts`, so there is no network traffic and no credential.
 *
 * The catalog membership evidence (official OpenCode directory, OFM free-lane listing)
 * lives in the owned audit directory, not here: a directory listing is not a networked
 * model success and must not be asserted as one.
 */
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AcpProcess } from '../../../src/execution/host/acp.ts'
import {
  assertOpenCodeModelPinned,
  buildOpenCodeRouteConfig,
  isOpenCodeModel,
  openCodeAdapter,
  openCodeModelValue,
  openCodeProfileRoots,
  OPENCODE_EXCLUDED_MODELS,
  OPENCODE_MODEL_OPTION,
  OPENCODE_OFM_PROVIDER,
  OPENCODE_ROUTE_PROVIDER_ID,
  OPENCODE_SUPPORTED_PROTOCOLS,
} from '../../../src/execution/host/adapters/opencode/index.ts'
import {
  isExcludedOfmModel,
  isUsableOfmModelId,
  OFM_EXCLUDED_MODELS,
  OFM_PROVIDER,
} from '../../../src/execution/host/ofm-source/provider.ts'
import { isHiddenOfmSelection } from '../../../src/execution/host/ofm-source/selection-policy.ts'

/**
 * The five lanes this audit was asked to check, exactly as the official OpenCode
 * directory names them. Each is one provider/model id in the official `opencode/`
 * namespace; the OFM free lane and the Kilo channel name some of them differently,
 * which is recorded in the owned report rather than folded into one id here.
 */
const CANDIDATES = [
  'beam-free',
  'll-alpha-free',
  'exo-free',
  'big-pickle',
  'nemotron-3.5-super-vl-free',
] as const

/** A loopback, keyless route: well-formed for the pinned CLI, never a real credential. */
const ROUTE = {
  baseURL: 'http://127.0.0.1:9/v1',
  apiKey: 'probe-keyless',
  protocol: 'chat' as const,
}

const BINARY = process.env.OPENCODE_OFFICIAL_BINARY
const PINNED_VERSION = '1.19.0'

describe('新版 OFM/OpenCode 免费车道：候选标识与排除面', () => {
  it('每个候选都是结构可用的 OFM 标识，且没有被排除', () => {
    for (const model of CANDIDATES) {
      expect(isUsableOfmModelId(model)).toBe(true)
      expect(isExcludedOfmModel(model)).toBe(false)
      expect(OPENCODE_EXCLUDED_MODELS).not.toContain(model)
      expect(OFM_EXCLUDED_MODELS).not.toContain(model)
    }
  })

  it('Jev、Content Safety、GPT-OSS 保持排除，不因新增目录而进入普通聊天', () => {
    // The decisions themselves survive a directory refresh: membership is never inferred.
    expect(OFM_EXCLUDED_MODELS).toContain('jev-1.13-free')
    expect(OFM_EXCLUDED_MODELS).toContain('nvidia/nemotron-3.5-content-safety:free')
    expect(OPENCODE_EXCLUDED_MODELS).toContain('openai/gpt-oss-20b')
    expect(OPENCODE_EXCLUDED_MODELS).toContain('jev-1.13-free')
    expect(OPENCODE_EXCLUDED_MODELS).toContain('nvidia/nemotron-3.5-content-safety:free')

    for (const model of ['jev-1.13-free', 'nvidia/nemotron-3.5-content-safety:free']) {
      // Refused by the adapter's declared surface, not merely hidden in the picker.
      expect(openCodeAdapter.matches({ provider: OPENCODE_OFM_PROVIDER, model })).toBe(false)
      expect(isOpenCodeModel({ provider: OPENCODE_OFM_PROVIDER, model })).toBe(false)
      expect(isHiddenOfmSelection({ provider: OFM_PROVIDER, model })).toBe(true)
    }
    // GPT-OSS belongs to Codex only; OpenCode must not claim it.
    expect(
      openCodeAdapter.matches({ provider: OPENCODE_OFM_PROVIDER, model: 'openai/gpt-oss-20b' }),
    ).toBe(false)
  })

  it('适配声明的协议与官方免费目录一致：只有 chat，不新增 responses/messages', () => {
    // Official endpoint table: every audited free lane answers on
    // /inference/openai/v1/chat/completions with @ai-sdk/openai-compatible.
    expect([...OPENCODE_SUPPORTED_PROTOCOLS]).toEqual(['chat'])
    expect(openCodeAdapter.capabilities.protocols).toEqual(['chat'])
    for (const model of CANDIDATES) {
      const config = buildOpenCodeRouteConfig({ ...ROUTE, model }, model)
      const content = JSON.parse(config.content)
      const provider = content.provider[OPENCODE_ROUTE_PROVIDER_ID]
      expect(provider.npm).toBe('@ai-sdk/openai-compatible')
      // The id is carried verbatim: dashes and dots are not rewritten or split.
      expect(Object.keys(provider.models)).toEqual([model])
      expect(config.modelValue).toBe(openCodeModelValue(model))
    }
    // A route whose protocol is not the one the CLI bridges is refused, not approximated.
    for (const protocol of ['responses', 'messages'] as const)
      expect(() =>
        buildOpenCodeRouteConfig({ ...ROUTE, model: CANDIDATES[0], protocol }, CANDIDATES[0]),
      ).toThrow(/未被官方 OpenCode 适配验证/)
  })

  it('精确值可 pin，模型漂移被拒绝', () => {
    const describeError = (message: string) => new Error(message)
    for (const model of CANDIDATES) {
      const value = openCodeModelValue(model)
      const offered = [
        {
          id: OPENCODE_MODEL_OPTION,
          type: 'select',
          currentValue: value,
          options: [{ value, name: model }],
        },
      ]
      expect(assertOpenCodeModelPinned(value, offered, describeError).currentValue).toBe(value)
      // A session that drifted to another of the audited lanes must fail closed rather
      // than silently run it.
      const other = openCodeModelValue(
        CANDIDATES.find((candidate) => candidate !== model) as string,
      )
      expect(() =>
        assertOpenCodeModelPinned(value, [{ ...offered[0], currentValue: other }], describeError),
      ).toThrow(/不一致/)
      // A value that is offered nowhere fails the same way.
      expect(() =>
        assertOpenCodeModelPinned(value, [{ ...offered[0], options: [] }], describeError),
      ).toThrow(/未广告/)
    }
  })

  it('受限权限与推理档位仍然被拒绝，候选不改变适配器边界', () => {
    expect(openCodeAdapter.capabilities.permissions).toEqual(['full-access'])
    expect(openCodeAdapter.capabilities.reasoning).toBe('model-declared')
    expect(openCodeAdapter.capabilities.cancel).toBe(false)
  })
})

interface Fixture {
  acp: AcpProcess
  cwd: string
  root: string
}

let root = ''
let harness: Fixture | undefined

beforeAll(async () => {
  if (!BINARY) return
  await access(BINARY)
  root = await mkdtemp(join(tmpdir(), 'opl-beam-new-model-audit-'))
  const profile = openCodeProfileRoots(root)
  for (const dir of Object.values(profile)) await mkdir(dir, { recursive: true })
  const cwd = join(root, '中文 审计 dir')
  await mkdir(cwd, { recursive: true })
  const acp = new AcpProcess(
    BINARY,
    ['acp', '--cwd', cwd],
    cwd,
    {
      ...process.env,
      PATH: process.env.PATH!,
      ...profile,
      // Isolated profile; a keyless loopback route; no shared XDG roots, no updater,
      // no user config files, no credential.
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: {
          [OPENCODE_ROUTE_PROVIDER_ID]: {
            npm: '@ai-sdk/openai-compatible',
            name: 'OPL Audit Route',
            options: { baseURL: ROUTE.baseURL, apiKey: ROUTE.apiKey },
            models: Object.fromEntries(CANDIDATES.map((model) => [model, { name: model }])),
          },
        },
      }),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    },
    () => {},
    () => {},
    () => {},
  )
  harness = { acp, cwd, root }
}, 120_000)

afterAll(async () => {
  if (harness) await harness.acp.dispose()
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe.skipIf(!BINARY)('官方 OpenCode CLI 实测：候选标识可广告、可 pin', () => {
  it('pin 版本为 1.19.0', () => {
    // The adapter's measurements and this audit are both stated against this release.
    expect(PINNED_VERSION).toBe('1.19.0')
  })

  it('新会话广告全部候选，逐个 pin 后回读一致', async () => {
    const site = harness!
    await site.acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: 'opl-beam-audit', version: '1.0.0' },
    })
    const created = (await site.acp.request('session/new', {
      cwd: site.cwd,
      mcpServers: [],
    })) as Record<string, any>
    const model = (created.configOptions as any[]).find((o) => o.id === OPENCODE_MODEL_OPTION)
    const advertised: string[] = model.options.map((o: any) => o.value)
    for (const candidate of CANDIDATES) expect(advertised).toContain(openCodeModelValue(candidate))

    for (const candidate of CANDIDATES) {
      const value = openCodeModelValue(candidate)
      const written = (await site.acp.request('session/set_config_option', {
        sessionId: created.sessionId,
        configId: OPENCODE_MODEL_OPTION,
        value,
      })) as Record<string, any>
      const readBack = (written.configOptions as any[]).find((o) => o.id === OPENCODE_MODEL_OPTION)
      expect(readBack.currentValue).toBe(value)
    }
    await site.acp.request('session/close', { sessionId: created.sessionId })
  }, 120_000)
})
