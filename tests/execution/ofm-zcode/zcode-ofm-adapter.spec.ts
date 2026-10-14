/**
 * Owned behaviour evidence for the Our Free Model adapter itself.
 *
 * These tests cover the decisions the adapter makes *before* anything is launched: which
 * model references it claims, which reasoning levels it will pin, how it treats the
 * resolved route, and how it refuses. The credential assertions matter most: this route
 * must reach the key only through the public source registry and the private stdio
 * channel, and must never borrow the Huawei MaaS key or fall back to the Huawei route.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelRef } from '../../../src/execution/contracts/catalog.ts'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'
import type {
  ExternalModelSource,
  ExternalWireProtocol,
} from '../../../src/execution/host/model-sources.ts'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import type { AdapterOptions } from '../../../src/execution/host/adapters/types.ts'
import {
  OFM_CREDENTIAL_REQUESTS,
  zcodeOfmAdapter,
  zcodeOfmBridgePath,
} from '../../../src/execution/host/adapters/zcode-ofm/zcode-ofm.ts'
import {
  OFM_RELAY_PLACEHOLDER_KEY,
  OFM_ZCODE_PROVIDER_ID,
  ZCODE_OFM_MODELS,
  ZCODE_OFM_PROVIDER_ID,
  ZCODE_OFM_REASONING_LEVELS,
} from '../../../src/execution/host/adapters/zcode-ofm/zcode-ofm-models.ts'

const REF: ModelRef = { provider: ZCODE_OFM_PROVIDER_ID, model: ZCODE_OFM_MODELS[0] }
const HUAWEI_KEY = 'huawei-key-that-must-never-be-used'
const OFM_KEY = 'ofm-forward-key'

const cleanups: (() => Promise<void> | void)[] = []
const savedEnv: Record<string, string | undefined> = {}
afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key]
  for (const done of cleanups.splice(0)) await done()
})
const setEnv = (name: string, value: string) => {
  savedEnv[name] = process.env[name]
  process.env[name] = value
}

const makeHome = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opl-ofm-adapter-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

/** A real `ExternalModelSources` registry, so the shared registry contract is exercised. */
function makeRegistry(sources: ExternalModelSource[]) {
  const ctx = {
    // The real cordis `effect` runs the callback and returns its disposer, which is what
    // actually removes the source. Returning a no-op here would make every unload test
    // silently meaningless.
    effect: (fn: () => unknown) => fn(),
  } as unknown as Context
  const registry = new ExternalModelSources(ctx)
  const disposers = sources.map((source) => registry.register(ctx, source))
  return {
    registry,
    /** Unload the owner and load a different one, exactly as a plugin swap would. */
    replace(source?: ExternalModelSource) {
      for (const dispose of disposers.splice(0)) dispose()
      if (source) disposers.push(registry.register(ctx, source))
    },
  }
}

const ofmSource = (
  overrides: Partial<ExternalModelSource> = {},
  answer: Partial<{
    baseURL: string
    model: string
    apiKey: string
    protocol: ExternalWireProtocol
  }> = {},
): ExternalModelSource => ({
  provider: ZCODE_OFM_PROVIDER_ID,
  supports: () => true,
  resolve: () =>
    Promise.resolve({
      baseURL: 'http://127.0.0.1:41234',
      model: REF.model,
      apiKey: OFM_KEY,
      protocol: 'chat',
      ...answer,
    }),
  ...overrides,
})

/**
 * A source whose `resolve` only finishes when released, and which announces the moment
 * the registry has captured it. Tests await that announcement, so revocation always
 * lands mid-read without any timer or sleep.
 */
function slowSource() {
  let announce!: () => void
  let release!: () => void
  const began = new Promise<void>((done) => (announce = done))
  const gate = new Promise<void>((done) => (release = done))
  const slow = ofmSource({
    resolve: async () => {
      announce()
      await gate
      return {
        baseURL: 'http://127.0.0.1:41234',
        model: REF.model,
        apiKey: OFM_KEY,
        protocol: 'chat',
      }
    },
  })
  return { slow, began, release }
}

/**
 * A hermetic stand-in for the official install layout.
 *
 * The adapter resolves the built-in provider release out of the installed CLI, because
 * the real runtime exits before any session exists when that release is unavailable.
 * Building the same shape here keeps the resolver honest without depending on a
 * particular machine's install directory.
 */
