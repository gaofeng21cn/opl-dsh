import { harnessAdapters } from '../../src/execution/host/adapters/index.ts'
import * as harnessRegistry from '../../src/execution/host/harness-registry.ts'
import { beforeEach } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  HarnessService,
  GROK_COMBINATION,
  grokConfiguration,
} from '../../src/execution/host/harness.ts'
import { ExecutionCatalogStore } from '../../src/execution/host/catalog.ts'
import { adapterFor } from '../../src/execution/host/adapters/index.ts'
import { commandLaunch } from '../../src/execution/host/harness-registry.ts'
import { systemEnvironment } from '../../src/execution/host/adapters/environment.ts'
import { resolveGatewayExecution } from '../../src/gateway/host/execution-access.ts'
import { GROK_API_KEY_REF } from '../../src/gateway/host/config.ts'
import type { HarnessProxy } from '../../src/execution/contracts/catalog.ts'
import type { HarnessSnapshot, HarnessTurn } from '../../src/execution/contracts/sessions.ts'

const FIXTURE = resolve('tests/fixtures/proxy-acp-agent.mjs')
const GROK_REF = { provider: 'opl-gateway', model: 'grok::grok-4.7' }
const CODEX_REF = { provider: 'opl-gateway', model: 'codex::gpt-5-codex' }
const CODEX_COMBINATION = 'proxy-fixture-codex'
const DESKTOP = 'http://desktop-proxy.test:8080'
const CUSTOM = 'http://custom-proxy.test:3128'
const OTHER = 'http://other-proxy.test:3128'
const SECOND = 'http://second-proxy.test:8080'
const LOOPBACK = 'localhost,127.0.0.1,::1'
const PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})

/**
 * Run the proxy lifecycle through the real `HarnessService` and real child processes.
 *
 * Proxy configuration is only observable from inside the ACP process the suite starts: the
 * service rewrites the launch environment immediately before spawning it, so a host-side
 * value cannot prove what a running Harness actually received. Every assertion here
 * therefore reads what `tests/fixtures/proxy-acp-agent.mjs` reports about itself — its pid,
 * its proxy environment and the session method it served — from the turn transcript and from
 * the append-only record it leaves in its working directory.
 *
 * The only seam is the adapter's launch step, replaced for exactly this Node fixture and
 * refused for anything else:
 *
 * - the service under test stays real: catalog persistence, connection reuse, disposal of
 *   the replaced ACP process and bridge, native session resume, turn admission and
 *   operation deduplication are all the production code paths;
 * - the Grok configuration file and gateway-key handling stay real, reusing the production
 *   helpers, and the fixture is launched *with* a credential in its environment so the
 *   assertion that its report carries no credential is meaningful;
 * - no production module gains a test hook and no platform is faked. Production Grok
 *   refuses restricted tiers on Windows because its official sandbox has no backend there;
 *   that refusal is verified in the Grok suite, and replacing only the launch step here
 *   says nothing about whether an official CLI's sandbox works.
 */
