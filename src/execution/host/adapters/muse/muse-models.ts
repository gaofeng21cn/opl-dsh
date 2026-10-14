/**
 * Pinned model lanes for the official Muse Code CLI.
 *
 * Evidence, all taken from the official Windows binary `Muse Code 1.4.7
 * (1.4.7-R6101.1)` (build `d8c53d25bd30cda15ab32bda15ab32bda…`, reported in the
 * MSP `initialize` result `userAgent`) under an isolated `XDG_*` profile:
 *
 *  - Both ids are catalog models the binary itself resolves: `muse model-profile
 *    show <id> --effort <tier>` exits `0` and prints `model: <id>` for every tier
 *    (`none minimal low medium high xhigh max ultra`). That is knob resolution,
 *    not proof the endpoint serves the id, so the adapter still refuses whenever
 *    the runtime rejects the selection.
 *  - The wire protocol is the OpenAI Responses API. The official CLI issues
 *    `POST <base-url>/responses` with `{model, input, instructions,
 *    max_output_tokens, store, tools, reasoning, include, prompt_cache_key,
 *    stream}` and `stream: true`; tools are advertised in the `namespace` form
 *    `{type: "namespace", name: "mcp__<server>", tools: [...]}`.
 *  - `session/setReasoningEffort` accepts the closed vocabulary below for both
 *    ids on this build and returns `{commandId, status: "accepted"}`. Acceptance
 *    at admission is not a per-model tier advertisement, so this module forwards
 *    the caller's tier unchanged and never substitutes one.
 *  - `max` is a member of the official closed vocabulary and is not a property of
 *    this suite: the tier belongs to whichever model the source resolved, and the
 *    runtime refuses an unserved one. Nothing here maps one model's tier onto
 *    another model.
 *  - `--contributor-mode <on|off>` is the per-process override for the contributor
 *    tier, and both lane ids name that tier in the id itself. Deriving the flag
 *    from the pinned id keeps the flag and the model in one place; it is not a
 *    model swap and it never changes which id is requested.
 *
 * The dynamic catalog stays with the official plugin and the model source owner.
 * This module declares adaptation intent, not availability.
 */
import type { ModelRef } from '../../../contracts/catalog.ts'

/** Harness identity: the official Muse Code CLI's MSP `serve` host. */
export const MUSE_HARNESS = 'muse-code'
/** The command the official installer puts on PATH. */
export const MUSE_COMMAND = 'muse'
/** Provider that owns these model references and their credentials. */
export const MUSE_PROVIDER = 'our-free-model'
/** Wire protocol the official Meta provider route speaks. */
export const MUSE_PROTOCOL = 'responses' as const
/**
 * Stable-surface fingerprint the bridge refuses to talk past.
 *
 * `muse serve` reports it in the `initialize` result, and the value served by
 * 1.4.7-R6101.1 is `sha256:6de32db08bbbe0deb478d2bfcaba001e9fb490986bc80db3aceb4d996abf7df9`,
 * identical to the `EXPECTED_SCHEMA_FINGERPRINT` `@muse-code/sdk@1.4.7` pins. A
 * different fingerprint means the surface this adapter was written against has moved,
 * so the launch stops and is reviewed rather than continued against an unknown schema.
 */
export const MUSE_SCHEMA_FINGERPRINT =
  'sha256:6de32db08bbbe0deb478d2bfcaba001e9fb490986bc80db3aceb4d996abf7df9'

/** Provider id the CLI names for the Meta route. */
export const MUSE_PROVIDER_ID = 'meta'
/** Provider profile the CLI reports for the Meta route. */
export const MUSE_PROFILE_ID = 'tbh'
/**
 * The endpoint a served session reaches when nothing else is configured.
 *
 * Present in the binary as `https://api.meta.ai/v1`, and consistent with the captured
 * request, which is `POST https://api.meta.ai/v1/responses`.
 *
 * This is Meta's own address. It is **not** a deliverable channel for a model source,
 * and nothing in this adapter may present it as one: a combination that ran here would
 * reach an endpoint its source never selected. It is named so that refusal can say
 * precisely what it is declining to substitute.
 */
export const MUSE_BOUND_BASE_URL = 'https://api.meta.ai/v1'

/** The pinned CLI accepts endpoint_transport.base_url in its owned settings file. */
export const MUSE_SUPPORTS_SOURCE_ENDPOINT = true

/** The exact model ids this adapter is written to drive. */
export const MUSE_MODELS = [
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
] as const
export type MuseModelId = (typeof MUSE_MODELS)[number]

/**
 * The official closed effort vocabulary, as printed by `muse --reasoning-effort`
 * and `muse model-profile show --effort`. Forwarded verbatim; never remapped.
 */
export const MUSE_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const
export type MuseEffort = (typeof MUSE_EFFORTS)[number]

/** One pinned lane: everything the launch needs that does not come from a source. */
export interface MuseLane {
  model: MuseModelId
  provider: string
  protocol: typeof MUSE_PROTOCOL
  providerId: typeof MUSE_PROVIDER_ID
  profileId: typeof MUSE_PROFILE_ID
  /** `contributor` ids request the official contributor tier for this process only. */
  contributorMode: 'on'
}

/**
 * Read the pinned lane for a reference, or `undefined` when it is not one of ours.
 *
 * The comparison is exact and whole: a prefix, a case change or an appended tier
 * is a different model, and answering for it would mean guessing an endpoint.
 * @param ref - the combination's model reference.
 * @returns the lane this adapter can drive, or `undefined`.
 */
export function museLane(ref: ModelRef): MuseLane | undefined {
  if (ref.provider !== MUSE_PROVIDER) return undefined
  const model = MUSE_MODELS.find((candidate) => candidate === ref.model)
  if (!model) return undefined
  return {
    model,
    provider: MUSE_PROVIDER,
    protocol: MUSE_PROTOCOL,
    providerId: MUSE_PROVIDER_ID,
    profileId: MUSE_PROFILE_ID,
    contributorMode: 'on',
  }
}

/**
 * Whether this adapter is the one for a reference. `matches` must not become a
 * stand-in for "the model is currently served": that is the source owner's and the
 * runtime's answer, and the adapter checks it again before every launch.
 * @param ref - the combination's model reference.
 * @returns true only for an exact lane of this provider.
 */
export function isMuseModel(ref: ModelRef): boolean {
  return museLane(ref) !== undefined
}

/**
 * Map a session's requested reasoning effort onto the official vocabulary.
 *
 * A tier this build does not name is refused here rather than dropped, because
 * dropping it would silently run a different tier than the combination states.
 * @param requested - the session's `reasoningEffort`, as the execution engine set it.
 * @returns the official tier, or `undefined` when the session asked for none.
 * @throws Error when the requested tier is outside the official closed vocabulary.
 */
export function museEffortValue(requested: string | undefined): MuseEffort | undefined {
  if (requested === undefined || requested === '') return undefined
  const tier = MUSE_EFFORTS.find((candidate) => candidate === requested)
  if (!tier)
    throw Error(
      `官方 Muse Code 未定义思考档位 ${requested}（官方取值：${MUSE_EFFORTS.join('、')}）；已停止，不会改用其他档位。`,
    )
  return tier
}
