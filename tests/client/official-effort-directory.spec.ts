import { expect, it, vi } from 'vitest'
import { installEffortDirectories } from '../../src/execution/client/official-effort-directory.ts'

it('renders the active harness advertisement and writes the choice through the owning harness', async () => {
  const current = { provider: 'our-free-model', model: 'example' }
  const groups = [
    {
      id: current.provider,
      models: [
        {
          id: current.model,
          reasoning: { efforts: [{ id: 'balanced', name: 'Balanced' }], defaultEffort: 'balanced' },
        },
      ],
    },
  ]
  const state = { current, groups }
  const source = {
    store: { getSnapshot: () => state, subscribe: () => () => {} },
    load: async () => state,
    select: vi.fn(),
  }
  const owner = { directoryFor: (_: string) => source } as unknown as Parameters<
    typeof installEffortDirectories
  >[0]
  let levels = ['low', 'high']
  let selected = 'low'
  let unavailable = true
  const call = vi.fn(async (method, input) => {
    if (method === 'model-selection')
      return {
        current: { ...current, reasoningEffort: selected },
        groups,
        combination: 'combo',
        effortSource: 'harness',
      }
    if (method === 'select-effort') {
      selected = input.reasoningEffort
      return
    }
    if (unavailable) return { status: 'unavailable', efforts: [] }
    return {
      status: 'known',
      efforts: levels.map((id) => ({ id, name: id })),
      currentEffort: selected,
    }
  })
  const changes = new EventTarget()
  const restore = installEffortDirectories(
    owner,
    call as Parameters<typeof installEffortDirectories>[1],
    changes,
  )
  try {
    const directory = owner.directoryFor('s')
    let updated!: () => void
    const settled = new Promise<void>((resolve) => {
      updated = resolve
    })
    const unsubscribe = directory.store.subscribe(() => updated())
    const info = () => directory.store.getSnapshot().groups[0]!.models[0]!.reasoning
    expect(info()).toBeUndefined()
    await directory.load()
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith('reasoning-preflight', {
        sessionId: 's',
        combination: 'combo',
      }),
    )
    await settled
    unavailable = false
    await directory.load()
    await vi.waitFor(() => expect(info()?.efforts.map((e) => e.id)).toEqual(levels))
    await directory.select({ ...current, reasoningEffort: 'high' } as Parameters<
      typeof directory.select
    >[0])
    expect(directory.store.getSnapshot().current?.reasoningEffort).toBe('high')
    expect(source.select).not.toHaveBeenCalled()
    levels = ['on']
    changes.dispatchEvent(new Event('s'))
    await vi.waitFor(() => expect(info()).toBeUndefined())
    unsubscribe()
  } finally {
    restore()
  }
})

it('shows registered Gemini tiers before ACP responds and reuses only confirmed tiers across sessions', async () => {
  const ref = { provider: 'opl-gateway', model: 'gemini::gemini-4-carbon' }
  const state = { current: ref, groups: [{ id: ref.provider, models: [{ id: ref.model }] }] }
  const source = () => ({
    store: { getSnapshot: () => state, subscribe: () => () => {} },
    load: async () => state,
    select: vi.fn(),
  })
  const directories = [source(), source()]
  const owner = { directoryFor: (id: string) => directories[Number(id)] } as unknown as Parameters<
    typeof installEffortDirectories
  >[0]
  let resolve!: (value: unknown) => void
  const probe = vi.fn(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  const call = vi.fn(async (method: string, args: { sessionId: string }) =>
    method === 'reasoning-preflight'
      ? probe()
      : {
          current: { ...ref, reasoningEffort: args.sessionId === '1' ? 'low' : 'high' },
          groups: state.groups,
          effortSource: 'harness',
          combination: 'agy-carbon',
          registeredEfforts: {
            levels: ['low', 'medium', 'high'],
            defaultEffort: 'high',
            revision: 1,
          },
        },
  )
  const dispose = installEffortDirectories(
    owner,
    call as Parameters<typeof installEffortDirectories>[1],
    new EventTarget(),
  )
  try {
    const a = owner.directoryFor('0'),
      b = owner.directoryFor('1')
    const levels = () =>
      a.store.getSnapshot().groups[0]!.models[0]!.reasoning?.efforts.map((x) => x.id)
    await a.load()
    expect(levels()).toEqual(['low', 'medium', 'high'])
    resolve({
      status: 'known',
      efforts: ['low', 'high'].map((id) => ({ id, name: id })),
      currentEffort: 'high',
    })
    await vi.waitFor(() => expect(levels()).toEqual(['low', 'high']))
    await b.load()
    expect(b.store.getSnapshot().current?.reasoningEffort).toBe('low')
    expect(probe).toHaveBeenCalledTimes(1)
  } finally {
    dispose()
  }
})

it('waits for the official picker write before sending in that session', async () => {
  const { PendingCombination } = await import('../../src/execution/client/pending-combination.ts')
  const gate = new PendingCombination()
  const write = Promise.withResolvers<void>()
  const state = { current: { provider: 'opl-gateway', model: 'old' }, groups: [] }
  const source = {
    store: { getSnapshot: () => state, subscribe: () => () => {} },
    load: async () => state,
    async select(selection: typeof state.current) {
      await write.promise
      state.current = selection
    },
  }
  const owner = { directoryFor: () => source } as unknown as Parameters<
    typeof installEffortDirectories
  >[0]
  const restore = installEffortDirectories(owner, vi.fn(), new EventTarget(), gate)
  try {
    const directory = owner.directoryFor('a')
    const selection = directory.select({ provider: 'opl-gateway', model: 'new' } as Parameters<
      typeof directory.select
    >[0])
    const submit = vi.fn(async () => state.current.model)
    const first = gate.send('a', undefined, submit)
    expect(await gate.send('b', undefined, async () => 'other')).toBe('other')
    expect(submit).not.toHaveBeenCalled()
    write.resolve()
    await selection
    expect(await first).toBe('new')
    expect(submit).toHaveBeenCalledTimes(1)
  } finally {
    restore()
  }
})
