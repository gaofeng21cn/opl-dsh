/**
 * Official Poolside Agent CLI (`pool acp`) model surface.
 *
 * The two ids below are the **adaptation intent** for this host, not proof of
 * availability. `pool acp` builds its `model` picker from the models its
 * configured endpoint advertises, so that catalog stays owned by the endpoint
 * and the official CLI. This module only names the ids the suite is prepared to
 * pin; whether an id is actually offered is decided per session by reading the
 * agent's own advertisement in {@link ./pool.ts}, and an id the agent does not
 * advertise is refused rather than approximated or swapped.
 *
 * The measured behaviour behind that rule, from the official Windows package
 * `https://downloads.poolside.ai/pool/v1.0.16/pool-windows-amd64.tar.gz`
 * (SHA256 `3e324f1a4b5855ba5363232c06461ec9d6d2ae1a341c827221e79779f8f2bc6f`,
 * equal to that release's `checksums.txt`), driven over real ACP against a
 * controlled endpoint:
 *
 * - `session/new` advertises `mode`, `agent_mode` and `model` config options.
 * - `session/set_config_option {configId: "model", value: <unlisted id>}` is
 *   rejected by the CLI with `standalone model "<id>" is not available`.
 * - A listed id is accepted and the returned advertisement reports it as the
 *   new `currentValue`, which is what makes a read-back check possible.
 * - No thought-level arm is advertised for an endpoint whose model rows carry no
 *   reasoning metadata. A tier this CLI never advertised is therefore a control
 *   it does not have, and is refused instead of being carried over from another
 *   provider.
 *
 * Nothing here declares an endpoint or a credential: both come from the model
 * source owner in `../model-sources.ts`.
 */
import type { ModelRef } from '../../../contracts/catalog.ts'

/** Harness identity as it appears in the suite's Harness catalog. */
export const POOL_HARNESS = 'pool'

/** Model provider owner that publishes the Poolside ids this harness can pin. */
export const POOL_PROVIDER = 'our-free-model'

/**
 * Wire protocol a source must declare for this pairing.
 *
 * The official CLI talks to its endpoint over OpenAI chat completions, which is
 * what `POOLSIDE_STANDALONE_BASE_URL` receives. The value stays pinned because it
 * is part of the combination's identity: a source that resolves this model under
 * a different protocol is a different route and is refused instead of coerced.
 */
export const POOL_PROTOCOL = 'chat'

/** Exact ACP `model` config-option value for Laguna S 2.1. */
export const POOL_LAGUNA_S = 'poolside/laguna-s-2.1:free'
/** Exact ACP `model` config-option value for Laguna XS 2.1. */
export const POOL_LAGUNA_XS = 'poolside/laguna-xs-2.1:free'

/** Every model id this adapter is prepared to pin, in catalog order. */
export const POOL_MODELS: readonly string[] = [POOL_LAGUNA_S, POOL_LAGUNA_XS]

/**
 * Whether this adapter handles the given model reference.
 *
 * Both halves must match: the provider must be the owner that published the id,
 * and the id must be one this adapter knows how to pin. A model owned by the
 * same provider but aimed at another harness is not silently absorbed.
 */
export function isPoolModel(ref: ModelRef): boolean {
  return ref.provider === POOL_PROVIDER && POOL_MODELS.includes(ref.model)
}

/** Model references this adapter contributes to the catalog, in catalog order. */
export const poolModels = (): readonly ModelRef[] =>
  POOL_MODELS.map((model) => ({ provider: POOL_PROVIDER, model }))

/** ACP `configOptions` id carrying the selectable model. */
export const POOL_MODEL_OPTION = 'model'
/** ACP `configOptions` id carrying the approval mode. */
export const POOL_MODE_OPTION = 'mode'
/** ACP `configOptions` id carrying the thought level, when the endpoint offers one. */
export const POOL_THOUGHT_OPTION = 'thought_level'

/**
 * Resolve the thought value a caller asked for, without inventing one.
 *
 * There is no suite-wide default tier here: the official CLI derives the offered
 * values from the endpoint's own model metadata, so any default would be a guess.
 * An absent choice returns `undefined`, which the adapter reads as "write nothing
 * and keep the CLI's own default".
 */
export function poolThoughtValue(requested?: string): string | undefined {
  const choice = typeof requested === 'string' ? requested.trim() : ''
  return choice.length > 0 ? choice : undefined
}
