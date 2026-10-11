/**
 * Wiring contract of the Auto Review settings section.
 *
 * The section reaches no Remote namespace and no Session service by itself: the
 * only dependencies are {@link Config.api} and the optional
 * {@link Config.connection}, supplied by whoever mounts this plugin. The wiring
 * owner injects the generated Remote methods and the connection generation
 * source behind these interfaces through its own Cordis namespace fiber, so the
 * Client never touches an unknown `ctx.remote.*` service directly.
 *
 * Enabling Auto Review is a settings write only. This feature never calls a
 * Session permission API: the user still selects the Auto preset in the Session
 * permission selector, and the Host owns every lifecycle transition.
 */
import {
  AUTO_REVIEW_BUDGET_RANGE,
  type AutoReviewClientApi,
  type AutoReviewConnectionSource,
} from '../contracts/settings.ts'

/** Injected dependency of {@link apply}. */
export interface Config {
  /**
   * Host-backed read/save seam. Only the two DTO operations are used; a
   * rejection from either call is presented as a fixed failure label, never as
   * raw provider or credential text.
   */
  api: AutoReviewClientApi
  /**
   * Optional Host connection generation source. When wired, the section drops
   * in-flight work and disables edits and writes while no generation is ready,
   * and re-reads (never writes) when a new generation appears. When absent, the
   * section treats the api as a single, always-current generation.
   */
  connection?: AutoReviewConnectionSource
}

/**
 * Display range of the two request-budget fields.
 *
 * This is the shared DTO's own `AUTO_REVIEW_BUDGET_RANGE`, referenced rather
 * than restated so the form and the Host can never drift apart. It is shown to
 * the user so the saveable range is explicit, and it is deliberately NOT
 * enforced here: the Host revalidates every save and answers
 * `invalid-settings`, so the Host stays the single source of truth. A value
 * outside this range may still be submitted and will be rejected by the Host.
 */
export const REVIEW_BUDGET_RANGE = AUTO_REVIEW_BUDGET_RANGE