function useNodeProxyAcpFixture() {
  const grok = adapterFor('grok-build', GROK_REF)
  if (!grok) throw Error('fixture seam requires the Grok adapter entry')
  vi.spyOn(grok, 'prepare').mockImplementation(async (ctx, record, options) => {
    if (options.prefix?.length !== 1 || options.prefix[0] !== FIXTURE)
      throw Error('The fixture adapter only launches the Node ACP proxy fixture')
    const route = await resolveGatewayExecution(ctx, record.modelRef, options.resolveKey)
    const home = join(options.home, 'harnesses', 'grok-build')
    await mkdir(home, { recursive: true, mode: 0o700 })
    // The real configuration layout is still written, so the credential path stays real.
    const config = join(home, 'config.toml'),
      bytes = grokConfiguration(route.baseURL)
    const current = await readFile(config, 'utf8').catch(() => undefined)
    if (current === undefined) await writeFile(config, bytes, { mode: 0o600, flag: 'wx' })
    else if (current !== bytes) await writeFile(config, bytes, { mode: 0o600 })
    return {
      home,
      ...commandLaunch(process.execPath, [
        ...(options.prefix ?? []),
        '--cwd',
        record.cwd,
        '--model',
        'grok-4.7',
        'agent',
        '--no-leader',
        'stdio',
      ]),
      env: {
        ...systemEnvironment(),
        GROK_HOME: home,
        [GROK_API_KEY_REF]: route.apiKey,
        // The fixture advertises the combination's pinned model, so every connection
        // re-checks it and a reconnect that lost the pin would fail instead of pass.
        OPL_FIXTURE_MODEL: 'grok-4.7',
      },
    }
  })
  const codex = adapterFor('codex', CODEX_REF)
  if (!codex) throw Error('fixture seam requires the Codex adapter entry')
  vi.spyOn(codex, 'prepare').mockImplementation(async (_ctx, record, options) => {
    if (record.harnessRef !== 'codex' || record.modelRef.model !== CODEX_REF.model)
      throw Error('The fixture adapter only launches the Node ACP proxy fixture')
    const home = join(options.home, 'harnesses', 'codex')
    await mkdir(home, { recursive: true, mode: 0o700 })
    return {
      home,
      command: process.execPath,
      args: [FIXTURE],
      // The second Harness deliberately carries no credential, so its report cannot be
      // proven clean of one here; the Grok launch above is the case that carries a key.
      env: systemEnvironment(),
    }
  })
}

/**
 * Declare the routing the Desktop process itself hands down, so an inherited proxy from
 * the machine running the suite can never be mistaken for one this suite chose. Every
 * routing variable the suite can pass on is reset first and restored after the test.
 * @param values - the exact proxy variables Desktop exposes to Harness children.
 * @returns nothing; replaces the host environment for the duration of the test.
 */
