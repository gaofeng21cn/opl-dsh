/** Picker policy for OFM lanes rejected by their required official client. */
import type { ModelRef } from '../../contracts/catalog.ts'
import { OFM_PROVIDERS, isExcludedOfmModel } from './provider.ts'

/** OFM lanes still absent or incomplete in the official OpenCode directory. */
export const OFM_CLIENT_REJECTED_MODELS: readonly string[] = [
  'muse-spark-1.2-contributor-free',
  'step-5-preview-free',
]

/** Hide only the named OFM lanes, without changing another provider's same-named model. */
export function isHiddenOfmSelection(ref: ModelRef): boolean {
  return (
    OFM_PROVIDERS.includes(ref.provider) &&
    (isExcludedOfmModel(ref.model) || OFM_CLIENT_REJECTED_MODELS.includes(ref.model))
  )
}

/** No default CLI setup when every supported lane is excluded from the picker. */
export const OFM_INACTIVE_DEFAULT_HARNESSES: readonly string[] = ['mimo-code', 'muse-code']

/** OFM-discovered identities explicitly routed through OpenCode's built-in free provider. */
export function officialOpenCodeModel(ref: ModelRef): string | undefined {
  if (ref.provider !== 'our-free-model') return undefined
  if (ref.model === 'nvidia/nemotron-3.5-super-vl:free')
    return 'opencode/nemotron-3.5-super-vl-free'
  return [
    'cat-jam-free',
    'mimo-v2.6-flash-free',
    'muse-spark-1.3-contributor-free',
    'nemotron-3.5-lightning-free',
    'longcat-2.5-preview-free',
    'deepseek-v4.1-flash-free',
    'space-bunny-free',
  ].includes(ref.model)
    ? 'opencode/' + ref.model
    : undefined
}