const makeInstall = async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-ofm-install-'))
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const releaseDir = join(root, 'resources', 'config', 'provider')
  await mkdir(releaseDir, { recursive: true })
  await mkdir(join(root, 'resources', 'glm'), { recursive: true })
  const release = join(releaseDir, 'zcode-builtin.json')
  await writeFile(release, JSON.stringify({ schemaVersion: 1, revision: 1, config: {} }))
  const bundle = join(root, 'resources', 'glm', 'zcode.cjs')
  await writeFile(bundle, '// stand-in bundle')
  const executable = join(root, 'ZCode.exe')
  await writeFile(executable, 'MZ')
  return { root, release, command: executable, prefix: [bundle] }
}

const options = async (extra: Partial<AdapterOptions> = {}): Promise<AdapterOptions> => {
  const install = await makeInstall()
  return {
    home: await makeHome(),
    command: install.command,
    prefix: install.prefix,
    grokCommand: process.execPath,
    nativeBridgePath: '/unused',
    ...extra,
  }
}

const record = (over: Partial<HarnessSession> = {}): HarnessSession =>
  ({
    id: 'session-1',
    harnessRef: 'zcode',
    modelRef: REF,
    cwd: process.cwd(),
    sandbox: 'full-access',
    acpSessionId: '',
    ...over,
  }) as unknown as HarnessSession

const ctx = {} as unknown as Context
const prepare = (session: HarnessSession, opts: AdapterOptions) =>
  zcodeOfmAdapter.prepare!(ctx, session, opts)

describe('ZCode · Our Free Model claims only its exact models', () => {
  test('accepts both adapted models on the declared provider', () => {
    for (const model of ZCODE_OFM_MODELS)
      expect(zcodeOfmAdapter.matches({ provider: ZCODE_OFM_PROVIDER_ID, model })).toBe(true)
  })

  test('refuses other models, the region route and other providers', () => {
    const refused = [
      { provider: ZCODE_OFM_PROVIDER_ID, model: 'z-ai/glm-5.4' },
      { provider: ZCODE_OFM_PROVIDER_ID, model: 'moonshotai/kimi-k2.6' },
      { provider: ZCODE_OFM_PROVIDER_ID, model: 'GLM-5.3' },
      { provider: 'our-free-model-region', model: 'z-ai/glm-5.3' },
      { provider: 'huawei-maas', model: 'glm-5.2' },
    ]
    for (const ref of refused) expect(zcodeOfmAdapter.matches(ref)).toBe(false)
  })

  test('declares the same engine capabilities as the Huawei route, with a custom endpoint', () => {
    expect(zcodeOfmAdapter.id).toBe('zcode')
    expect(zcodeOfmAdapter.transport).toBe('acp')
    expect(zcodeOfmAdapter.capabilities.customEndpoint).toBe(true)
    expect(zcodeOfmAdapter.capabilities.protocols).toEqual(['chat'])
    // `plan` is a tool policy, not an operating-system sandbox, so only the explicitly
    // authorized full-access is advertised.
    expect(zcodeOfmAdapter.capabilities.permissions).toEqual(['full-access'])
    expect(zcodeOfmAdapter.capabilities.sessionLoad).toBe(true)
    expect(zcodeOfmAdapter.capabilities.cancel).toBe(true)
    // The real CLI does not read the reasoning level back, so no runtime-advertised
    // claim is made: the levels are declared by the provider config only.
    expect(zcodeOfmAdapter.capabilities.reasoning).toBe('model-declared')
  })

  test('resolves its bridge entry next to itself, and the file is really there', () => {
    expect(existsSync(zcodeOfmBridgePath())).toBe(true)
  })
})

