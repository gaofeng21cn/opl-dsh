/**
 * Explicit external-execution source for the official Kilo CLI, paired with the original
 * `dsh-our-free-model` plugin.
 *
 * This is a pairing layer, not a second OFM. The plugin keeps its catalog, channels, rotation
 * chain, credentials and updater; this module decides only which models the Kilo CLI may run,
 * and it asks its owner for the route.
 *
 * It is deliberately **not** registered here. `our-free-model` has a single owner, and that
 * owner registers its own source once through `ctx.oplExternalModelSources`. Registering
 * here as well would create a second owner for one provider id — the registry refuses that
 * outright — and a local source that shadowed the shared one would make which route wins
 * depend on registration order.
 *
 * Nothing is inferred: an id that is not declared here is refused, the protocol is the one the
 * CLI actually bridges, and no endpoint, key or model is ever derived from a name. A model
 * that arrives late, was withdrawn, or belongs to another Harness's pairing is refused here
 * rather than resolved and repaired downstream.
 *
 * @module adapters/kilo/source
 */
import type { ModelRef } from '../../../contracts/catalog.ts'
import type { ExternalModelRoute, ExternalModelSource } from '../../model-sources.ts'
import {
  isExcludedKiloModel,
  isKiloModel,
  KILO_HARNESS,
  KILO_OFM_PROVIDER,
  KILO_PROTOCOL,
} from './kilo-models.ts'

/** What the model source owner must supply for one authorized pairing. */
export interface KiloSourceAnswer {
  /** The owner's route base URL; passed to the CLI as its provider base URL. */
  readonly baseURL: string
  /** The owner's credential; passed to the CLI as its provider key and never logged. */
  readonly apiKey: string
  /**
   * The wire model sent upstream; the CLI's own namespace value is derived from the record.
   *
   * For a routing entry this stays the routing entry. An owner must not expand it into a
   * concrete model here, because the adapter pins and verifies the record's exact id.
   */
  readonly model: string
}

/** The one capability this combination needs from its owner. */
export type KiloSourceOwner = (
  harness: string,
  ref: ModelRef,
) => Promise<KiloSourceAnswer> | KiloSourceAnswer

/**
 * Build the source this harness consumes.
 *
 * The combination helper only. It narrows the shared owner to this Harness and to the models
 * this run declared, and refuses everything else.
 *
 * @param owner - the model source owner's resolver for this pairing.
 * @returns an {@link ExternalModelSource} for the owner to register once.
 */
export function createKiloSource(owner: KiloSourceOwner): ExternalModelSource {
  return {
    provider: KILO_OFM_PROVIDER,

    /**
     * Synchronous, so it answers from declared facts only: the exact harness, an id this run
     * named for it, and an id that is not excluded. Live catalog membership and late
     * revocation are proven in `resolve()` by the owner's own read.
     */
    supports(harness, ref) {
      return harness === KILO_HARNESS && isKiloModel(ref) && !isExcludedKiloModel(ref.model)
    },

    async resolve(harness, ref) {
      if (harness !== KILO_HARNESS) throw Error('该模型来源尚未适配此 Harness')
      if (ref.provider !== KILO_OFM_PROVIDER) throw Error('模型不属于 Our Free Model 插件')
      if (isExcludedKiloModel(ref.model))
        throw Error(`模型「${ref.model}」未纳入本次 Kilo 适配范围`)
      if (!isKiloModel(ref)) throw Error(`模型「${ref.model}」未分配给 Kilo Harness，已拒绝启动`)
      const answer = await owner(harness, ref)
      const route: ExternalModelRoute = {
        baseURL: answer.baseURL,
        apiKey: answer.apiKey,
        model: answer.model,
        protocol: KILO_PROTOCOL,
      }
      return route
    },
  }
}
