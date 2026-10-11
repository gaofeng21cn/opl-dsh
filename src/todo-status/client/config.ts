/**
 * Wiring contract of the read-only todo panel.
 *
 * The panel needs no transport, no Remote, and no Host half: it reads the
 * official `todos` projection and the public Session status seats. The only
 * optional dependency is a direct child-status read, offered because the
 * framework standard prop it otherwise uses is not carried by this checkout's
 * installed typings. Omitting it changes nothing observable beyond leaving an
 * unreadable child status unknown.
 *
 * @module todo-status/client/config
 */
import type { ChildActivityReader } from './todo-display.ts'

/** Optional dependencies handed to {@link import('./index.tsx').apply}. */
export interface TodoStatusConfig {
  /**
   * Read one direct child Session's run state.
   *
   * `true` — observed running; `false` — observed not running; `undefined` —
   * unknown. An `undefined` answer falls through to the public
   * `useSessionStatus` seat and then to the `useSessions` list read-back, so a
   * wiring that only knows some children cannot turn the rest into "idle".
   * @param childId - direct-child Session id from `subagentCatalog`.
   * @returns the observed run state, or `undefined` when unknown.
   */
  readChildStatus?: ChildActivityReader
}