describe('ZCode · Our Free Model resolves only an explicit source route', () => {
  test('launches with the exact model, loopback upstream, and no credential on disk', async () => {
    const launch = await prepare(
      record(),
      await options({ modelSources: makeRegistry([ofmSource()]).registry }),
    )
    expect(launch.env.OPL_ZCODE_OFM_MODEL).toBe(REF.model)
    // The built-in layer is the official release inside the installed CLI, referenced
    // read-only from its real location — never copied or rewritten into the session home.
    const builtin = launch.env.OPL_ZCODE_OFM_PROVIDER_CONFIG_FILE!
    expect(builtin).toContain(join('resources', 'config', 'provider'))
    expect(builtin.endsWith('zcode-builtin.json')).toBe(true)
    expect(builtin.startsWith(launch.home)).toBe(false)
    // Only the personal layer lives in the session home.
    expect(launch.env.OPL_ZCODE_OFM_PERSONAL_PROVIDER_CONFIG_FILE).toBe(
      join(launch.home, 'provider-personal.json'),
    )
    expect(launch.env.OPL_ZCODE_OFM_UPSTREAM).toBe('http://127.0.0.1:41234')
    expect(launch.env.OPL_ZCODE_OFM_MODE).toBe('yolo')
    expect(launch.env.OPL_ZCODE_OFM_REASONING_LEVEL).toBe('enabled')
    // The credential is reachable only through the private channel.
    const resolve = launch.clientRequests!.get(OFM_CREDENTIAL_REQUESTS.resolve)!
    expect(await resolve()).toBe(OFM_KEY)
    const describe = launch.clientRequests!.get(OFM_CREDENTIAL_REQUESTS.describe)!
    expect(await describe()).toMatchObject({ configured: true })
    expect(launch.clientRequests!.size).toBe(2)

    // Nothing on the command line or in the environment carries the key, and no Huawei
    // credential reference is reachable from this route at all.
    expect(JSON.stringify(launch.args)).not.toContain(OFM_KEY)
    expect(JSON.stringify(launch.env)).not.toContain(OFM_KEY)
    expect(JSON.stringify(launch.env)).not.toContain(HUAWEI_KEY)
    expect(launch.env.OPL_ZCODE_OFM_REASONING_LEVEL).not.toBe('max')
  })

  test('refuses when no source is registered at all, with no fallback route', async () => {
    await expect(prepare(record(), await options())).rejects.toThrow(/未注册 Our Free Model/)
  })

  test('refuses when the registered source does not support this pairing', async () => {
    const { registry } = makeRegistry([ofmSource({ supports: () => false })])
    await expect(prepare(record(), await options({ modelSources: registry }))).rejects.toThrow(
      /尚未适配 ZCode/,
    )
  })

  test('refuses a substituted model instead of running what the source returned', async () => {
    const { registry } = makeRegistry([ofmSource({}, { model: 'z-ai/glm-4.7' })])
    await expect(prepare(record(), await options({ modelSources: registry }))).rejects.toThrow(
      /与所选/,
    )
  })

  test('refuses an incompatible protocol', async () => {
    const { registry } = makeRegistry([ofmSource({}, { protocol: 'messages' })])
    await expect(prepare(record(), await options({ modelSources: registry }))).rejects.toThrow(
      /模型来源未提供兼容的执行参数/,
    )
  })

  test('refuses an endpoint that is not the owner loopback lane', async () => {
    const { registry } = makeRegistry([ofmSource({}, { baseURL: 'https://api.example.com/v1' })])
    await expect(prepare(record(), await options({ modelSources: registry }))).rejects.toThrow(
      /不是本机转发通道/,
    )
  })

  test('refuses an empty credential rather than launching unkeyed', async () => {
    const { registry } = makeRegistry([ofmSource({}, { apiKey: '' })])
    await expect(prepare(record(), await options({ modelSources: registry }))).rejects.toThrow()
  })

  test('refuses when the source is revoked while its route is being read', async () => {
    const { slow, began, release } = slowSource()
    const { registry, replace } = makeRegistry([slow])
    const running = prepare(record(), await options({ modelSources: registry }))
    // Deterministic, not a sleep: wait until the registry has really captured this source
    // and is awaiting its answer, then revoke it mid-read.
    await began
    replace(ofmSource())
    release()
    await expect(running).rejects.toThrow(/模型来源已变更/)
  })

  test('refuses when the owner unloads the route while its route is being read', async () => {
    const { slow, began, release } = slowSource()
    const { registry, replace } = makeRegistry([slow])
    const running = prepare(record(), await options({ modelSources: registry }))
    await began
    replace()
    release()
    await expect(running).rejects.toThrow(/模型来源已变更/)
  })

  test('a source that revokes itself without a replacement also fails closed', async () => {
    const { slow, began, release } = slowSource()
    const { registry, replace } = makeRegistry([slow])
    const running = prepare(record(), await options({ modelSources: registry }))
    await began
    replace()
    release()
    await expect(running).rejects.toThrow(/模型来源已变更/)
  })
})

