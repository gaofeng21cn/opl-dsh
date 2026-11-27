import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { adapterFor, automaticHarness } from '../../src/execution/host/adapters/index.ts'
import { openCodeWireModel } from '../../src/execution/host/adapters/opencode/index.ts'
import { HarnessConfigurationError } from '../../src/execution/host/acp.ts'
import { isCustomAcpHarness } from '../../src/execution/contracts/harness-groups.ts'
import { defaultExecutionCatalog } from '../../src/execution/host/catalog.ts'
import { inspectHarness } from '../../src/execution/host/harness-registry.ts'
import { HarnessService } from '../../src/execution/host/harness.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import { testPeerConnection } from '../test-peer.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})

async function writeVersionScript(root: string, name: string, output: string, code = 0) {
  const script = join(root, name)
  await writeFile(
    script,
    `if (process.argv.includes('acp')) process.exit(99); console.log(${JSON.stringify(output)}); process.exit(${code})`,
  )
  return script
}

describe('custom standard ACP engines and flexible routing', () => {
  it('resolves, probes, and launches registered custom standard ACP harnesses without auto-routing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-custom-acp-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const script = await writeVersionScript(root, 'custom-agent.cjs', 'Custom Demo 1.2.3')
    const catalog = defaultExecutionCatalog()
    const customHarness = {
      id: 'custom-demo',
      name: 'Custom Demo',
      kind: 'acp' as const,
      command: process.execPath,
      prefix: [script, 'acp'],
    }
    const harnesses = [...catalog.harnesses, customHarness]
    expect(isCustomAcpHarness(customHarness)).toBe(true)
    expect(isCustomAcpHarness(catalog.harnesses.find((h) => h.id === 'codex'))).toBe(false)

    const ref = { provider: 'opl-gateway', model: 'deepseek-flash' }
    const adapter = adapterFor('custom-demo', ref, undefined, harnesses)!
    expect(adapter).toBeDefined()
    expect(adapter.capabilities.permissions).toEqual(['full-access'])
    expect(isCustomAcpHarness({ id: 'unverified-cli', kind: 'acp' })).toBe(false)
    expect(isCustomAcpHarness({ id: 'explicit-acp', kind: 'acp', adapter: 'acp-custom' })).toBe(
      true,
    )
    expect(automaticHarness(ref)).toBe('dsh')

    const record = {
      id: 'rec-custom',
      combination: 'custom:custom-demo:opl-gateway:deepseek-flash',
      harnessRef: 'custom-demo',
      modelRef: ref,
      cwd: root,
      sandbox: 'workspace',
      origin: { kind: 'desktop', sessionId: 'manual' },
      acpSessionId: '',
      title: 'Custom',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      turns: [],
    } as HarnessSession
    await expect(
      adapter.prepare!({} as Context, record, {
        home: root,
        grokCommand: 'grok',
        nativeBridgePath: 'bridge.js',
      }),
    ).rejects.toThrow(HarnessConfigurationError)

    const launch = await adapter.prepare!(
      {} as Context,
      { ...record, sandbox: 'full-access' },
      { home: root, grokCommand: 'grok', nativeBridgePath: 'bridge.js' },
    )
    expect(launch.command).toBe(process.execPath)
    expect(launch.args).toEqual([script, 'acp'])
    expect(launch.home).toBe(join(root, 'harnesses', 'custom', 'custom-demo'))

    const inspected = await inspectHarness(customHarness, root, undefined, { fresh: true })
    expect(inspected).toMatchObject({
      id: 'custom-demo',
      installed: true,
      runnable: true,
      verification: 'verified',
      version: 'Custom Demo 1.2.3',
    })

    const brokenScript = await writeVersionScript(root, 'broken-agent.cjs', '', 2)
    const failed = await inspectHarness(
      { ...customHarness, id: 'custom-broken', prefix: [brokenScript, 'acp'] },
      root,
      undefined,
      { fresh: true },
    )
    expect(failed).toMatchObject({ installed: true, runnable: false, verification: 'failed' })
  })

  it('allows OPL Gateway Chat models on OpenCode while keeping default routing intact', () => {
    const deepseek = { provider: 'opl-gateway', model: 'deepseek-flash' }
    const deepseekPrefixed = { provider: 'opl-gateway', model: 'deepseek::deepseek-chat' }
    const grok = { provider: 'opl-gateway', model: 'grok::grok-4.7' }
    const codex = { provider: 'opl-gateway', model: 'codex::gpt-5.4' }
    const claude = { provider: 'opl-gateway', model: 'claude::claude-opus-5-5' }
    const retiredGemini = { provider: 'opl-gateway', model: 'gemini::gemini-3.1-pro' }

    expect(adapterFor('opencode', deepseek)?.id).toBe('opencode')
    expect(openCodeWireModel(deepseek)).toBe('deepseek-flash')
    expect(automaticHarness(deepseek)).toBe('dsh')

    expect(adapterFor('opencode', deepseekPrefixed)?.id).toBe('opencode')
    expect(openCodeWireModel(deepseekPrefixed)).toBe('deepseek-chat')

    expect(adapterFor('opencode', grok)?.id).toBe('opencode')
    expect(openCodeWireModel(grok)).toBe('grok-4.7')
    expect(automaticHarness(grok)).toBe('grok-build')

    expect(adapterFor('opencode', codex)).toBeUndefined()
    expect(adapterFor('opencode', claude)).toBeUndefined()
    expect(adapterFor('opencode', retiredGemini)).toBeUndefined()
  })

  it('creates, binds, and promotes arbitrary model+harness selections via selectModelHarness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-select-model-harness-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const script = await writeVersionScript(root, 'acp-ok.cjs', '1.0.0')
    const models = [
      { id: 'deepseek-flash', name: 'DeepSeek Flash' },
      { id: 'codex::gpt-5.4', name: 'GPT-5.4' },
    ]
    let currentSelection: { provider: string; model: string; reasoningEffort?: string } = {
      provider: 'opl-gateway',
      model: 'deepseek-flash',
    }
    const session = {
      id: 'native-select-session',
      header: { cwd: root },
      append: vi.fn(),
      snapshotEvents: () => [],
    }
    const ctx = {
      connection: testPeerConnection,
      get: () => undefined,
      agents: { get: () => undefined, list: () => [] },
      waterfall: async (_event: string, _req: unknown, next: () => Promise<unknown>) => next(),
      sessions: { list: () => [], get: () => session },
      permissionPresets: { current: () => 'workspace-write' },
      llm: {
        listProviders: () => [{ id: 'opl-gateway', name: 'OPL Gateway' }],
        listConfigurableProviders: () => [],
        listModels: async () => models,
        resolveModelInfo: async (provider: string, id: string) => ({
          ...(models.find((m) => m.id === id) ?? { id }),
          provider,
        }),
      },
      sessionProjections: {
        snapshot: () => ({ values: { modelSelection: { next: currentSelection } } }),
      },
      typertGateway: {
        invoke: async ({ method, args }: { method: string; args?: any }) => {
          if (method === 'modelCatalog') return { default: currentSelection, groups: [] }
          if (method === 'selectModel') {
            currentSelection = {
              provider: args.request.provider,
              model: args.request.model,
              ...(args.request.reasoningEffort
                ? { reasoningEffort: args.request.reasoningEffort }
                : {}),
            }
          }
          return undefined
        },
      },
    } as unknown as Context
    const service = new HarnessService(ctx, { home: root })
    cleanups.push(() => service.dispose())

    const openCodeAdapter = adapterFor('opencode', {
      provider: 'opl-gateway',
      model: 'deepseek-flash',
    })!
    const openCodeAvailable = vi
      .spyOn(openCodeAdapter, 'available')
      .mockResolvedValue({ available: true })

    const baseCatalog = await service.executionCatalog()
    const customHarness = {
      id: 'custom-acp',
      name: 'Custom ACP',
      kind: 'acp' as const,
      command: process.execPath,
      prefix: [script],
    }
    const withCustom = await service.saveExecutionCatalog({
      ...baseCatalog,
      harnesses: [...baseCatalog.harnesses, customHarness],
    })
    expect(
      withCustom.supportedPairings?.find((p) => p.modelRef.model === 'deepseek-flash')?.harnessRefs,
    ).toEqual(expect.arrayContaining(['dsh', 'opencode', 'custom-acp']))

    const switched = await service.selectModelHarness({
      sessionId: session.id,
      modelRef: { provider: 'opl-gateway', model: 'deepseek-flash' },
      harnessRef: 'opencode',
    })
    expect(switched).toEqual({
      kind: 'external',
      sessionId: session.id,
      combination: 'custom:opencode:opl-gateway:deepseek-flash',
    })
    const afterSwitchCatalog = await service.executionCatalog()
    const dshCombo = afterSwitchCatalog.combinations.find(
      (c) => c.modelRef.model === 'deepseek-flash' && c.harnessRef === 'dsh',
    )
    const openCodeCombo = afterSwitchCatalog.combinations.find((c) => c.id === switched.combination)
    expect(dshCombo?.isDefault).toBe(true)
    expect(openCodeCombo).toMatchObject({
      enabled: true,
      isDefault: false,
      generated: false,
      permissionPolicy: 'full-access',
    })

    await service.selectModelHarness({
      sessionId: session.id,
      modelRef: { provider: 'opl-gateway', model: 'deepseek-flash' },
      harnessRef: 'opencode',
      setAsDefault: true,
    })
    const serviceReloaded = new HarnessService(ctx, { home: root })
    cleanups.push(() => serviceReloaded.dispose())
    const reloadedCatalog = await serviceReloaded.executionCatalog()
    expect(reloadedCatalog.combinations.find((c) => c.id === switched.combination)?.isDefault).toBe(
      true,
    )
    expect(
      reloadedCatalog.combinations.find(
        (c) => c.modelRef.model === 'deepseek-flash' && c.harnessRef === 'dsh',
      )?.isDefault,
    ).toBe(false)

    const customSwitched = await serviceReloaded.selectModelHarness({
      sessionId: session.id,
      modelRef: { provider: 'opl-gateway', model: 'deepseek-flash' },
      harnessRef: 'custom-acp',
    })
    expect(customSwitched.combination).toBe('custom:custom-acp:opl-gateway:deepseek-flash')

    openCodeAvailable.mockResolvedValue({ available: false, reason: 'OpenCode CLI 缺失' })
    await expect(
      serviceReloaded.selectModelHarness({
        sessionId: session.id,
        modelRef: { provider: 'opl-gateway', model: 'codex::gpt-5.4' },
        harnessRef: 'opencode',
      }),
    ).rejects.toThrow('尚无兼容适配器')
    openCodeAvailable.mockResolvedValue({ available: false, reason: 'OpenCode CLI 未安装' })
    await expect(
      serviceReloaded.selectModelHarness({
        sessionId: session.id,
        modelRef: { provider: 'opl-gateway', model: 'deepseek-flash' },
        harnessRef: 'nonexistent',
      }),
    ).rejects.toThrow('尚无兼容适配器')
  })
})
