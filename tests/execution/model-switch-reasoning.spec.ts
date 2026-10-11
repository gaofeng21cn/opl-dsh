import { harnessAdapters } from '../../src/execution/host/adapters/index.ts'
import * as harnessRegistry from '../../src/execution/host/harness-registry.ts'
import { beforeEach } from 'vitest'
/** Exercise the model picker through its Host entry point and the official Session selection log. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import { HarnessService } from '../../src/execution/host/harness.ts'
import { adapterFor } from '../../src/execution/host/adapters/index.ts'

const provider = 'minimax-official'
const flash = 'MiniMax-M3.1-Flash-Preview'
const m3 = 'MiniMax-M3'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.restoreAllMocks()
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'opl-model-switch-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const session = Session.create(SessionId('session-model-switch'), [], {
    version: SESSION_FORMAT_VERSION,
    id: SessionId('session-model-switch'),
    createdAt: Date.now(),
    isSeeded: false,
    cwd: root,
  })
  const models = [
    {
      id: flash,
      name: flash,
      reasoning: {
        defaultEffort: 'max',
        efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({
          id,
          name: id,
        })),
      },
    },
    {
      id: m3,
      name: m3,
      reasoning: { defaultEffort: 'on', efforts: ['on', 'off'].map((id) => ({ id, name: id })) },
    },
    { id: 'plain', name: 'No reasoning' },
    {
      id: 'optional',
      name: 'Provider default',
      reasoning: { efforts: [{ id: 'high', name: 'High' }] },
    },
  ]
  const groups: ModelCatalog['groups'] = [
    { id: provider, name: 'MiniMax', models: models.slice(0, 2) },
    { id: 'other-channel', name: 'Other channel', models: [models[0]!, ...models.slice(2)] },
  ]
  const defaultSelection = { provider, model: flash, reasoningEffort: 'max' }
  const current = () =>
    session.snapshotEvents().findLast((event) => event.type === 'model/selection')
  // The official controller validates and normalizes the model-specific catalogue
  // before logging a selection. This fixture models that wire boundary only;
  // the Host picker, exact-model lookup and Session log are real.
  const select = vi.fn(async (request: ModelSelection) => {
    const info = groups
      .find((group) => group.id === request.provider)
      ?.models.find((model) => model.id === request.model)
    if (!info) throw Error('Unknown model')
    if (
      request.reasoningEffort !== undefined &&
      !info.reasoning?.efforts.some((e) => e.id === request.reasoningEffort)
    )
      throw Error('Unsupported reasoning effort')
    const effort = request.reasoningEffort ?? info.reasoning?.defaultEffort
    const selected = {
      provider: request.provider,
      model: request.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }
    session.append('model/selection', selected)
    return { selected }
  })
  const ctx = {
    get: () => undefined,
    agents: { get: () => undefined },
    sessions: { get: () => session },
    llm: {
      listProviders: () => groups.map((g) => ({ id: g.id, name: g.name })),
      listConfigurableProviders: () => [],
      listModels: async (id: string) => groups.find((g) => g.id === id)!.models,
    },
    sessionProjections: {
      snapshot: () => {
        const event = current()
        return {
          values: {
            modelSelection: {
              next: event?.type === 'model/selection' ? event.data : null,
              lastUsed: null,
            },
          },
        }
      },
    },
    typertGateway: {
      invoke: async ({ method, args }: { method: string; args?: { request: ModelSelection } }) => {
        if (method === 'modelCatalog') return { default: defaultSelection, groups }
        if (method === 'selectModel') return select(args!.request)
        throw Error('Unexpected method: ' + method)
      },
    },
  } as unknown as Context
  vi.spyOn(adapterFor('minimax-code', { provider, model: flash })!, 'available').mockResolvedValue({
    available: true,
  })
  const create = async () => {
    const service = new HarnessService(ctx, { home: root })
    cleanups.push(() => service.dispose())
    // No model request or CLI is started by a picker test.
    vi.spyOn(service, 'start').mockResolvedValue({ id: 'external-child' } as never)
    return service
  }
  const service = await create()
  const catalog = await service.executionCatalog()
  for (const g of groups)
    for (const model of g.models)
      if (!catalog.combinations.some((c) => c.id === g.id + '/' + model.id))
        catalog.combinations.push({
          id: g.id + '/' + model.id,
          name: model.name,
          modelRef: { provider: g.id, model: model.id },
          harnessRef: 'dsh',
          permissionPolicy: 'workspace',
          enabled: true,
          isDefault: false,
        })
  await service.saveExecutionCatalog(catalog)
  const choose = (model: string, svc = service, channel = provider, external = true) =>
    svc.selectCombination({
      sessionId: session.id,
      combination: external ? 'minimax-code/' + model : channel + '/' + model,
    })
  return { service, session, select, choose, create, groups, ctx }
}

describe('per-model reasoning in the conversation picker', () => {
  it('uses the Session log before the deployment default while its projection is cold', async () => {
    const { service, session, choose, ctx } = await setup()
    await choose(flash)
    await service.invoke('select-effort', {
      sessionId: session.id,
      provider,
      model: flash,
      reasoningEffort: 'high',
    })
    await choose(m3)
    vi.spyOn(ctx.sessionProjections, 'snapshot').mockReturnValue({
      values: { modelSelection: { next: null, lastUsed: null } },
    } as never)
    await choose(flash)
    expect(
      session.snapshotEvents().findLast((e) => e.type === 'model/selection')?.data,
    ).toMatchObject({ model: flash, reasoningEffort: 'high' })
  })
  it('switches max to thinking-on and remembers each model independently', async () => {
    const { service, session, choose } = await setup()
    await choose(flash)
    await choose(m3)
    expect((await service.modelSelection(session.id)).current).toMatchObject({
      model: m3,
      reasoningEffort: 'on',
    })
    await service.invoke('select-effort', {
      sessionId: session.id,
      provider,
      model: m3,
      reasoningEffort: 'off',
    })
    await choose(flash)
    expect((await service.modelSelection(session.id)).current).toMatchObject({
      model: flash,
      reasoningEffort: 'max',
    })
    await service.invoke('select-effort', {
      sessionId: session.id,
      provider,
      model: flash,
      reasoningEffort: 'high',
    })
    await choose(m3)
    expect((await service.modelSelection(session.id)).current).toMatchObject({
      model: m3,
      reasoningEffort: 'off',
    })
    await choose(flash)
    expect((await service.modelSelection(session.id)).current).toMatchObject({
      model: flash,
      reasoningEffort: 'high',
    })
  })

  it('retains explicit default across switches and a Host service restart', async () => {
    const { service, session, choose, create } = await setup()
    await choose(flash)
    await service.invoke('select-effort', {
      sessionId: session.id,
      provider,
      model: flash,
      reasoningEffort: 'default',
    })
    await choose(m3)
    await service.dispose()
    const restored = await create()
    await choose(flash, restored)
    expect((await restored.modelSelection(session.id)).current).toMatchObject({
      model: flash,
      reasoningEffort: 'default',
    })
  })

  it('drops all reasoning on a model that has no reasoning control', async () => {
    const { service, session, select, choose } = await setup()
    await choose(m3)
    await choose('plain', service, 'other-channel', false)
    expect(select.mock.calls.at(-1)?.[0]).not.toHaveProperty('reasoningEffort')
    expect((await service.modelSelection(session.id)).current).toEqual({
      provider: 'other-channel',
      model: 'plain',
    })
    await choose(m3)
    expect((await service.modelSelection(session.id)).current).toMatchObject({
      reasoningEffort: 'on',
    })
  })

  it('keeps identical model names in different channels independent', async () => {
    const { service, session, choose } = await setup()
    await choose(flash)
    await service.invoke('select-effort', {
      sessionId: session.id,
      provider,
      model: flash,
      reasoningEffort: 'low',
    })
    await choose(flash, service, 'other-channel', false)
    expect((await service.modelSelection(session.id)).current).toEqual({
      provider: 'other-channel',
      model: flash,
      reasoningEffort: 'max',
    })
    await choose(flash)
    expect((await service.modelSelection(session.id)).current).toMatchObject({
      provider,
      reasoningEffort: 'low',
    })
  })

  it('uses the live model default when its remembered effort was retired', async () => {
    const { service, session, choose, groups } = await setup()
    await choose(flash)
    await service.invoke('select-effort', {
      sessionId: session.id,
      provider,
      model: flash,
      reasoningEffort: 'high',
    })
    await choose(m3)
    const info = groups[0]!.models[0]!.reasoning!
    const remaining = info.efforts.filter((e) => e.id !== 'high')
    ;(info as { efforts: typeof remaining }).efforts = remaining
    await choose(flash)
    expect((await service.modelSelection(session.id)).current).toMatchObject({
      reasoningEffort: 'max',
    })
  })

  it('preserves the provider-default option when no default effort is declared', async () => {
    const { service, session, select, choose } = await setup()
    await choose('optional', service, 'other-channel', false)
    expect(select.mock.calls.at(-1)?.[0]).not.toHaveProperty('reasoningEffort')
    await choose(m3)
    await choose('optional', service, 'other-channel', false)
    expect((await service.modelSelection(session.id)).current).toEqual({
      provider: 'other-channel',
      model: 'optional',
    })
  })
})

// These suites exercise other harnesses; their catalog must not probe a personal ZCode install.
beforeEach(() => {
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