describe('ZCode · Our Free Model keeps permission and shell separate', () => {
  test('refuses every restricted sandbox before launching', async () => {
    const opts = await options({ modelSources: makeRegistry([ofmSource()]).registry })
    for (const sandbox of ['read-only', 'workspace'] as const) {
      await expect(prepare(record({ sandbox }), opts)).rejects.toThrow(/full-access/)
    }
  })

  test('refuses an undeclared reasoning level instead of clamping it', async () => {
    const opts = await options({ modelSources: makeRegistry([ofmSource()]).registry })
    // `max` and `high` belong to a different official model rule.
    for (const level of ['max', 'high', 'medium']) {
      await expect(prepare(record({ reasoningEffort: level }), opts)).rejects.toThrow(/推理档位/)
    }
  })

  test('honours an explicit declared level and an absent one', async () => {
    const opts = await options({ modelSources: makeRegistry([ofmSource()]).registry })
    expect(
      (await prepare(record({ reasoningEffort: 'disabled' }), opts)).env
        .OPL_ZCODE_OFM_REASONING_LEVEL,
    ).toBe('disabled')
    expect((await prepare(record(), opts)).env.OPL_ZCODE_OFM_REASONING_LEVEL).toBe('enabled')
    expect([...ZCODE_OFM_REASONING_LEVELS]).toEqual(['disabled', 'enabled'])
  })

  test('never advertises a level the official GLM-5 family rule does not declare', async () => {
    expect([...ZCODE_OFM_REASONING_LEVELS]).not.toContain('max')
    expect([...ZCODE_OFM_REASONING_LEVELS]).not.toContain('high')
  })

  test.runIf(process.platform === 'win32')(
    'fails explicitly when the configured Git Bash is not bash, with no shell fallback',
    async () => {
      // A real executable that is definitely not Git Bash: `node.exe`.
      setEnv('OPL_GIT_BASH_PATH', process.execPath)
      const opts = await options({ modelSources: makeRegistry([ofmSource()]).registry })
      await expect(prepare(record(), opts)).rejects.toThrow(/不回退 PowerShell、CMD 或 WSL/)
      expect(
        await (async () => {
          try {
            await prepare(record(), opts)
            return false
          } catch {
            return true
          }
        })(),
      ).toBe(true)
    },
  )

  test.runIf(process.platform === 'win32')(
    'refuses an explicit Git Bash path that does not exist, without searching elsewhere',
    async () => {
      // The documented no-fallback branch: an explicit override that is not a real
      // executable is refused outright rather than replaced by another candidate.
      setEnv('OPL_GIT_BASH_PATH', join(await makeHome(), 'not-here', 'bash.exe'))
      const opts = await options({ modelSources: makeRegistry([ofmSource()]).registry })
      await expect(prepare(record(), opts)).rejects.toThrow(/未找到可运行的 Git Bash/)
    },
  )
})

