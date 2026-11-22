import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { HarnessService } from '../../src/execution/host/harness.ts'
import type { ExecutionCatalogStore } from '../../src/execution/host/catalog.ts'
import { DSH_COMBINATION } from '../../src/execution/contracts/sessions.ts'
import {
  MINIMAX_CODE_HARNESS,
  MINIMAX_CODE_PROVIDER,
} from '../../src/execution/host/adapters/minimax.ts'
import { adapterFor } from '../../src/execution/host/adapters/index.ts'
import { testPeerConnection } from '../test-peer.ts'

const cleanups: Array<() => Promise<unknown>> = []
async function cleanupFixtures() {
  while (cleanups.length) await cleanups.pop()!()
}
afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupFixtures()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opl-minimax-integration-'))
  let enabled = true
  const ctx = {
    connection: testPeerConnection,
    get: () => undefined,
    agents: { get: () => undefined, list: () => [] },
    sessions: { get: () => undefined, list: () => [] },
    waterfall: async (_event: string, _request: unknown, next: () => Promise<unknown>) => next(),
    logger: { warn: vi.fn() },
  } as unknown as Context
  const service = new HarnessService(ctx, {
    home: join(root, 'state'),
    minimaxCodeEnabled: () => enabled,
  })
  cleanups.push(
    () => rm(root, { recursive: true, force: true }),
    () => service.dispose(),
  )
  const adapter = adapterFor(MINIMAX_CODE_HARNESS, {
    provider: MINIMAX_CODE_PROVIDER,
    model: 'MiniMax-M3',
  })!
  vi.spyOn(adapter, 'available').mockResolvedValue({ available: true })
  const store = (service as unknown as { catalogStore: ExecutionCatalogStore }).catalogStore
  return {
    root,
    service,
    store,
    async setEnabled(value: boolean) {
      enabled = value
      await service.synchronizeMiniMaxCodeIntegration()
    },
  }
}

it('keeps fixture files available until service shutdown completes', async () => {
  const { root, service } = await fixture()
  const marker = join(root, 'shutdown-probe')
  await writeFile(marker, '')
  const dispose = service.dispose.bind(service)
  vi.spyOn(service, 'dispose').mockImplementation(async () => {
    await dispose()
    await access(marker)
  })

  await cleanupFixtures()
  await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('retains hidden rows through an unrelated catalog save and restores them on re-enable', async () => {
  const { service, store, setEnabled } = await fixture()
  const enabled = await service.executionCatalog()
  await service.saveExecutionCatalog(enabled)
  await store.set({
    ...enabled,
    combinations: [
      ...enabled.combinations,
      {
        id: 'saved-custom-mcode',
        name: 'Saved custom mcode',
        modelRef: { provider: 'opl-gateway', model: 'deepseek-flash' },
        harnessRef: MINIMAX_CODE_HARNESS,
        permissionPolicy: 'full-access',
        isDefault: false,
        enabled: true,
      },
    ],
  })

  await setEnabled(false)
  const hidden = await service.executionCatalog()
  expect(hidden.models.some((item) => item.ref.provider === MINIMAX_CODE_PROVIDER)).toBe(false)
  expect(hidden.combinations.some((item) => item.harnessRef === MINIMAX_CODE_HARNESS)).toBe(false)

  const ordinary = hidden.combinations.find((item) => item.id === DSH_COMBINATION)
  expect(ordinary).toBeDefined()
  await service.saveExecutionCatalog({
    ...hidden,
    combinations: hidden.combinations.map((item) =>
      item.id === ordinary!.id ? { ...item, name: 'Unrelated catalog edit' } : item,
    ),
  })
  const persisted = await store.get()
  expect(
    persisted.combinations.filter((item) => item.harnessRef === MINIMAX_CODE_HARNESS),
  ).toHaveLength(3)
  expect(persisted.combinations.find((item) => item.id === 'saved-custom-mcode')).toMatchObject({
    enabled: true,
    name: 'Saved custom mcode',
  })

  await setEnabled(true)
  const restored = await service.executionCatalog()
  expect(
    restored.combinations.filter((item) => item.harnessRef === MINIMAX_CODE_HARNESS),
  ).toHaveLength(3)
  expect(
    restored.models.filter((item) => item.ref.provider === MINIMAX_CODE_PROVIDER),
  ).toHaveLength(2)
})

it('rejects old combinations and native-source requests after opt-out without rerouting', async () => {
  const { root, service, store, setEnabled } = await fixture()
  const catalog = await service.executionCatalog()
  const combination = catalog.combinations.find(
    (item) => item.harnessRef === MINIMAX_CODE_HARNESS && item.enabled,
  )!
  const started = await service.start(
    {
      combination: combination.id,
      cwd: root,
      taskId: 'task-before-opt-out',
      origin: { kind: 'codex', sessionId: 'reviewer' },
      sandbox: 'full-access',
    },
    true,
  )

  await setEnabled(false)
  await expect(
    service.start(
      {
        existingSessionId: started.id,
        combination: combination.id,
        cwd: root,
        taskId: 'task-before-opt-out',
        origin: { kind: 'codex', sessionId: 'reviewer' },
        sandbox: 'full-access',
      },
      true,
    ),
  ).rejects.toThrow(/已停用/)
  await expect(
    service.prompt({ sessionId: started.id, text: 'must not run', operationId: 'after-opt-out' }),
  ).rejects.toThrow(/已停用/)

  const next = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {})())
  await expect(
    service
      .conversationStream(
        {
          provider: MINIMAX_CODE_PROVIDER,
          model: combination.modelRef.model,
          sessionId: 'old-native-session',
        } as GenerateOptions,
        next,
      )
      .next(),
  ).rejects.toThrow(/已停用/)

  await store.set({
    ...catalog,
    combinations: [
      ...catalog.combinations,
      {
        id: 'native-custom-mcode',
        name: 'Native custom mcode',
        modelRef: { provider: 'opl-gateway', model: 'deepseek-flash' },
        harnessRef: MINIMAX_CODE_HARNESS,
        permissionPolicy: 'full-access',
        isDefault: false,
        enabled: true,
      },
    ],
  })
  ;(service as unknown as { selections: Record<string, string> }).selections['old-native-session'] =
    'native-custom-mcode'
  await expect(
    service
      .conversationStream(
        {
          provider: 'opl-gateway',
          model: 'deepseek-flash',
          sessionId: 'old-native-session',
        } as GenerateOptions,
        next,
      )
      .next(),
  ).rejects.toThrow(/已停用/)
  expect(next).not.toHaveBeenCalled()
})

