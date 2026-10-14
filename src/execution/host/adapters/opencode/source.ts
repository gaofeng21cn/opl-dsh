/**
 * Explicit external-execution source for the official OpenCode CLI, paired with the
 * original `dsh-our-free-model` plugin.
 *
 * This is a pairing layer, not a second OFM. The plugin keeps its catalog, channels,
 * rotation chain, credentials and updater; this module decides only which models the
 * OpenCode CLI may run, and it asks its owner for the route.
 *
 * It is deliberately **not** registered here. `our-free-model` has a single owner, and
 * that owner registers its own source once through `ctx.oplExternalModelSources`.
 * Registering here as well would create a second owner for one provider id — the registry
 * refuses that outright — and a local source that shadowed the shared one would make
 * which route wins depend on registration order.
 *
 * Nothing is inferred: an id that is not declared here is refused, the protocol is the one
 * the CLI actually bridges, and no endpoint, key or model is ever derived from a name.
 *
 * @module adapters/opencode/source
 */
import type { ModelRef } from '../../../contracts/catalog.ts'
import type { ExternalModelRoute, ExternalModelSource } from '../../model-sources.ts'
import {
  isOpenCodeModel,
  OPENCODE_HARNESS,
  OPENCODE_OFM_PROVIDER,
  OPENCODE_PROTOCOL,
} from './opencode-models.ts'

/** What the model source owner must supply for one authorized pairing. */
export interface OpenCodeSourceAnswer {
  /** The owner's route base URL; passed to the CLI as its provider base URL. */
  readonly baseURL: string
  /** The owner's credential; passed to the CLI as its provider key and never logged. */
  readonly apiKey: string
  /** The wire model sent upstream; the CLI's own namespace value is derived from the record. */
  readonly model: string
}

/** The one capability this combination needs from its owner. */
export type OpenCodeSourceOwner = (
  harness: string,
  ref: ModelRef,
) => Promise<OpenCodeSourceAnswer> | OpenCodeSourceAnswer

/**
 * Models this run explicitly declines to adapt to OpenCode.
 *
 * Each is either present in the plugin's catalog or structurally valid, so catalog
 * membership alone would admit them; the exclusion is the decision, and it is refused
 * rather than downgraded. They remain available through the plugin's own native routes —
 * this list removes nothing from it.
 */
export const OPENCODE_EXCLUDED_MODELS: readonly string[] = [
  'openai/gpt-oss-20b',
  'jev-1.13-free',
  'nvidia/nemotron-3.5-content-safety:free',
]

/** Whether a model is excluded by name for this run. */
export const isExcludedOpenCodeModel = (model: string): boolean =>
  OPENCODE_EXCLUDED_MODELS.includes(model)

/**
 * Build the source this harness consumes.
 *
 * The combination helper only. It narrows the shared owner to this Harness and to the
 * models this run declared, and refuses everything else — including a model that arrives
 * late, was withdrawn, or belongs to another Harness's pairing.
 *
 * @param owner - the model source owner's resolver for this pairing.
 * @returns an {@link ExternalModelSource} for the owner to register once.
 */
export function createOpenCodeSource(owner: OpenCodeSourceOwner): ExternalModelSource {
  return {
    provider: OPENCODE_OFM_PROVIDER,

    /**
     * Synchronous, so it answers from declared facts only: the exact harness, an id this
     * run named for it, and an id that is not excluded. Live catalog membership and late
     * revocation are proven in `resolve()` by the owner's own read.
     */
    supports(harness, ref) {
      return (
        harness === OPENCODE_HARNESS && isOpenCodeModel(ref) && !isExcludedOpenCodeModel(ref.model)
      )
    },

    async resolve(harness, ref) {
      if (harness !== OPENCODE_HARNESS) throw Error('该模型来源尚未适配此 Harness')
      if (ref.provider !== OPENCODE_OFM_PROVIDER) throw Error('模型不属于 Our Free Model 插件')
      if (isExcludedOpenCodeModel(ref.model))
        throw Error(`模型「${ref.model}」未纳入本次 OpenCode 适配范围`)
      if (!isOpenCodeModel(ref))
        throw Error(`模型「${ref.model}」未分配给 OpenCode Harness，已拒绝启动`)
      const answer = await owner(harness, ref)
      const route: ExternalModelRoute = {
        baseURL: answer.baseURL,
        apiKey: answer.apiKey,
        model: answer.model,
        protocol: OPENCODE_PROTOCOL,
      }
      return route
    },
  }
}
