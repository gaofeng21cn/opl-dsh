import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, vi } from 'vitest'

const ready = vi.hoisted(() => ({ registered: false }))

vi.mock('../../src/gateway/host/index.ts', () => ({
  name: 'fixture',
  inject: [],
  Config: undefined,
  apply() {},
}))
vi.mock('../../src/shell/host/git-bash.ts', () => ({
  name: 'fixture',
  inject: [],
  Config: undefined,
  apply() {},
}))
vi.mock('../../src/conversation-stats/host/index.ts', () => ({
  name: 'fixture',
  inject: [],
  Config: undefined,
  apply() {},
}))
vi.mock('../../src/gateway/host/model-service.ts', () => ({ GatewayModelsService() {} }))
vi.mock('../../src/gateway/host/model-catalog.ts', () => ({
  installGatewayModelCatalogProjection: () => () => {},
}))
vi.mock('../../src/setup/host/index.ts', () => ({ SetupService() {} }))
vi.mock('../../src/updates/host/index.ts', () => ({ UpdateService() {} }))
vi.mock('../../src/updates/host/runtime-admission.ts', () => ({
  installUpdateRuntime: () => ({}),
}))
vi.mock('../../src/shared/host/suite-control.ts', () => ({
  name: 'control-fixture',
  inject: [],
  Config: undefined,
  apply(ctx: Context) {
    ctx.provide('qualificationControlReady', true)
  },
}))
vi.mock('../../src/execution/host/adapters/minimax-models.ts', () => ({
  createMiniMaxCodeModelRegistration: () => () => {},
}))
vi.mock('../../src/suite/execution.ts', () => ({
  name: 'execution-fixture',
  inject: [],
  Config: undefined,
  apply(ctx: Context) {
    ctx.provide('oplHarness', {
      configureMiniMaxCodeIntegration() {},
      synchronizeMiniMaxCodeIntegration: async () => {},
    })
  },
}))
vi.mock('../../src/collaboration/host/settings-service.ts', () => ({ CoordinationService() {} }))
vi.mock('../../src/collaboration/host/roles.ts', () => ({ RoleExecutionService() {} }))
vi.mock('../../src/collaboration/host/feedback/index.ts', () => ({ default() {} }))
vi.mock('../../src/collaboration/host/official-tools.ts', () => ({
  OfficialCollaborationBridge: class {},
}))
vi.mock('../../src/collaboration/host/tools.ts', () => ({ installCollaborationTools() {} }))
vi.mock('../../src/collaboration/host/external-codex.ts', () => ({ installExternalCodex() {} }))
vi.mock('../../src/collaboration/host/domain-agent-presets.ts', () => ({
  DomainAgentPresetService() {
    ready.registered = true
  },
}))

import * as suite from '../../src/suite/host.ts'

describe('Unified suite startup under Cordis Loader', () => {
  it('publishes control and wires execution and collaboration without deadlocks', async () => {
    const ctx = new Context()
    ready.registered = false
    await ctx.plugin(Loader)
    for (const name of suite.inject) {
      if (name === 'loader') continue
      ctx.provide(name, name === 'settings' ? { configure: () => () => {} } : {})
    }
    ctx.loader.builtins['qualification-suite'] = suite
    try {
      const starting = ctx.loader.create({
        id: 'opl-suite',
        name: 'cordis:qualification-suite',
        config: {},
      })
      await vi.waitFor(() => expect(ctx.get('qualificationControlReady')).toBe(true), {
        timeout: 1000,
      })
      await starting
      await ctx.loader.await()
      await vi.waitFor(() => expect(ready.registered).toBe(true))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