it('preserves hidden rows when re-enabled while a disabled catalog save is awaited', async () => {
  const { service, store, setEnabled } = await fixture()
  const enabled = await service.executionCatalog()
  await store.set({
    ...enabled,
    combinations: [
      ...enabled.combinations,
      {
        id: 'saved-custom-mcode-race',
        name: 'Saved custom mcode race',
        modelRef: { provider: 'opl-gateway', model: 'deepseek-flash' },
        harnessRef: MINIMAX_CODE_HARNESS,
        permissionPolicy: 'full-access',
        isDefault: false,
        enabled: true,
      },
    ],
  })
  await setEnabled(false)
  const hidden = await service.executionCatalog()
  const originalGet = store.get.bind(store)
  const previous = Promise.withResolvers<Awaited<ReturnType<typeof originalGet>>>()
  const get = vi.spyOn(store, 'get').mockImplementationOnce(() => previous.promise)
  const saving = service.saveExecutionCatalog(hidden)
  await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
  await setEnabled(true)
  previous.resolve(await originalGet())
  await saving
  const persisted = await originalGet()
  expect(persisted.combinations.some((item) => item.id === 'saved-custom-mcode-race')).toBe(true)
})

it('retains custom mcode rows when a hidden view is saved after re-enabling', async () => {
  const { service, store, setEnabled } = await fixture()
  const enabled = await service.executionCatalog()
  await store.set({
    ...enabled,
    combinations: [
      ...enabled.combinations,
      {
        id: 'custom-mcode-hidden-view',
        name: 'My custom mcode',
        modelRef: { provider: 'opl-gateway', model: 'deepseek-flash' },
        harnessRef: MINIMAX_CODE_HARNESS,
        permissionPolicy: 'full-access',
        isDefault: false,
        enabled: true,
      },
    ],
  })

  await setEnabled(false)
  const hidden = await service.executionCatalog()
  expect(hidden.minimaxCodeEnabled).toBe(false)
  expect(hidden.combinations.some((item) => item.id === 'custom-mcode-hidden-view')).toBe(false)
  await setEnabled(true)
  const saved = await service.saveExecutionCatalog({
    ...hidden,
    combinations: hidden.combinations.map((item) =>
      item.id === DSH_COMBINATION ? { ...item, name: 'Changed while refreshing' } : item,
    ),
  })
  expect(saved.minimaxCodeEnabled).toBe(true)
  const persisted = await store.get()
  expect(
    persisted.combinations.find((item) => item.id === 'custom-mcode-hidden-view'),
  ).toMatchObject({
    name: 'My custom mcode',
    enabled: true,
    permissionPolicy: 'full-access',
  })
  expect(persisted.combinations.find((item) => item.id === DSH_COMBINATION)?.name).toBe(
    'Changed while refreshing',
  )
  expect(persisted.minimaxCodeEnabled).toBeUndefined()
})