describe('ZCode · Our Free Model never writes a credential to the isolated profile', () => {
  test('the launch environment carries no key and the profile is a fresh directory', async () => {
    const home = await makeHome()
    const launch = await prepare(
      record(),
      await options({ home, modelSources: makeRegistry([ofmSource()]).registry }),
    )
    const profile = join(launch.home, 'profile')
    expect(launch.home.startsWith(home)).toBe(true)
    // Isolation uses the Windows profile entry only. `HOME` is not a Windows isolation
    // mechanism, so it is absent rather than misleadingly set; `CODEX_HOME` belongs to
    // another harness and is never touched.
    expect(launch.env.USERPROFILE).toBe(profile)
    // `HOME` is inherited exactly as the machine has it and is deliberately *not*
    // redirected: on Windows the official runtime resolves its data directory from
    // `USERPROFILE`, so rewriting `HOME` would be a Linux-only mechanism asserted here
    // for no effect. It is also never pointed at the isolated profile.
    expect(launch.env.HOME).toBe(process.env.HOME)
    expect(launch.env.HOME).not.toBe(profile)
    // `CODEX_HOME` belongs to another harness entirely, and `systemEnvironment()` copies
    // a fixed allowlist that does not include it. This route therefore neither sets nor
    // inherits it: it must be absent from the launch environment, never point at the
    // isolated profile, and must not vary with whatever the ambient machine happens to
    // have. Asserting equality with `process.env.CODEX_HOME` would only pass by accident
    // on a machine where it happens to be unset, and would wrongly claim it is inherited.
    expect(launch.env.CODEX_HOME).toBeUndefined()
    expect(launch.env.CODEX_HOME).not.toBe(profile)
    // The real user's ZCode profile is never the one this session runs in.
    expect(launch.env.USERPROFILE).not.toBe(process.env.USERPROFILE)
    // Scratch space is inside the session home, never the shared machine TEMP.
    expect(launch.env.TEMP).toBe(join(launch.home, 'tmp'))
    expect(launch.env.TMP).toBe(join(launch.home, 'tmp'))
    // Only the placeholder may appear in a config file, and the key appears nowhere.

    for (const value of Object.values(launch.env)) expect(String(value)).not.toContain(OFM_KEY)
    expect(await readFile(join(profile, '.config', 'zcode'), 'utf8').catch(() => '')).not.toContain(
      OFM_KEY,
    )
    expect(OFM_RELAY_PLACEHOLDER_KEY).not.toBe(OFM_KEY)
    expect(OFM_ZCODE_PROVIDER_ID).not.toBe('huawei-maas')
  })
})

describe('ZCode · Our Free Model packaging path conversion', () => {
  // The shipped host is `package/lib/index.js`; the source checkout runs `.ts`. The
  // bridge must resolve to whatever sits beside the running module, never to a path in
  // the other layout.
  test('resolves the emitted .mjs beside the packaged index.js bundle', () => {
    const resolved = zcodeOfmBridgePath('file:///C:/owned/package/lib/index.js')
    expect(resolved).toBe(
      join('C:' + String.fromCharCode(92), 'owned', 'package', 'lib', 'zcode-ofm-bridge.mjs'),
    )
    expect(resolved.endsWith('zcode-ofm-bridge.mjs')).toBe(true)
  })

  test('resolves the emitted .mjs beside an already-emitted index.mjs bundle', () => {
    expect(zcodeOfmBridgePath('file:///C:/owned/package/lib/index.mjs')).toMatch(
      /zcode-ofm-bridge\.mjs$/,
    )
  })

  test('keeps the source checkout on the .ts bridge', () => {
    expect(
      zcodeOfmBridgePath('file:///C:/owned/src/execution/host/adapters/zcode-ofm/index.ts'),
    ).toMatch(/zcode-ofm-bridge\.ts$/)
  })

  test('resolves beside the module, not at a fixed install path', () => {
    // Two different bundle locations must resolve to two different bridges, each one
    // next to its own bundle.
    const a = zcodeOfmBridgePath('file:///C:/one/lib/index.js')
    const b = zcodeOfmBridgePath('file:///C:/two/lib/index.js')
    expect(a).not.toBe(b)
    expect(dirname(a)).toBe(dirname(zcodeOfmBridgePath('file:///C:/one/lib/index.js')))
    expect(a.startsWith(join('C:' + String.fromCharCode(92), 'one'))).toBe(true)
    expect(b.startsWith(join('C:' + String.fromCharCode(92), 'two'))).toBe(true)
  })

  test('never resolves a bridge that does not exist in the source checkout', () => {
    // The default call site must point at the real file in this repository.
    expect(existsSync(zcodeOfmBridgePath())).toBe(true)
    expect(zcodeOfmBridgePath().endsWith('zcode-ofm-bridge.ts')).toBe(true)
  })
})

