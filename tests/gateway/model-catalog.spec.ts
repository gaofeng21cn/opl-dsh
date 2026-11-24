import { expect, it } from 'vitest'
import { projectGatewayModelCatalog } from '../../src/gateway/host/model-catalog.ts'

it('collapses exact route aliases while preserving distinct channels, diagnostics and defaults', () => {
  const group = (id: string, ...ids: string[]) => ({
    id,
    name: id,
    models: ids.map((id) => ({ id, name: id })),
  })
  const catalog = {
    default: { provider: 'opl-gateway-openai', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
    groups: [
      group(
        'opl-gateway',
        'codex::gpt-6.1-sol',
        'aws::claude-opus-5-5',
        'kiro::claude-opus-5-5',
        'codex::codex-auto-review',
      ),
      group('opl-gateway-openai', 'gpt-6.1-sol', 'child-only'),
      group('opl-gateway-auto-review', 'codex-auto-review'),
      group('custom', 'gpt-6.1-sol'),
    ],
    routableProviders: ['opl-gateway', 'opl-gateway-openai', 'opl-gateway-auto-review', 'custom'],
    failures: [{ id: 'opl-gateway-gemini', name: 'Gemini', message: 'offline' }],
  }
  const result = projectGatewayModelCatalog(catalog)
  expect(result.groups.map((g) => g.id)).toEqual(['opl-gateway', 'opl-gateway-openai', 'custom'])
  expect(result.groups[1]?.models.map((m) => m.id)).toEqual(['child-only'])
  expect(result.groups[0]?.models.map((m) => m.name)).toEqual([
    'codex::gpt-6.1-sol',
    'Claude Opus 5.5 · AWS',
    'Claude Opus 5.5 · Kiro',
    'codex::codex-auto-review',
  ])
  expect(result.default).toEqual({
    provider: 'opl-gateway',
    model: 'codex::gpt-6.1-sol',
    reasoningEffort: 'high',
  })
  expect(result.failures).toEqual(catalog.failures)
  expect(result.routableProviders).toEqual(catalog.routableProviders)
  expect(
    projectGatewayModelCatalog({ ...catalog, groups: catalog.groups.slice(1) }).groups,
  ).toEqual(catalog.groups.slice(1))
})
