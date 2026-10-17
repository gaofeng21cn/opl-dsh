/** Picker policy for OFM lanes rejected by their required official client. */
import type { ModelRef } from '../../contracts/catalog.ts'
import { OFM_PROVIDER, OFM_PROVIDERS, isExcludedOfmModel } from './provider.ts'

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

/**
 * OFM-discovered identities routed through the official CLI's own `opencode` free provider.
 *
 * Every entry is a bare id the OpenCode directory itself serves as `opencode/<id>` on its
 * Chat Completions endpoint, so the agent loop can use the CLI's built-in free provider
 * instead of an OPL-configured route. The provider reference stays `our-free-model`: the
 * owning plugin remains the source of discovery, account and update, and this list only
 * decides which of its lanes are addressed by that wire value.
 *
 * Each id must also be declared in the OpenCode adapter's own model surface; the adapter
 * tests assert that containment, so a lane can never be routed here while the harness
 * refuses to pin it. `beam-free` and `nemotron-3.5-super-vl-free` were added on 2026-10-17
 * from the owning plugin's live free lane plus the official directory; the directory
 * listing is a declaration, not proof of a call.
 */
export const OFM_OPENCODE_OFFICIAL_FREE_MODELS: readonly string[] = [
  'cat-jam-free',
  'mimo-v2.6-flash-free',
  'muse-spark-1.3-contributor-free',
  'nemotron-3.5-lightning-free',
  'longcat-2.5-preview-free',
  'deepseek-v4.1-flash-free',
  'space-bunny-free',
  'beam-free',
  'nemotron-3.5-super-vl-free',
  'glm-5.3-flash-free',
]

/**
 * OpenCode-directory ids the owning OFM plugin does **not** publish, refused rather than
 * approximated.
 *
 * All three exist in the official OpenCode directory, but none is a `our-free-model` lane:
 * `exo-free` and `big-pickle` are absent from the plugin's live free lane — `big-pickle`
 * structurally, because that lane admits ids carrying a free token — and `ll-alpha-free` is
 * refused upstream for any client that is not OpenCode itself. A directory id is not a
 * provider/model combination, so there is nothing for DSH to bind, pin, or verify here, and
 * no endpoint, credential or availability may be inferred for them. They are named so the
 * refusal is a recorded decision that a later directory refresh cannot quietly undo.
 */
export const OFM_OPENCODE_DIRECTORY_ONLY_MODELS: readonly string[] = [
  'exo-free',
  'big-pickle',
  'll-alpha-free',
]

/**
 * The `opencode/<id>` wire value for an exact built-in-free-provider lane.
 *
 * An excluded id is never routed, and neither is a directory-only id: the exclusion and the
 * missing owning lane are the decisions, and a directory refresh must not be able to
 * reintroduce either through this mapping. A qualified id such as
 * `nvidia/nemotron-3.5-super-vl:free` is a different route and deliberately answers
 * `undefined`, so it keeps using its own channel instead of being silently rewritten into
 * the bare free lane.
 */
export function officialOpenCodeModel(ref: ModelRef): string | undefined {
  if (ref.provider !== OFM_PROVIDER) return undefined
  if (isExcludedOfmModel(ref.model)) return undefined
  if (OFM_OPENCODE_DIRECTORY_ONLY_MODELS.includes(ref.model)) return undefined
  return OFM_OPENCODE_OFFICIAL_FREE_MODELS.includes(ref.model) ? 'opencode/' + ref.model : undefined
}
