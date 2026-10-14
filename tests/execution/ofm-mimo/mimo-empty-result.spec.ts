/**
 * Completion adjudication for the official MiMo Code (`mimo`) adaptation.
 *
 * MiMo Code 0.1.15 builds its `session/prompt` result from the SDK reply without
 * inspecting the assistant message's error, so a controlled HTTP 400 and a
 * controlled HTTP 429 both come back as `end_turn` with zero usage, no body and
 * no tool. Publishing that as a completed turn is the defect these cases pin
 * down: a completion is what the queue, the notification and the user all read
 * as real finished work.
 *
 * Every case drives the real `HarnessService` through its own `prompt`/`wait`
 * entry, over a live stdio ACP transport, against an executable fixture whose
 * model advertisement is derived from the configuration the adapter really
 * produced. Identity, model pinning, the ACP round trip, turn persistence and the
 * adjudication itself all stay real; only the MiMo launcher is replaced, and the
 * replacement still builds the launch through the adapter's own production
 * helper.
 *
 * The last case is the negative control: the same empty-`end_turn` wire shape
 * through a harness that declares no completion rule must still be reported as
 * completed, because this refusal belongs to MiMo alone.
 *
 * Every wait is condition-driven. No case sleeps for a fixed duration and then
 * assumes an event happened.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessService, GROK_COMBINATION } from '../../../src/execution/host/harness.ts'
import { adapterFor } from '../../../src/execution/host/adapters/index.ts'
import { systemEnvironment } from '../../../src/execution/host/adapters/environment.ts'
import { grokConfiguration } from '../../../src/execution/host/adapters/grok.ts'
import { GROK_API_KEY_REF } from '../../../src/gateway/host/config.ts'
import { resolveGatewayExecution } from '../../../src/gateway/host/execution-access.ts'
import type { HarnessTurn } from '../../../src/execution/contracts/sessions.ts'
import {
  acceptMimoTurnResult,
  buildMimoRouteConfig,
  mimoCodeLaunch,
  mimoCodeModels,
  mimoProfileHome,
  MIMO_CODE_HARNESS,
  MIMO_OFM_MODEL,
  MIMO_OFM_PROVIDER,
} from '../../../src/execution/host/adapters/mimo/index.ts'
import { mimoCodeAdapter } from '../../../src/execution/host/adapters/mimo/mimo.ts'
import type {
  ExternalModelRoute,
  ExternalModelSource,
} from '../../../src/execution/host/model-sources.ts'

const MIMO_FIXTURE = resolve('tests/execution/ofm-mimo/mimo-empty-agent.mjs')
const GROK_FIXTURE = resolve('tests/fixtures/acp-agent.mjs')
const MIMO_COMBINATION = `${MIMO_CODE_HARNESS}/${MIMO_OFM_MODEL}`
/** Never a real secret; these cases only prove where a credential can and cannot appear. */
const FAKE_KEY = 'opl-test-key-do-not-use'
const ROUTE: ExternalModelRoute = {
  baseURL: 'https://ofm.example.test/v1',
  model: MIMO_OFM_MODEL,
  apiKey: FAKE_KEY,
  protocol: 'chat',
}

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})

const harnessContext = () =>
  ({
    get: () => undefined,
    agents: { get: () => undefined, list: () => [] },
    sessions: { list: () => [] },
    waterfall: async (_event: unknown, _request: unknown, next: () => unknown) => next(),
  }) as unknown as Context

const waitFor = (service: HarnessService, id: string) =>
  service.wait({ sessionId: id }, AbortSignal.timeout(15_000))

/** Run one prompt through the real service and return the settled turn. */
async function turn(
  service: HarnessService,
  sessionId: string,
  text: string,
): Promise<HarnessTurn> {
  await service.prompt({ sessionId, text, operationId: `op-${text}` })
  const snapshot = await waitFor(service, sessionId)
  const settled = snapshot.turns.at(-1)!
  expect(settled.state).not.toBe('running')
  expect(settled.state).not.toBe('queued')
  return settled
}

/**
 * Boot the real harness service on a real MiMo combination.
 *
 * The credential lives with the model source, exactly as in production: it is
 * registered through the real registry and reaches the adapter only as a resolved
 * route, never as a harness-level key.
 */
