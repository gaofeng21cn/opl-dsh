/**
 * The source composes with the shared registration lease: an adapter captures a
 * lease before its own preflight and asserts it after the final await, and this
 * source keeps refusing on its own side of the boundary.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import { OFM_PROVIDER, applyOfmModelSource } from '../../../src/execution/host/ofm-source/index.ts'

const ref = { provider: OFM_PROVIDER, model: 'mimo-v2.6-flash-free' }
const facts = { baseURL: 'http://127.0.0.1:32123/v1', apiKey: 'fixture-only' }

function context() {
  const ctx = {
    effect: (e: () => () => void) => e(),
    llm: {
      listProviders: () => [{ id: OFM_PROVIDER }],
      listModels: async () => [{ id: ref.model }],
      resolveModelInfo: async () => ({ provider: ref.provider, id: ref.model }),
    },
  } as unknown as Context
  ctx.oplExternalModelSources = new ExternalModelSources(ctx)
  return ctx
}

describe('lease composition', () => {
  it('grants a lease for a pairing this source declares', () => {
    const ctx = context()
    applyOfmModelSource(ctx, { connection: async () => facts })
    const lease = ctx.oplExternalModelSources.lease('mimo', ref)
    expect(() => lease.assertCurrent()).not.toThrow()
  })

  it('refuses a lease for a pairing this source does not declare', () => {
    const ctx = context()
    applyOfmModelSource(ctx, { connection: async () => facts })
    expect(() => ctx.oplExternalModelSources.lease('grok', ref)).toThrow()
  })

  it('fails the lease once the owner unloads mid-preflight', () => {
    const ctx = context()
    const remove = applyOfmModelSource(ctx, { connection: async () => facts })
    const lease = ctx.oplExternalModelSources.lease('mimo', ref)
    remove()
    expect(() => lease.assertCurrent()).toThrow('模型来源已变更')
  })

  it('fails the lease when the declared pairing is withdrawn', () => {
    const ctx = context()
    applyOfmModelSource(ctx, { connection: async () => facts })
    const lease = ctx.oplExternalModelSources.lease('mimo', ref)
    ctx.llm.listProviders = () => []
    expect(() => lease.assertCurrent()).toThrow('模型来源已变更')
  })

  it('resolves a live route end to end over the registered source', async () => {
    const ctx = context()
    applyOfmModelSource(ctx, { connection: async () => facts })
    await expect(ctx.oplExternalModelSources.resolve('mimo', ref, 'chat')).resolves.toEqual({
      ...facts,
      model: ref.model,
      protocol: 'chat',
    })
  })
})
