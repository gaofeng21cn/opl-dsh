import { Context, Service } from '@deepseek-ai/cordis'
import { resolveSlotLabel, SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installSettingsSectionTitleNormalization,
  normalizeThirdPartySectionLabel,
  normalizeThirdPartySectionOrder,
  SETTINGS_ORDER,
} from '../../src/shared/client/settings-navigation.ts'

describe('third-party settings section title normalization', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  it('standardizes known and suffixed third-party titles without touching owned or native pages', () => {
    expect(normalizeThirdPartySectionLabel('bili', 'bili设置')).toBe('Billion Context')
    expect(normalizeThirdPartySectionLabel('bili', 'bili')).toBe('Billion Context')
    expect(normalizeThirdPartySectionLabel('our-free-model', 'Our Free Model')).toBe(
      'Our Free Model',
    )
    expect(normalizeThirdPartySectionLabel('demo', 'demo设置')).toBe('Demo')
    expect(normalizeThirdPartySectionLabel('acme', 'Acme Settings')).toBe('Acme')
    expect(normalizeThirdPartySectionLabel('general', '通用设置')).toBe('通用设置')
    expect(normalizeThirdPartySectionLabel('opl-updates', '更新')).toBe('更新')
    expect(normalizeThirdPartySectionLabel('opl-gateway', 'OPL Gateway')).toBe('OPL Gateway')
  })

  it('moves third-party settings sections after all native and OPL sections while keeping owned pages untouched', () => {
    expect(normalizeThirdPartySectionOrder('general', 0)).toBe(0)
    expect(normalizeThirdPartySectionOrder('remote-connection', 25)).toBe(25)
    expect(normalizeThirdPartySectionOrder('opl-execution', SETTINGS_ORDER['opl-execution'])).toBe(
      SETTINGS_ORDER['opl-execution'],
    )
    expect(normalizeThirdPartySectionOrder('opl-updates', SETTINGS_ORDER['opl-updates'])).toBe(
      SETTINGS_ORDER['opl-updates'],
    )
    expect(normalizeThirdPartySectionOrder('our-free-model', 35)).toBe(1000)
    expect(normalizeThirdPartySectionOrder('bili', 100)).toBe(1010)
    expect(normalizeThirdPartySectionOrder('third-party-demo', 35)).toBe(1035)
    expect(normalizeThirdPartySectionOrder('third-party-demo', -5)).toBe(1000)
    expect(normalizeThirdPartySectionOrder('third-party-demo', 1020)).toBe(1020)
    expect(normalizeThirdPartySectionOrder('third-party-demo')).toBe(1000)
  })

  it('normalizes titles and orders on SlotCore so third-party plugins stay last and restores originals on disposal', async () => {
    const core = new SlotCore()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())

    await ctx.plugin({
      name: 'slot-service',
      apply(provider: Context) {
        const service = Object.assign(new Service(provider, 'slots'), {
          entries: (key: string) => core.entries(key),
          subscribe: (key: string, fn: () => void) => core.subscribe(key, fn),
          inject: (_name: string, mount: () => unknown) => mount(),
          register: (options: Parameters<SlotCore['register']>[0], component: unknown) =>
            core.register(options, component),
        })
        return void service
      },
    })

    core.registerFactory(
      {
        name: 'settings.section.view',
        scope: 'root',
        children: { 'settings.section': { kind: 'list', scope: 'root' } },
      } as never,
      () => null,
    )
    const initialSections = [
      { id: 'general', order: 0, label: '通用设置' },
      { id: 'models', order: 10, label: '模型' },
      { id: 'opl-gateway', order: SETTINGS_ORDER['opl-gateway'], label: 'OPL Gateway' },
      { id: 'plugins', order: 15, label: '插件管理' },
      { id: 'agent-presets', order: 20, label: 'Agent 预设' },
      { id: 'remote-connection', order: 25, label: '远程连接' },
      { id: 'our-free-model', order: 35, label: 'Our Free Model' },
      { id: 'opl-execution', order: SETTINGS_ORDER['opl-execution'], label: '执行引擎与协作' },
      { id: 'opl-updates', order: SETTINGS_ORDER['opl-updates'], label: '更新' },
      { id: 'bili', order: 100, label: () => 'bili设置' },
    ]
    for (const section of initialSections) {
      core.register({ name: 'settings.section', ...section } as never, () => null)
    }

    let disposeNormalization!: () => void
    const host = await ctx.plugin({
      name: 'normalizer',
      inject: ['slots'],
      apply(provider: Context) {
        disposeNormalization = installSettingsSectionTitleNormalization(provider)
      },
    })

    const initialVersion = core.getVersion('settings.section')
    const biliBeforeDisposal = core
      .entries('settings.section')
      .find((entry) => entry.options.id === 'bili')!
    const ofmBeforeDisposal = core
      .entries('settings.section')
      .find((entry) => entry.options.id === 'our-free-model')!
    expect(resolveSlotLabel(biliBeforeDisposal.options.label)).toBe('Billion Context')
    expect(biliBeforeDisposal.options.order).toBe(1010)
    expect(ofmBeforeDisposal.options.order).toBe(1000)

    core.register(
      { name: 'settings.section', id: 'third-party-demo', order: 5, label: () => 'demo设置' },
      () => null,
    )
    await Promise.resolve()

    expect(core.getVersion('settings.section')).toBeGreaterThan(initialVersion)
    const sortedIds = core
      .entries('settings.section')
      .map((entry) => ({
        id: entry.options.id,
        order: entry.options.order ?? 0,
        label: resolveSlotLabel(entry.options.label),
      }))
      .sort((a, b) => a.order - b.order)
    expect(sortedIds.map((item) => item.id)).toEqual([
      'general',
      'models',
      'opl-gateway',
      'plugins',
      'agent-presets',
      'remote-connection',
      'opl-execution',
      'opl-updates',
      'our-free-model',
      'third-party-demo',
      'bili',
    ])
    const demoEntry = core
      .entries('settings.section')
      .find((entry) => entry.options.id === 'third-party-demo')!
    expect(resolveSlotLabel(demoEntry.options.label)).toBe('Demo')
    expect(demoEntry.options.order).toBe(1005)
    const generalEntry = core
      .entries('settings.section')
      .find((entry) => entry.options.id === 'general')!
    expect(resolveSlotLabel(generalEntry.options.label)).toBe('通用设置')
    expect(generalEntry.options.order).toBe(0)

    disposeNormalization()
    await host.dispose()
    expect(resolveSlotLabel(biliBeforeDisposal.options.label)).toBe('bili设置')
    expect(biliBeforeDisposal.options.order).toBe(100)
    expect(ofmBeforeDisposal.options.order).toBe(35)
    expect(resolveSlotLabel(demoEntry.options.label)).toBe('demo设置')
    expect(demoEntry.options.order).toBe(5)
  })
})
