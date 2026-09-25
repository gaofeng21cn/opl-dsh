import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultExecutionCatalog, ExecutionCatalogStore, catalogView } from '../../src/coordination/catalog.ts'
const roots: string[] = []
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }) })

describe('execution catalog', () => {
  it('persists defaults and custom OpenAI-compatible models without secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-catalog-')); roots.push(root)
    const store = new ExecutionCatalogStore(root)
    const catalog = await store.get(); expect(catalog.combinations.find(x => x.isDefault)?.id).toBe('dsh/deepseek-flash')
    catalog.connections.push({ id: 'custom', name: 'Custom Gateway', kind: 'openai-compatible', endpoint: 'https://example.test/v1', authRef: 'CUSTOM_API_KEY' })
    catalog.models.push({ id: 'custom-model', name: 'Custom Model', modelId: 'custom-1', connectionId: 'custom', protocol: 'openai-completions' })
    const saved = await store.set(catalog); expect(saved.models.at(-1)?.modelId).toBe('custom-1')
    expect(await readFile(join(root, 'profiles/desktop/execution-catalog.json'), 'utf8')).not.toContain('sk-secret')
    await store.dispose()
  })
  it('rejects broken references and keeps the previous catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-catalog-')); roots.push(root)
    const store = new ExecutionCatalogStore(root); const before = await store.get()
    await expect(store.set({ ...before, combinations: [{ ...before.combinations[0], modelId: 'missing' }] })).rejects.toThrow('引用不存在')
    expect((await store.get()).models).toEqual(before.models); await store.dispose()
  })
  it('projects only enabled combinations and adapter availability', () => {
    const catalog = defaultExecutionCatalog(); catalog.combinations[1]!.enabled = false
    const view = catalogView(catalog, new Map([['dsh/deepseek-flash', { available: true }]]))
    expect(view).toHaveLength(1); expect(view[0]).toMatchObject({ name: 'DeepSeek + DSH', model: 'DeepSeek-V4.1-Flash' })
  })
})