describe('ZCode · Our Free Model credential reads re-check the pinned source', () => {
  test('a source withdrawn after preparation stops the credential read', async () => {
    const { registry, replace } = makeRegistry([ofmSource()])
    const launch = await prepare(record(), await options({ modelSources: registry }))
    const resolve = launch.clientRequests!.get(OFM_CREDENTIAL_REQUESTS.resolve)!
    // Before withdrawal the pinned registration still answers.
    expect(await resolve()).toBe(OFM_KEY)
    // The owner withdraws after the launch was prepared. A session already running would
    // otherwise keep reading a credential the owner has taken back.
    replace()
    await expect(resolve()).rejects.toThrow(/模型来源已变更/)
    await expect(launch.clientRequests!.get(OFM_CREDENTIAL_REQUESTS.describe)!()).rejects.toThrow(
      /模型来源已变更/,
    )
  })

  test('a source replaced by another instance also stops the credential read', async () => {
    const { registry, replace } = makeRegistry([ofmSource()])
    const launch = await prepare(record(), await options({ modelSources: registry }))
    const resolve = launch.clientRequests!.get(OFM_CREDENTIAL_REQUESTS.resolve)!
    replace(ofmSource({}, { apiKey: 'a-different-key' }))
    // Same provider, same declared pairing, different registration object.
    await expect(resolve()).rejects.toThrow(/模型来源已变更/)
  })

  test('a valid lease is not treated as proof the model is still offered', async () => {
    // The owner's live catalog is the owner's job. The lease covers registration and
    // declared pairing only, so a source whose catalogue has dropped the model still
    // resolves through `sources.resolve` when it claims to support it — which is exactly
    // why the adapter never infers availability from the lease.
    const { registry } = makeRegistry([
      ofmSource({
        supports: () => true,
        resolve: () =>
          Promise.resolve({
            baseURL: 'http://127.0.0.1:41234',
            model: REF.model,
            apiKey: OFM_KEY,
            protocol: 'chat',
          }),
      }),
    ])
    const launch = await prepare(record(), await options({ modelSources: registry }))
    expect(launch.env.OPL_ZCODE_OFM_MODEL).toBe(REF.model)
    // No freshness field from the owner is invented, and no generation marker is carried.
    expect(Object.keys(launch.env).some((k) => /GENERATION|REVISION|FINGERPRINT/.test(k))).toBe(
      false,
    )
  })
})

describe("ZCode · Our Free Model does not take over another harness's data directory", () => {
  test('never propagates an ambient CODEX_HOME and never redirects it', async () => {
    // Set it to something distinctive so an accidental inheritance or redirect is
    // unmistakable. This is a test-local value; no real CODEX_HOME is read or written.
    const ambient = join(await makeHome(), 'other-harness-codex-home')
    setEnv('CODEX_HOME', ambient)
    const { registry } = makeRegistry([ofmSource()])
    const launch = await prepare(record(), await options({ modelSources: registry }))
    const profile = join(launch.home, 'profile')

    // Absent, not inherited: `systemEnvironment()` copies a fixed allowlist and this
    // route adds nothing outside it.
    expect(launch.env.CODEX_HOME).toBeUndefined()
    expect(JSON.stringify(launch.env)).not.toContain('CODEX_HOME')
    // And it was certainly not repointed at this session's isolated profile.
    expect(Object.values(launch.env).some((value) => value === ambient)).toBe(false)
    expect(launch.env.USERPROFILE).toBe(profile)
    expect(launch.env.USERPROFILE).not.toBe(ambient)
  })

  test('stays absent on a machine that has no CODEX_HOME at all', async () => {
    const saved = process.env.CODEX_HOME
    delete process.env.CODEX_HOME
    try {
      const { registry } = makeRegistry([ofmSource()])
      const launch = await prepare(record(), await options({ modelSources: registry }))
      expect(launch.env.CODEX_HOME).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = saved
    }
  })

  test('does not leak the same session boundary to the other harness variables it may inherit', async () => {
    // The allowlist does include the sibling harnesses' own variables. They are copied
    // verbatim, which is correct: this route must not repoint them either.
    const { registry } = makeRegistry([ofmSource()])
    const launch = await prepare(record(), await options({ modelSources: registry }))
    const profile = join(launch.home, 'profile')
    for (const name of ['MINIMAX_DATA_DIR', 'MAVIS_DATA_DIR'] as const) {
      if (process.env[name] === undefined) continue
      expect(launch.env[name]).toBe(process.env[name])
      expect(launch.env[name]).not.toBe(profile)
    }
  })
})