it('allows an enabled view to remove a custom mcode row normally', async () => {
  const { service, store } = await fixture()
  const initial = await service.executionCatalog()
  await store.set({
    ...initial,
    combinations: [
      ...initial.combinations,
      {
        id: 'custom-mcode-visible-view',
        name: 'Remove this custom mcode',
        modelRef: { provider: 'opl-gateway', model: 'deepseek-flash' },
        harnessRef: MINIMAX_CODE_HARNESS,
        permissionPolicy: 'full-access',
        isDefault: false,
        enabled: true,
      },
    ],
  })
  const visible = await service.executionCatalog()
  expect(visible.minimaxCodeEnabled).toBe(true)
  expect(visible.combinations.some((item) => item.id === 'custom-mcode-visible-view')).toBe(true)
  await service.saveExecutionCatalog({
    ...visible,
    combinations: visible.combinations.filter((item) => item.id !== 'custom-mcode-visible-view'),
  })
  expect(
    (await store.get()).combinations.some((item) => item.id === 'custom-mcode-visible-view'),
  ).toBe(false)
})

it('rejects a hidden native mcode selection that is disabled during catalog waiting', async () => {
  const { service, store, setEnabled } = await fixture()
  const enabled = await service.executionCatalog()
  await store.set({
    ...enabled,
    combinations: [
      ...enabled.combinations,
      {
        id: 'native-custom-mcode-race',
        name: 'Native custom mcode race',
        modelRef: { provider: 'opl-gateway', model: 'deepseek-flash' },
        harnessRef: MINIMAX_CODE_HARNESS,
        permissionPolicy: 'full-access',
        isDefault: false,
        enabled: true,
      },
    ],
  })
  ;(service as unknown as { selections: Record<string, string> }).selections['native-race'] =
    'native-custom-mcode-race'
  const waiting = Promise.withResolvers<Awaited<ReturnType<typeof service.executionCatalog>>>()
  const originalCatalog = service.executionCatalog.bind(service)
  const read = vi.spyOn(service, 'executionCatalog').mockImplementationOnce(() => waiting.promise)
  const next = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {})())
  const streaming = service
    .conversationStream(
      {
        provider: 'opl-gateway',
        model: 'deepseek-flash',
        sessionId: 'native-race',
      } as GenerateOptions,
      next,
    )
    .next()
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
  await setEnabled(false)
  waiting.resolve(await originalCatalog())
  await expect(streaming).rejects.toThrow(/已停用/)
  expect(next).not.toHaveBeenCalled()
})

it('rechecks opt-out before a queued native prompt writes into the official Session', async () => {
  const { service, setEnabled } = await fixture()
  await setEnabled(false)
  const native = vi.spyOn(service as never as { native: ReturnType<typeof vi.fn> }, 'native')
  await (
    service as never as {
      runConversation: (...args: unknown[]) => Promise<void>
    }
  ).runConversation(
    {
      id: 'queued-native-mcode',
      nativeSessionId: 'native-queued',
      modelRef: { provider: MINIMAX_CODE_PROVIDER, model: 'MiniMax-M3' },
      harnessRef: MINIMAX_CODE_HARNESS,
    },
    { cancelled: false, turn: undefined },
    { operationId: 'queued-after-opt-out' },
  )
  expect(native).not.toHaveBeenCalled()
})

it('discards stale projections for every caller sharing a pending catalog read', async () => {
  const { service, setEnabled } = await fixture()
  const resolver = (
    service as unknown as {
      modelResolver: { resolve: () => ReturnType<ExecutionCatalogStore['get']> }
    }
  ).modelResolver
  const original = resolver.resolve.bind(resolver)
  const enabled = await original()
  const first = Promise.withResolvers<Awaited<ReturnType<typeof original>>>()
  const resolve = vi.spyOn(resolver, 'resolve').mockImplementationOnce(() => first.promise)
  const creator = service.executionCatalog()
  const attached = service.executionCatalog()
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce())
  await setEnabled(false)
  first.resolve(enabled)
  const projections = await Promise.all([creator, attached])
  for (const projected of projections) {
    expect(projected.combinations.some((item) => item.harnessRef === MINIMAX_CODE_HARNESS)).toBe(
      false,
    )
    expect(projected.models.some((item) => item.ref.provider === MINIMAX_CODE_PROVIDER)).toBe(false)
  }
  expect(resolve).toHaveBeenCalledTimes(2)
})
