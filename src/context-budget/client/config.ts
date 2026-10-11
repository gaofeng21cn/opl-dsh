/**
 * Wiring contract of the Client context-budget view: {@link Config.read} is the
 * single read dependency, supplied by whoever mounts this plugin. The view
 * reaches no Remote namespace and asks no model. Its display toggle is local.
 */
import type { ContextBudgetSnapshot } from '../contracts/budget.ts'

/** Read-only dependency handed to {@link apply}. */
export interface Config {
  /**
   * Read the current budget observations of one Session.
   *
   * A rejection is reported as an independent read failure; a resolved snapshot
   * is displayed verbatim, with `metrics` and `warnings` neither recomputed nor
   * replaced by policy defaults.
   * @param sessionId - public Session identity whose observations are asked for.
   * @returns the Host-computed read-only snapshot.
   */
  read(sessionId: string): Promise<ContextBudgetSnapshot>
}
