/**
 * Framework seats of the `conversation.input.dock` entry.
 *
 * The official slot catalogue (`CLIENT_SLOT_API` in the packaged
 * `dsh-cordis-client-runner`) lists these standard props for this key, and two
 * shipped consumers read them the same way (`dsh-client-ui-workspace` and
 * `dsh-client-ui-conversation` both call `useSessionStatus((s) => s)` and then
 * `statuses.get(id)?.running`). The enhancement repo's installed typings do not
 * carry the `ui-session` standard-props merge, so the shapes are declared here
 * as the minimal structural contract this component consumes — never as a
 * guessed richer API.
 *
 * @module todo-status/client/seats
 */

/** One row of the framework's per-Session status snapshot, as far as this view reads it. */
export interface SessionStatusEntry {
  /**
   * Live Client observation of that Session's run state.
   *
   * Absent (`undefined`) means the framework has no status row for that Session
   * yet — unloaded or unknown, never a confirmed stop.
   */
  readonly running?: boolean
}

/** Key-addressed face over the framework's per-Session status snapshot. */
export interface SessionStatusSnapshot {
  /** @param sessionId - Session identity. @returns its status row, or `undefined` when unknown. */
  get(sessionId: string): SessionStatusEntry | undefined
}

/** The `useSessionStatus` standard prop: a selector hook over that snapshot. */
export type SessionStatusSeat = (
  select: (snapshot: SessionStatusSnapshot) => SessionStatusSnapshot,
) => SessionStatusSnapshot | undefined

/** One row of the official Session list summary, as far as this view reads it. */
export interface SessionListEntry {
  /** Run state the list last read back for that Session; absent while never reported. */
  readonly running?: boolean
}

/** The official Session list read-back face. */
export interface SessionListSnapshot {
  readonly byId: Readonly<Record<string, SessionListEntry | undefined>>
}

/** The `useSessions` standard prop: a selector hook over the list snapshot. */
export type SessionListSeat = (
  select: (snapshot: SessionListSnapshot) => SessionListSnapshot,
) => SessionListSnapshot | undefined
