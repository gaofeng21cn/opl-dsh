import { modelRefKey } from '../contracts/catalog.ts'
import type {
  CombinationDefinition,
  CombinationPermissionPolicy,
  ExecutionCatalog,
} from '../contracts/catalog.ts'

import { isOfficialPairing } from '../contracts/official-harnesses.ts'

export const isDisabledManualAlternative = (row: CombinationDefinition) =>
  !row.enabled &&
  ((row.harnessRef === 'opencode' && isOfficialPairing('antigravity', row.modelRef)) ||
    (row.harnessRef === 'pi' && isOfficialPairing('qwen-code', row.modelRef)))

type Pairing = Pick<CombinationDefinition, 'modelRef' | 'harnessRef'>

/** Visible choices and saved ids explicitly cleared by a bulk action. */
export interface CombinationSelection {
  selected: ReadonlySet<string>
  disabledIds: ReadonlySet<string>
}

/** Exact source/model and Harness identity for a suggested pairing. */
export const pairingKey = (item: Pairing): string =>
  JSON.stringify([modelRefKey(item.modelRef), item.harnessRef])

/** Saved configurations keep independent selection, including duplicate pairings. */
export const savedChoiceKey = (id: string): string => JSON.stringify(['saved', id])

/** New recommendations have a stable key before a configuration id exists. */
export const recommendationChoiceKey = (item: Pairing): string =>
  JSON.stringify(['recommended', pairingKey(item)])

export const COMBINATION_PERMISSION_LABELS: Readonly<Record<CombinationPermissionPolicy, string>> =
  {
    'read-only': '仅可查看',
    workspace: '工作区内修改',
    'full-access': '完全权限',
  }

/** Resolve the Host-advertised permissions, retaining the older workspace default. */
export function pairingPermissionPolicies(
  catalog: ExecutionCatalog,
  modelKey: string,
  harnessRef: string,
): CombinationPermissionPolicy[] {
  const pairing = catalog.supportedPairings?.find((item) => modelRefKey(item.modelRef) === modelKey)
  if (!pairing?.permissionPolicies) return ['workspace']
  return pairing.permissionPolicies[harnessRef] ?? []
}

/** Prefer the least permissive familiar preset the adapter can actually honour. */
export function defaultPermissionPolicy(
  policies: readonly CombinationPermissionPolicy[],
): CombinationPermissionPolicy | undefined {
  const priority = ['workspace', 'read-only', 'full-access'] as const
  return priority.find((policy) => policies.includes(policy))
}

/** Available saved configurations plus recommendations without a saved pairing. */
export function combinationChoices(catalog: ExecutionCatalog) {
  const available = new Set(
    catalog.models.filter((item) => item.available).map((item) => modelRefKey(item.ref)),
  )
  const existing = new Set(catalog.combinations.map(pairingKey))
  const recommendations = new Map(
    (catalog.recommendations ?? [])
      .filter((item) => !existing.has(pairingKey(item)))
      .map((item) => [pairingKey(item), item]),
  )
  return [
    ...catalog.combinations
      .filter(
        (item) => !isDisabledManualAlternative(item) && available.has(modelRefKey(item.modelRef)),
      )
      .map((item) => ({
        ...item,
        key: savedChoiceKey(item.id),
      })),
    ...[...recommendations.values()]
      .filter((item) => available.has(modelRefKey(item.modelRef)))
      .map((item) => ({
        ...item,
        key: recommendationChoiceKey(item),
        enabled: false,
      })),
  ]
}
