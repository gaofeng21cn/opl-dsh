import type { ModelRef } from '../../../contracts/catalog.ts'
import type { ExternalModelRoute, ExternalModelSource } from '../../model-sources.ts'
import { KIMI_HARNESS, KIMI_PROTOCOL, KIMI_PROVIDER, isKimiCodeModel } from './kimi-models.ts'

/** What the model source owner must supply for one authorized pairing. */
export interface KimiSourceAnswer {
  /** The owner's route base URL; passed to the CLI as its model base URL. */
  readonly baseURL: string
  /** The owner's credential; passed to the CLI as its model key and never logged. */
  readonly apiKey: string
  /** The wire model sent upstream; the CLI's own catalog id is its env alias. */
  readonly model: string
}

/** The one capability this combination needs from its owner. */
export type KimiSourceOwner = (
  harness: string,
  ref: ModelRef,
) => Promise<KimiSourceAnswer> | KimiSourceAnswer

/**
 * Build the source this harness consumes.
 *
 * This is the combination helper only. It deliberately does **not** register anything:
 * `our-free-model` has a single owner, and that owner registers its own source once
 * through the public registry. Registering here as well would create a second owner for
 * one provider id and make which route wins depend on registration order.
 *
 * @param owner - the model source owner's resolver for this pairing.
 * @returns an {@link ExternalModelSource} for the owner to register.
 */
export function createKimiCodeSource(owner: KimiSourceOwner): ExternalModelSource {
  return {
    provider: KIMI_PROVIDER,
    supports(harness, ref) {
      return harness === KIMI_HARNESS && isKimiCodeModel(ref)
    },
    async resolve(harness, ref) {
      if (!isKimiCodeModel(ref)) throw Error('该模型不属于官方 Kimi Code 可服务的组合，已拒绝启动')
      const answer = await owner(harness, ref)
      const route: ExternalModelRoute = {
        baseURL: answer.baseURL,
        apiKey: answer.apiKey,
        model: answer.model,
        protocol: KIMI_PROTOCOL,
      }
      return route
    },
  }
}