async function mimoSetup() {
  const root = await mkdtemp(join(tmpdir(), 'opl-mimo-empty-'))
  const home = join(root, 'state')
  const journal = join(root, 'journal.jsonl')
  // A path with both Chinese characters and a space, so the launch vector is
  // exercised rather than assumed.
  const cwd = join(root, '中文 项目 dir')
  await mkdir(cwd, { recursive: true })
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

  // Only the launcher is replaced. Everything the cases actually assert on —
  // the adapter identity, the ACP session pinning and the completion rule — is
  // production code, and the launch itself still goes through the adapter's own
  // `launch` helper.
  vi.spyOn(mimoCodeAdapter, 'prepare').mockImplementation(async (_ctx, record, options) => {
    const started = mimoCodeLaunch(process.execPath, record.cwd, [MIMO_FIXTURE])
    return {
      home: options.home,
      command: started.command,
      args: started.args,
      env: {
        ...systemEnvironment(),
        MIMO_JOURNAL: journal,
        // The real route configuration: a wrong provider id or model id here would
        // change the fixture's advertisement and fail the pinning check.
        MIMOCODE_CONFIG_CONTENT: buildMimoRouteConfig(ROUTE, record.modelRef.model).content,
        MIMOCODE_HOME: mimoProfileHome(options.home),
      },
      ...(started.verbatim ? { windowsVerbatimArguments: true } : {}),
    }
  })

  const service = new HarnessService(harnessContext(), { home, command: process.execPath })
  cleanups.push(() => service.dispose())
  const source: ExternalModelSource = {
    provider: MIMO_OFM_PROVIDER,
    supports: () => true,
    resolve: async () => ROUTE,
  }
  service.modelSources.register({ effect: (fn: () => unknown) => fn() } as never, source)

  const catalog = await service.executionCatalog()
  await service.saveExecutionCatalog({
    ...catalog,
    combinations: [
      ...catalog.combinations.filter((item) => item.id !== MIMO_COMBINATION),
      {
        id: MIMO_COMBINATION,
        name: 'MiMo Code + Our Free Model',
        modelRef: mimoCodeModels()[0]!,
        harnessRef: MIMO_CODE_HARNESS,
        permissionPolicy: 'full-access',
        isDefault: false,
        enabled: true,
      },
    ],
  })
  const session = await service.start({
    combination: MIMO_COMBINATION,
    cwd,
    sandbox: 'full-access',
    taskId: 'empty',
    origin: { kind: 'codex', sessionId: 'parent' },
  })
  return { service, session, journal }
}

/**
 * The negative control's setup: a harness that declares no completion rule,
 * launched against the shared ACP fixture in the identical empty-`end_turn`
 * shape that MiMo produces.
 */
async function grokSetup() {
  const root = await mkdtemp(join(tmpdir(), 'opl-grok-empty-'))
  const home = join(root, 'state')
  const cwd = join(root, '中文 项目 dir')
  await mkdir(cwd, { recursive: true })
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

  const adapter = adapterFor('grok-build', {
    provider: 'opl-gateway',
    model: 'grok::grok-4.7',
  })!
  vi.spyOn(adapter, 'prepare').mockImplementation(async (ctx, record, options) => {
    const route = await resolveGatewayExecution(ctx, record.modelRef, options.resolveKey)
    const profile = join(options.home, 'harnesses', 'grok-build')
    await mkdir(profile, { recursive: true, mode: 0o700 })
    const launch = mimoCodeLaunch(process.execPath, record.cwd, [GROK_FIXTURE])
    return {
      home: profile,
      command: launch.command,
      args: launch.args,
      env: {
        ...systemEnvironment(),
        GROK_HOME: profile,
        OPL_GATEWAY_GROK_API_KEY: route.apiKey,
        GROK_DEFAULT_SELECTED_PERMISSION: 'allow_once',
      },
    }
  })

  const service = new HarnessService(harnessContext(), {
    home,
    command: process.execPath,
    resolveKey: async () => FAKE_KEY,
  })
  cleanups.push(() => service.dispose())
  const session = await service.start({
    combination: GROK_COMBINATION,
    cwd,
    taskId: 'empty',
    origin: { kind: 'codex', sessionId: 'parent' },
  })
  return { service, session }
}

