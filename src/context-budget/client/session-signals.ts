/**
 * Refresh triggers of the budget view: the Session lifecycle slice plus the
 * official `modelSelection` projection. No timer, no polling, and
 * `contextPressure` is not watched — it moves on every projection frame of a
 * running turn, which would turn each frame into an RPC.
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** Lifecycle slice of the official Session face. */
export interface BudgetSessionState {
  running: boolean
  blank: boolean
  openState: string
}

/** Official per-Session projection read face. */
export interface BudgetProjectionsFace {
  /** @param key - projection key. @returns the identity-stable value face. */
  faceOf(key: string): ObservableSnapshot<unknown>
}

/** Official Session surface this refresh signal consumes. */
export interface BudgetSessionFace extends ObservableSnapshot<BudgetSessionState> {
  /** Host-computed projection values by key. */
  projections: BudgetProjectionsFace
}

/** Official projection key carrying the durable model selection of one Session. */
export const MODEL_SELECTION_PROJECTION = 'modelSelection'

/** Key of a `modelSelection` view the client cannot read; entering or leaving it is a change. */
const ABSENT_VIEW = 'absent'

/**
 * Identity of one official `ModelSelection` (`provider`, `model`,
 * `reasoningEffort`), mirroring the Session Controller's own `sameSelection`
 * comparison.
 * @param selection - one `lastUsed`/`next` value.
 * @returns a stable key for the three compared fields.
 */
function selectionKey(selection: unknown): string {
  if (selection === null || selection === undefined) return 'none'
  if (typeof selection !== 'object') return 'invalid'
  const { provider, model, reasoningEffort } = selection as Record<string, unknown>
  return [provider, model, reasoningEffort]
    .map((part) => (typeof part === 'string' ? part : ''))
    .join('\u0001')
}

/**
 * Identity of one official `modelSelection` view (`{ lastUsed, next }`).
 *
 * The projection store notifies on every accepted seq even when the value is
 * unchanged, so this key — not the notification — decides whether a read is
 * warranted. An absent or unreadable view yields its own key, so losing or
 * regaining the selection also refreshes once.
 * @param view - current `modelSelection` snapshot.
 * @returns a stable key; unequal keys mean a different durable selection.
 */
export function modelSelectionKey(view: unknown): string {
  if (view === null || view === undefined) return ABSENT_VIEW
  if (typeof view !== 'object') return 'invalid'
  const { lastUsed, next } = view as Record<string, unknown>
  return `${selectionKey(lastUsed)}>${selectionKey(next)}`
}

/**
 * Subscribe to every signal that can change one Session's budget route.
 * @param session - official Session read face.
 * @param listener - called on a real lifecycle transition or selection change.
 * @returns unsubscribe callback releasing both subscriptions.
 */
export function watchBudgetSession(session: BudgetSessionFace, listener: () => void): () => void {
  const lifecycleKey = (): string => {
    const { running, blank, openState } = session.getSnapshot()
    return `${String(running)}:${String(blank)}:${String(openState)}`
  }
  let previousLifecycle = lifecycleKey()
  const offLifecycle = session.subscribe(() => {
    const next = lifecycleKey()
    if (next === previousLifecycle) return
    previousLifecycle = next
    listener()
  })
  // An absent face means the capability is not mounted; the view then simply
  // has no selection signal and must not invent one.
  const face =
    typeof session.projections?.faceOf === 'function'
      ? session.projections.faceOf(MODEL_SELECTION_PROJECTION)
      : undefined
  let previousSelection = modelSelectionKey(face?.getSnapshot())
  const offSelection = face?.subscribe(() => {
    const next = modelSelectionKey(face.getSnapshot())
    if (next === previousSelection) return
    previousSelection = next
    listener()
  })
  return () => {
    offLifecycle()
    offSelection?.()
  }
}
