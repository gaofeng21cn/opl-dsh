import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ExternalModelSources } from '../../src/execution/host/model-sources.ts'

const owner = { effect: (effect: () => () => void) => effect() } as unknown as Context
const ref = { provider: 'our-free-model', model: 'exact-model' }
const route = {
  baseURL: 'http://127.0.0.1:32123/v1',
  model: ref.model,
  apiKey: 'fixture-only',
  protocol: 'chat' as const,
}
function fixture() {
  const sources = new ExternalModelSources({} as Context)
  let supported = true
  const source = {
    provider: ref.provider,
    supports: (_harness: string, model: typeof ref) => supported && model.model === ref.model,
    resolve: async () => route,
  }
  const remove = sources.register(owner, source)
  return {
    sources,
    source,
    remove,
    withdraw: () => {
      supported = false
    },
  }
}

it('keeps a lease valid through preparation while its owner and pairing remain', async () => {
  const { sources } = fixture()
  const lease = sources.lease('pool', ref)
  expect(await sources.resolve('pool', ref, 'chat')).toEqual(route)
  expect(() => lease.assertCurrent()).not.toThrow()
})

it('rejects source removal after route resolution', async () => {
  const { sources, remove } = fixture()
  const lease = sources.lease('pool', ref)
  await sources.resolve('pool', ref, 'chat')
  remove()
  expect(() => lease.assertCurrent()).toThrow('已变更')
})

it('rejects re-registration of the same source object and preserves its new owner', () => {
  const { sources, source, remove } = fixture()
  const lease = sources.lease('pool', ref)
  remove()
  sources.register(owner, source)
  remove()
  expect(sources.supports('pool', ref)).toBe(true)
  expect(() => lease.assertCurrent()).toThrow('已变更')
})

it('rejects a pairing withdrawn during preparation', () => {
  const { sources, withdraw } = fixture()
  const lease = sources.lease('pool', ref)
  withdraw()
  expect(() => lease.assertCurrent()).toThrow('已变更')
})

it('retains the original model identity when the caller changes its reference', () => {
  const { sources } = fixture()
  const mutable = { ...ref }
  const lease = sources.lease('pool', mutable)
  mutable.model = 'different-model'
  expect(() => lease.assertCurrent()).not.toThrow()
})

it('requires an explicit supported registration before capturing a lease', () => {
  const { sources } = fixture()
  expect(() => sources.lease('pool', { ...ref, provider: 'unregistered' })).toThrow('尚未适配')
  expect(() => sources.lease('pool', { ...ref, model: 'unassigned' })).toThrow('尚未适配')
})

it('rejects source re-registration during an awaited route read', async () => {
  const sources = new ExternalModelSources({} as Context)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const source = {
    provider: ref.provider,
    supports: () => true,
    resolve: async () => {
      await pending
      return route
    },
  }
  const remove = sources.register(owner, source)
  const reading = sources.resolve('pool', ref, 'chat')
  remove()
  sources.register(owner, source)
  release()
  await expect(reading).rejects.toThrow('已变更')
})
