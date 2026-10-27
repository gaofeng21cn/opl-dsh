import { modelRefKey } from '../contracts/catalog.ts'
import type { CombinationDefinition, ExecutionCatalog } from '../contracts/catalog.ts'

type Pairing = Pick<CombinationDefinition, 'modelRef' | 'harnessRef'>

/** Exact source/model and Harness identity for a suggested pairing. */
export const pairingKey = (item: Pairing): string =>
  JSON.stringify([modelRefKey(item.modelRef), item.harnessRef])

/** Saved configurations keep independent selection, including duplicate pairings. */
export const savedChoiceKey = (id: string): string => JSON.stringify(['saved', id])

/** New recommendations have a stable key before a configuration id exists. */
export const recommendationChoiceKey = (item: Pairing): string =>
  JSON.stringify(['recommended', pairingKey(item)])

/** All saved configurations plus recommendations without a saved pairing. */
export function combinationChoices(catalog: ExecutionCatalog) {
  const availableSaved = catalog.combinations.filter((item) => {
    const model = catalog.models.find(
      (candidate) => modelRefKey(candidate.ref) === modelRefKey(item.modelRef),
    )
    return model?.available !== false
  })
  const existing = new Set(availableSaved.map(pairingKey))
  const recommendations = new Map(
    (catalog.recommendations ?? [])
      .filter((item) => !existing.has(pairingKey(item)))
      .map((item) => [pairingKey(item), item]),
  )
  return [
    ...availableSaved.map((item) => ({
      ...item,
      key: savedChoiceKey(item.id),
    })),
    ...[...recommendations.values()].map((item) => ({
      ...item,
      key: recommendationChoiceKey(item),
      enabled: false,
    })),
  ]
}