// These cases include CLI discovery and subprocess startup on mounted filesystems.
describe('MiMo Code 空成功拒绝', () => {
  it('拒绝无正文也无工具结果的 end_turn，不把它当作已完成', async () => {
    const { service, session } = await mimoSetup()

    const settled = await turn(service, session.id, 'empty-turn')

    // The transport really did report success — this is not a rediscovery of the
    // failure, it is a refusal of that report.
    expect(settled.stopReason).toBe('end_turn')
    expect(settled.text).toBe('')
    expect(settled.tools).toEqual([])
    expect(settled.state).toBe('failed')
    // The refusal states what this suite observed. It never claims an upstream HTTP
    // status the transport did not report, and never claims a resend that did not
    // happen.
    expect(settled.error).toContain('没有正文')
    expect(settled.error).toContain('未自动重发')
    expect(settled.error).not.toMatch(/4\d\d|429|400|限流|quota/i)
  }, 30_000)

  it('仅思考不算正文：只有推理片段的 end_turn 同样不算完成', async () => {
    const { service, session } = await mimoSetup()

    const settled = await turn(service, session.id, 'think-only')

    expect(settled.stopReason).toBe('end_turn')
    expect(settled.text).toBe('')
    // The reasoning is retained for the transcript, it just is not an answer.
    expect(settled.content?.some((item) => item.type === 'reasoning')).toBe(true)
    expect(settled.state).toBe('failed')
  }, 30_000)

  it('真实完成的工具即使没有正文也能完成', async () => {
    const { service, session } = await mimoSetup()

    const settled = await turn(service, session.id, 'tool-completed')

    expect(settled.state).toBe('completed')
    expect(settled.stopReason).toBe('end_turn')
    expect(settled.text).toBe('')
    expect(settled.tools.map((tool) => tool.status)).toEqual(['completed'])
    expect(settled.error).toBeUndefined()
  }, 30_000)

  it('纯正文可以完成', async () => {
    const { service, session } = await mimoSetup()

    const settled = await turn(service, session.id, 'body-only')

    expect(settled.state).toBe('completed')
    expect(settled.text).toBe('这是正文。')
    expect(settled.tools).toEqual([])
    expect(settled.error).toBeUndefined()
  }, 30_000)

  it('失败的工具不能伪装成成功', async () => {
    const { service, session } = await mimoSetup()

    const settled = await turn(service, session.id, 'tool-failed')

    expect(settled.stopReason).toBe('end_turn')
    expect(settled.text).toBe('')
    expect(settled.tools.map((tool) => tool.status)).toEqual(['failed'])
    expect(settled.state).toBe('failed')
  }, 30_000)

  it('取消仍然是取消，不被完成判定改成失败', async () => {
    const { service, session } = await mimoSetup()

    await service.prompt({ sessionId: session.id, text: 'hold', operationId: 'op-hold' })
    // Cancel only after the turn is genuinely in flight, so the receipt is the
    // agent's own answer rather than a race against admission.
    await vi.waitFor(async () =>
      expect((await service.snapshot({ sessionId: session.id })).turns.at(-1)!.state).toBe(
        'running',
      ),
    )
    await service.cancel({ sessionId: session.id })
    const settled = (await waitFor(service, session.id)).turns.at(-1)!

    expect(settled.state).toBe('cancelled')
    expect(settled.stopReason).toBe('cancelled')
    expect(settled.error).toBeUndefined()
  }, 30_000)
})

describe('其他 Harness 的空回复语义不变', () => {
  it('同一份空 end_turn 线形，在没有声明完成判定的 Harness 上仍然算完成', async () => {
    const { service, session } = await grokSetup()

    const settled = await turn(service, session.id, 'empty-turn')

    expect(settled.stopReason).toBe('end_turn')
    expect(settled.text).toBe('')
    // No completion rule is declared for this harness, so the transport's own
    // reading stands exactly as before this change.
    expect(settled.state).toBe('completed')
    expect(settled.error).toBeUndefined()
  })
})

describe('MiMo 完成判定规则本身', () => {
  it.each([
    ['正文', { text: '答复', tools: [] }, true],
    ['只有空白正文', { text: '  \n ', tools: [] }, false],
    ['完成的工具', { text: '', tools: [{ status: 'completed' }] }, true],
    ['失败的工具', { text: '', tools: [{ status: 'failed' }] }, false],
    ['进行中的工具', { text: '', tools: [{ status: 'in_progress' }] }, false],
    ['空回复', { text: '', tools: [] }, false],
    ['正文加失败的工具', { text: '写文件失败了', tools: [{ status: 'failed' }] }, true],
  ])('%s', (_name, outcome, accepted) => {
    expect(acceptMimoTurnResult({ stopReason: 'end_turn', ...outcome }).accepted).toBe(accepted)
  })
})
