import { Context, Service } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  gateway: 0,
  notifications: 0,
  executionConfigs: [] as Array<Record<string, unknown>>,
  collaborationMounts: 0,
  remotes: {} as Record<string, unknown>,
}))
vi.mock('../../src/shared/client/mount-remotes.ts', () => ({ mountRemotes: async () => {} }))
vi.mock('../../src/shared/client/remote-call.ts', () => ({
  optionalRemote: (_ctx: unknown, name: string) => state.remotes[name],
  remoteCall: (target: unknown) => target,
}))
vi.mock('../../src/gateway/client/index.tsx', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  apply: () => {
    state.gateway += 1
  },
}))
vi.mock('../../src/notifications/client/index.tsx', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  apply: () => {
    state.notifications += 1
  },
}))
vi.mock('../../src/setup/client/index.tsx', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  apply: () => {},
}))
vi.mock('../../src/conversation-stats/client/index.tsx', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  apply: () => {},
}))
vi.mock('../../src/window-title/client/index.tsx', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  apply: () => {},
}))
vi.mock('../../src/execution/client/index.tsx', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  apply: (_ctx: unknown, config: Record<string, unknown> = {}) => {
    state.executionConfigs.push(config)
  },
}))
vi.mock('../../src/collaboration/client/index.tsx', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  CoordinationSection: (props: Record<string, unknown>) => ({ props }),
  apply: () => {
    state.collaborationMounts += 1
  },
}))
vi.mock('../../src/updates/client/index.tsx', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  apply: () => {},
}))
vi.mock('../../src/opl-flow/client/index.tsx', () => ({
  name: undefined,
  inject: [],
  Config: undefined,
  apply: () => {},
}))
vi.mock('../../src/execution/client/EngineUpdates.tsx', () => ({
  EngineUpdates: () => null,
}))
vi.mock('../../src/shared/client/FeaturePreferences.tsx', () => ({
  SuiteFeaturePreferences: () => null,
  labels: {},
  SUITE_FEATURE_NAMESPACE: 'fixture.features',
}))
vi.mock('../../src/shell/client.tsx', () => ({
  NativeShellPreference: () => null,
  nativeShellLabels: {},
}))
import * as suite from '../../src/suite/client.tsx'

class StubService extends Service {
  constructor(ctx: Context, name: string, members: object = {}) {
    super(ctx, name)
    Object.assign(this, members)
  }
}

it('starts account and notification features before optional settings arrive and follows their lifetime', async () => {
  const ctx = new Context()
  const rows: { id?: string }[] = []
  let snapshot: { value?: { enhancedConversationStats: boolean } } = {}
  const listeners = new Set<() => void>()
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  try {
    await ctx.plugin({
      apply(provider: Context) {
        new StubService(provider, 'remote')
        new StubService(provider, 'locale', { register: () => () => {} })
        new StubService(provider, 'sessions')
        new StubService(provider, 'uiConversation')
        new StubService(provider, 'uiWorkspace')
        new StubService(provider, 'slots', {
          inject: (_name: string, install: () => unknown) => install(),
          register: (row: { id?: string }) => {
            rows.push(row)
            return provider.effect(() => () => {
              rows.splice(rows.indexOf(row), 1)
            })
          },
        })
      },
    })
    await ctx.plugin(suite)
    expect(state.gateway).toBe(1)
    expect(state.notifications).toBe(1)
    expect(rows).toHaveLength(0)
    const settings = await ctx.plugin({
      apply(provider: Context) {
        new StubService(provider, 'configForms', { get: () => form })
      },
    })
    await vi.waitFor(() =>
      expect(rows.filter((row) => row.id === 'opl-suite-feature-preferences')).toHaveLength(1),
    )
    await settings.dispose()
    expect(state.gateway).toBe(1)
    expect(state.notifications).toBe(1)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('embeds collaboration under execution settings instead of mounting a duplicate top-level section', async () => {
  state.executionConfigs.length = 0
  state.collaborationMounts = 0
  state.remotes = { oplExecution: { id: 'exec' }, oplCoordination: { id: 'coord' } }
  const ctx = new Context()
  try {
    await ctx.plugin({
      apply(provider: Context) {
        new StubService(provider, 'remote')
        new StubService(provider, 'locale', { register: () => () => {} })
        new StubService(provider, 'sessions')
        new StubService(provider, 'uiConversation')
        new StubService(provider, 'uiWorkspace')
        new StubService(provider, 'slots', { inject: () => () => {}, register: () => () => {} })
      },
    })
    await ctx.plugin(suite)
    expect(state.executionConfigs).toHaveLength(1)
    expect(typeof state.executionConfigs[0].renderCollaboration).toBe('function')
    expect(state.collaborationMounts).toBe(0)
    const rendered = (
      state.executionConfigs[0].renderCollaboration as () => { props: { embedded?: boolean } }
    )()
    expect(rendered.props.embedded).toBe(true)
  } finally {
    state.remotes = {}
    await ctx.fiber.dispose()
  }
})

it('keeps standalone collaboration settings mounted when execution service is absent', async () => {
  state.executionConfigs.length = 0
  state.collaborationMounts = 0
  state.remotes = { oplCoordination: { id: 'coord' } }
  const ctx = new Context()
  try {
    await ctx.plugin({
      apply(provider: Context) {
        new StubService(provider, 'remote')
        new StubService(provider, 'locale', { register: () => () => {} })
        new StubService(provider, 'sessions')
        new StubService(provider, 'uiConversation')
        new StubService(provider, 'uiWorkspace')
        new StubService(provider, 'slots', { inject: () => () => {}, register: () => () => {} })
      },
    })
    await ctx.plugin(suite)
    expect(state.executionConfigs).toHaveLength(0)
    expect(state.collaborationMounts).toBe(1)
  } finally {
    state.remotes = {}
    await ctx.fiber.dispose()
  }
})
