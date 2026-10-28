import { expect, it } from 'vitest'
import { combinationChoices } from '../../src/execution/client/combination-choices.ts'
import type { ExecutionCatalog } from '../../src/execution/contracts/catalog.ts'

it('omits unavailable saved models from the add-combination picker', () => {
  const catalog = {
    models: [
      {
        ref: { provider: 'our-free-model', model: 'available-model' },
        name: 'Available',
        source: 'OFM',
        available: true,
      },
      {
        ref: { provider: 'our-free-model', model: 'removed-model' },
        name: 'Removed',
        source: 'OFM',
        available: false,
      },
    ],
    combinations: [
      {
        id: 'available-route',
        name: 'Available + Kilo',
        modelRef: { provider: 'our-free-model', model: 'available-model' },
        harnessRef: 'kilo',
        permissionPolicy: 'workspace',
        isDefault: false,
        enabled: true,
      },
      {
        id: 'removed-route',
        name: 'Removed + Kilo',
        modelRef: { provider: 'our-free-model', model: 'removed-model' },
        harnessRef: 'kilo',
        permissionPolicy: 'workspace',
        isDefault: false,
        enabled: true,
      },
    ],
    recommendations: [],
  } as unknown as ExecutionCatalog

  expect(combinationChoices(catalog).map((item) => item.name)).toEqual(['Available + Kilo'])
})
