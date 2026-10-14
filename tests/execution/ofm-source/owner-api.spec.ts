/**
 * Behavioural evidence for the owner-API connection reader, over a dummy
 * isolated fixture shaped like the plugin's public `/clients` response.
 *
 * The reader is injected into the source with no adapter or cast, so this also
 * proves the two published signatures compose as a product surface.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { fixtureCaller } from './owner-api-fixture.ts'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import {
  OFM_CLIENTS_ROUTE,
  OFM_PROVIDER,
  createOfmApiConnection,
  createOfmModelSource,
  ofmBaseURL,
} from '../../../src/execution/host/ofm-source/index.ts'

const base = 'http://127.0.0.1:7777'
const ref = { provider: OFM_PROVIDER, model: 'mimo-v2.6-flash-free' }

function catalogContext() {
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

describe('owner API connection reader', () => {
  it('injects into a source with no cast and yields a launchable route', async () => {
    const fixture = fixtureCaller()
    const ctx = catalogContext()
    // No `as any` at the injection site: the reader's published signature is the
    // source's published signature.
    const connection = createOfmApiConnection(fixture.caller, base)
    const source = createOfmModelSource(ctx, { connection })
    await expect(source.resolve('mimo', ref)).resolves.toEqual({
      baseURL: 'http://127.0.0.1:32123/v1',
      model: ref.model,
      apiKey: 'ofm-fixture-key-aaaaaaaaaaaaaaaaaaaaaaaa',
      protocol: 'chat',
    })
    expect(fixture.calls).toEqual([{ url: base + OFM_CLIENTS_ROUTE, method: 'GET' }])
  })

  it('uses the published OpenAI-compatible v1 base for chat and responses', () => {
    expect(ofmBaseURL('http://127.0.0.1:32123', 'chat')).toBe('http://127.0.0.1:32123/v1')
    expect(ofmBaseURL('http://127.0.0.1:32123', 'responses')).toBe('http://127.0.0.1:32123/v1')
  })

  it('uses the published Anthropic origin for messages, without a v1 suffix', () => {
    expect(ofmBaseURL('http://127.0.0.1:32123', 'messages')).toBe('http://127.0.0.1:32123')
  })

  it('composes the base from the origin rather than parsing the recipe text', async () => {
    const fixture = fixtureCaller()
    const connection = createOfmApiConnection(fixture.caller, base)
    // The response carries real snippet bodies; only the published origin and the
    // requested protocol decide the result.
    const facts = await connection('claude', ref, 'messages')
    expect(facts?.baseURL).toBe('http://127.0.0.1:32123')
    expect(String(facts)).not.toContain('ANTHROPIC_BASE_URL')
  })

  it('refuses an admission rejection instead of retrying another route', async () => {
    const fixture = fixtureCaller({ status: 401 })
    const connection = createOfmApiConnection(fixture.caller, base)
    expect(await connection('mimo', ref, 'chat')).toBeUndefined()
    expect(fixture.calls).toHaveLength(1)
  })

  it('refuses a stopped lane and never returns its placeholder origin', async () => {
    const fixture = fixtureCaller()
    fixture.stop()
    const connection = createOfmApiConnection(fixture.caller, base)
    const facts = await connection('mimo', ref, 'chat')
    expect(facts).toBeUndefined()
    expect(String(facts)).not.toContain('<forward-port>')
  })

  it('refuses a placeholder key presented as a real one', async () => {
    const connection = createOfmApiConnection(fixtureCaller({ key: '<forward-key>' }).caller, base)
    expect(await connection('mimo', ref, 'chat')).toBeUndefined()
  })

  it('follows a rotated issued key rather than caching the previous one', async () => {
    const fixture = fixtureCaller()
    const connection = createOfmApiConnection(fixture.caller, base)
    expect((await connection('mimo', ref, 'chat'))?.apiKey).toContain('aaaa')
    fixture.rotate()
    expect((await connection('mimo', ref, 'chat'))?.apiKey).toContain('bbbb')
  })

  it('refuses a model the same response no longer advertises', async () => {
    const fixture = fixtureCaller()
    const connection = createOfmApiConnection(fixture.caller, base)
    expect(await connection('mimo', ref, 'chat')).toBeDefined()
    fixture.withdraw(ref.model)
    expect(await connection('mimo', ref, 'chat')).toBeUndefined()
  })

  it('never returns a key for a placeholder or out-of-range port', async () => {
    for (const port of ['<forward-port>', '0', 'notaport', '70000']) {
      const connection = createOfmApiConnection(fixtureCaller({ port }).caller, base)
      expect(await connection('mimo', ref, 'chat')).toBeUndefined()
    }
  })

  it('never places the issued key in a refusal', async () => {
    const fixture = fixtureCaller()
    fixture.stop()
    const connection = createOfmApiConnection(fixture.caller, base)
    const result = await connection('mimo', ref, 'chat')
    expect(String(result)).not.toContain('ofm-fixture-key')
  })
})