function desktopProxy(values: Record<string, string>) {
  const saved = new Map(PROXY_KEYS.map((key) => [key, process.env[key]]))
  for (const key of PROXY_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) process.env[key] = value
  cleanups.push(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

async function setup() {
  useNodeProxyAcpFixture()
  const root = await mkdtemp(join(tmpdir(), 'opl-proxy-acp-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const options = {
    home: join(root, 'state'),
    command: process.execPath,
    prefix: [FIXTURE],
    resolveKey: async () => 'test-grok-key',
  }
  const ctx = { get: () => undefined, agents: { get: () => undefined } } as unknown as Context
  const service = new HarnessService(ctx, options)
  cleanups.push(() => service.dispose())
  // One working directory per Harness, so each child's own record is unambiguous.
  const grokCwd = join(root, 'grok'),
    codexCwd = join(root, 'codex')
  await mkdir(grokCwd, { recursive: true })
  await mkdir(codexCwd, { recursive: true })
  return { root, options, ctx, service, grokCwd, codexCwd }
}

const start = (service: HarnessService, cwd: string, combination = GROK_COMBINATION) =>
  service.start({
    combination,
    cwd,
    taskId: 'proxy',
    origin: { kind: 'codex', sessionId: 'parent' },
  })
const wait = (service: HarnessService, id: string) =>
  service.wait({ sessionId: id }, AbortSignal.timeout(8000))

/** Everything a running Harness reported about its own launch, read from its turn result. */
const launchOf = (turn: HarnessTurn) =>
  JSON.parse(turn.tools.find((tool) => tool.id === 'proxy-report')!.outputJson!) as {
    pid: number
    proxy: Record<string, string>
    model: string | null
    session: { sessionId: string; method: string; loadSession: boolean }
  }
/** The append-only record a Harness child left behind in its working directory. */
async function events(cwd: string) {
  const raw = await readFile(join(cwd, 'proxy-acp.log'), 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
}
/**
 * The distinct routing variables a running Harness actually received.
 *
 * A Windows environment block is case-insensitive, so a child reading `process.env` finds
 * one variable under every spelling — `HTTP_PROXY` and `http_proxy` are the same variable
 * there, not a duplicate the suite created. These comparisons therefore name variables in
 * lower case: that still proves which variables survived, what each one routes to, and
 * that nothing extra was inherited, while the spelling itself stays a property of the
 * platform rather than of the suite. `direct` and `custom` claims are unaffected by this:
 * an absent variable is absent under every spelling.
 * @param proxy - the routing map a Harness reported about itself.
 * @returns the same map keyed by lower-case variable name.
 */
const routes = (proxy: Record<string, string>) =>
  Object.fromEntries(Object.entries(proxy).map(([name, value]) => [name.toLowerCase(), value]))
const prompts = async (cwd: string) =>
  (await events(cwd)).filter((event) => event.event === 'prompt').map((event) => event.text)

/** Save the live catalog with one Harness's routing changed, through the service itself. */
async function setProxy(service: HarnessService, harnessId: string, proxy?: HarnessProxy) {
  const catalog = await service.executionCatalog()
  return service.saveExecutionCatalog({
    ...catalog,
    harnesses: catalog.harnesses.map((harness) =>
      harness.id === harnessId ? { ...harness, proxy } : harness,
    ),
  })
}
/** Add a second ACP Harness, so one suite can prove the routing of one does not touch another. */
async function withCodexCombination(service: HarnessService) {
  const catalog = await service.executionCatalog()
  await service.saveExecutionCatalog({
    ...catalog,
    combinations: [
      ...catalog.combinations,
      {
        id: CODEX_COMBINATION,
        name: 'Codex proxy fixture',
        modelRef: CODEX_REF,
        harnessRef: 'codex',
        permissionPolicy: 'workspace',
        isDefault: false,
        enabled: true,
      },
    ],
  })
}

describe('Harness proxy lifecycle', () => {
  it('routes the designated Harness through a custom proxy and leaves an inheriting Harness untouched', async () => {
    const { service, grokCwd, codexCwd } = await setup()
    desktopProxy({ HTTP_PROXY: DESKTOP, https_proxy: DESKTOP })
    await setProxy(service, 'grok-build', { mode: 'custom', url: CUSTOM })
    await withCodexCombination(service)

    const grok = await start(service, grokCwd)
    await service.prompt({ sessionId: grok.id, text: 'grok-turn', operationId: 'grok' })
    const grokTurn = (await wait(service, grok.id)).turns[0]!
    const codex = await start(service, codexCwd, CODEX_COMBINATION)
    await service.prompt({ sessionId: codex.id, text: 'codex-turn', operationId: 'codex' })
    const codexTurn = (await wait(service, codex.id)).turns[0]!

    // The custom Harness received exactly its own URL, with the local ACP and MCP
    // bridges left unproxied, and inherited nothing else.
    expect(routes(launchOf(grokTurn).proxy)).toEqual({
      http_proxy: CUSTOM,
      https_proxy: CUSTOM,
      no_proxy: LOOPBACK,
    })
    // The other Harness keeps Desktop's own routing, unchanged.
    expect(routes(launchOf(codexTurn).proxy)).toEqual({
      http_proxy: DESKTOP,
      https_proxy: DESKTOP,
    })
    expect(
      (await service.executionCatalog()).harnesses.find((harness) => harness.id === 'codex')?.proxy,
    ).toBeUndefined()
    // The launch carried a Gateway key; neither the transcript nor the record may echo one.
    const reported = JSON.stringify([
      launchOf(grokTurn),
      ...(await events(grokCwd)).filter((event) => event.event === 'session'),
    ])
    expect(reported).not.toContain('test-grok-key')
    expect(reported).not.toContain('OPL_GATEWAY')
  })

  it('clears every mixed-case proxy key for a direct Harness without changing an inheriting one', async () => {
    const { service, grokCwd, codexCwd } = await setup()
    desktopProxy({ HTTP_PROXY: DESKTOP, https_proxy: DESKTOP, ALL_PROXY: OTHER, all_proxy: OTHER })
    await setProxy(service, 'grok-build', { mode: 'direct' })
    await withCodexCombination(service)

    const grok = await start(service, grokCwd)
    await service.prompt({ sessionId: grok.id, text: 'grok-turn', operationId: 'grok' })
    const grokTurn = (await wait(service, grok.id)).turns[0]!
    const codex = await start(service, codexCwd, CODEX_COMBINATION)
    await service.prompt({ sessionId: codex.id, text: 'codex-turn', operationId: 'codex' })
    const codexTurn = (await wait(service, codex.id)).turns[0]!

    expect(launchOf(grokTurn).proxy).toEqual({})
    expect(routes(launchOf(codexTurn).proxy)).toEqual({
      http_proxy: DESKTOP,
      https_proxy: DESKTOP,
      all_proxy: OTHER,
    })
  })

  it('keeps an active turn alive across a catalog save and resumes the same native session on a new process', async () => {
    const { service, grokCwd } = await setup()
    desktopProxy({ HTTP_PROXY: DESKTOP })
    const session = await start(service, grokCwd)
    const acpSessionId = session.acpSessionId
    expect(acpSessionId).toBeTruthy()

    await service.prompt({ sessionId: session.id, text: 'hold', operationId: 'held' })
    // Wait for the agent itself to receive the prompt, never for a fixed delay.
    await vi.waitFor(async () => expect(await prompts(grokCwd)).toEqual(['hold']), {
      timeout: 5000,
      interval: 25,
    })
    const runningPid = (await events(grokCwd)).find((event) => event.event === 'initialize')!.pid

    const saved = await setProxy(service, 'grok-build', { mode: 'custom', url: CUSTOM })
    expect(saved.harnesses.find((harness) => harness.id === 'grok-build')?.proxy).toEqual({
      mode: 'custom',
      url: CUSTOM,
    })
    // The running turn is neither interrupted nor moved onto the new routing.
    expect(await service.snapshot({ sessionId: session.id })).toMatchObject({
      state: 'running',
      connected: true,
    })
    expect((await events(grokCwd)).filter((event) => event.event === 'initialize')).toHaveLength(1)

    // A second operation is refused while the turn runs, and creates no turn.
    await expect(
      service.prompt({ sessionId: session.id, text: 'racing', operationId: 'racing' }),
    ).rejects.toThrow('仍在执行')
    expect((await service.snapshot({ sessionId: session.id })).turns).toHaveLength(1)
    expect(await prompts(grokCwd)).toEqual(['hold'])

    await service.cancel({ sessionId: session.id })
    expect((await service.snapshot({ sessionId: session.id })).state).toBe('cancelled')

    // The next operation runs on a new process, loaded onto the same native session.
    await service.prompt({ sessionId: session.id, text: 'after-proxy', operationId: 'resumed' })
    const resumed: HarnessSnapshot = await wait(service, session.id)
    const launch = launchOf(resumed.turns.at(-1)!)
    expect(launch.pid).not.toBe(runningPid)
    expect(routes(launch.proxy)).toEqual({
      http_proxy: CUSTOM,
      https_proxy: CUSTOM,
      no_proxy: LOOPBACK,
    })
    expect(
      (await events(grokCwd))
        .filter((event) => event.event === 'session')
        .map((event) => [event.method, event.sessionId]),
    ).toEqual([
      ['session/new', acpSessionId],
      ['session/load', acpSessionId],
    ])

    // Replaying the finished operation returns its turn without issuing it again, and the
    // pinned model and permission boundary survive the replaced process.
    const replayed = await service.prompt({
      sessionId: session.id,
      text: 'hold',
      operationId: 'held',
    })
    expect(replayed.turns).toHaveLength(2)
    expect(await prompts(grokCwd)).toEqual(['hold', 'after-proxy'])
    expect(resumed).toMatchObject({ sandbox: 'workspace', modelRef: GROK_REF, acpSessionId })
    expect(launch.model).toBe('grok-4.7')
  })

  it('keeps the live process when another Harness routing changes', async () => {
    const { service, grokCwd } = await setup()
    desktopProxy({ HTTP_PROXY: DESKTOP })
    await withCodexCombination(service)

    const session = await start(service, grokCwd)
    await service.prompt({ sessionId: session.id, text: 'first', operationId: 'one' })
    const firstPid = launchOf((await wait(service, session.id)).turns[0]!).pid

    await setProxy(service, 'codex', { mode: 'custom', url: OTHER })
    await service.prompt({ sessionId: session.id, text: 'second', operationId: 'two' })
    const second = await wait(service, session.id)

    expect(launchOf(second.turns.at(-1)!).pid).toBe(firstPid)
    expect(routes(launchOf(second.turns.at(-1)!).proxy)).toEqual({ http_proxy: DESKTOP })
    const recorded = await events(grokCwd)
    expect(recorded.filter((event) => event.event === 'initialize')).toHaveLength(1)
    expect(
      recorded.filter((event) => event.event === 'session').map((event) => event.method),
    ).toEqual(['session/new'])
    expect(await prompts(grokCwd)).toEqual(['first', 'second'])
  })

  it('resumes a stored session on the routing the catalog holds after a restart', async () => {
    const { service, ctx, options, grokCwd } = await setup()
    desktopProxy({ HTTP_PROXY: DESKTOP })
    await setProxy(service, 'grok-build', { mode: 'custom', url: CUSTOM })
    const session = await start(service, grokCwd)
    await service.prompt({ sessionId: session.id, text: 'before-restart', operationId: 'one' })
    const before = await wait(service, session.id)
    const firstPid = launchOf(before.turns[0]!).pid
    await service.dispose()

    // The routing is persisted, not merely held in memory: the saved file is what a
    // restarted profile reads back.
    const store = new ExecutionCatalogStore(options.home)
    const catalog = await store.get()
    await store.set({
      ...catalog,
      harnesses: catalog.harnesses.map((harness) =>
        harness.id === 'grok-build'
          ? { ...harness, proxy: { mode: 'custom', url: SECOND } }
          : harness,
      ),
    })
    await store.dispose()
    const persisted = JSON.parse(
      await readFile(join(options.home, 'profiles/desktop/execution-catalog.json'), 'utf8'),
    )
    expect(persisted.harnesses.find((harness: any) => harness.id === 'grok-build').proxy).toEqual({
      mode: 'custom',
      url: SECOND,
    })

    const restored = new HarnessService(ctx, options)
    cleanups.push(() => restored.dispose())
    await restored.start({
      combination: GROK_COMBINATION,
      cwd: grokCwd,
      existingSessionId: session.id,
    })
    await restored.prompt({ sessionId: session.id, text: 'after-restart', operationId: 'two' })
    const resumed = await restored.wait({ sessionId: session.id }, AbortSignal.timeout(8000))
    const launch = launchOf(resumed.turns.at(-1)!)

    expect(launch.pid).not.toBe(firstPid)
    expect(routes(launch.proxy)).toEqual({
      http_proxy: SECOND,
      https_proxy: SECOND,
      no_proxy: LOOPBACK,
    })
    expect(
      (await events(grokCwd))
        .filter((event) => event.event === 'session')
        .map((event) => [event.method, event.sessionId]),
    ).toEqual([
      ['session/new', before.acpSessionId],
      ['session/load', before.acpSessionId],
    ])
    expect(await prompts(grokCwd)).toEqual(['before-restart', 'after-restart'])
  })
})

// These suites exercise other harnesses; their catalog must not probe a personal ZCode install.
beforeEach(() => {
  vi.spyOn(
    harnessAdapters.find((adapter) => adapter.id === 'minimax-code')!,
    'available',
  ).mockResolvedValue({ available: false, reason: 'MiniMax outside this fixture' })
  vi.spyOn(harnessRegistry, 'inspectHarness').mockImplementation(async (definition) => ({
    id: definition.id,
    name: definition.name,
    installed: true,
    runnable: true,
    path: definition.command ?? process.execPath,
    instructions: 'fixture',
    website: 'https://example.test',
  }))
  vi.spyOn(
    harnessAdapters.find((adapter) => adapter.id === 'zcode')!,
    'available',
  ).mockResolvedValue({ available: false, reason: 'ZCode outside this fixture' })
})
