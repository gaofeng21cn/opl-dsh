/**
 * The conservative permission-review bridge for external Harnesses.
 *
 * An external ACP/CLI Harness runs its own agent loop, so its tool calls never
 * pass through the native `tools/pre-execute` gate. What does reach this Host is
 * the Harness's own permission ask, which the composition already projects onto
 * the official `approval/request` waterfall. This module is the one place that
 * may answer such an ask from a reviewer decision instead of a human.
 *
 * ## Why the bridge refuses far more often than it answers
 *
 * A review is only as strong as the facts it is bound to. Answering a Harness
 * ask needs, at minimum, the exact tool action, the owning turn and Session, the
 * durable authorization the Session carries, and the connection generation the
 * ask belongs to — because the ACP connection is what makes a late answer land
 * on the action that was reviewed. The `approval/request` event itself carries
 * `toolName`, an optional `callId`, a human-readable `reason` and the live
 * `signal`; it does **not** carry the ACP session, a generation, the owning
 * turn, or a structured action.
 *
 * Those missing facts are therefore never guessed and never reconstructed from
 * the ask's prose. They have to be supplied by the composition through an
 * explicit {@link ExternalReviewBindingPort}, and without that port every
 * candidate ask is conservatively refused: the bridge does not claim the
 * request, the ordinary human approval flow answers it exactly as before, and
 * the official `approval/asked` audit pair still records the ask. An ACP
 * permission request is never itself treated as a successful Auto Review.
 *
 * When a port *is* offered, the bridge still:
 *
 *  - refuses every Harness outside {@link EXTERNAL_REVIEW_HARNESSES} and every
 *    ask whose binding is incomplete or malformed;
 *  - claims a request only for an agent the integration is eligible to review,
 *    which excludes a disabled integration and a `never` approval policy;
 *  - re-reads the binding after the reviewer answers and requires the exact
 *    action, turn and generation to be unchanged, so a late decision cannot land
 *    on a different action or on a reconnected Harness;
 *  - answers `rejected` — never `allowed-once` — when the review throws, when
 *    the signal aborted, or when anything about the binding moved.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { ReviewDecision } from './policy.ts'

/**
 * External Harnesses this bridge may consider.
 *
 * `zcode` is the only one OPL drives itself, and the only one whose permission
 * asks are considered here. Every other Harness keeps its own official flow.
 */
export const EXTERNAL_REVIEW_HARNESSES: readonly string[] = ['zcode']

/**
 * The closed set of fixed reasons the bridge will not answer an external ask
 * itself. None of them carries Harness text.
 */
export type ExternalReviewBlock =
  | 'harness-not-bridged'
  | 'bridge-not-offered'
  | 'binding-refused'
  | 'binding-unstable'
  | 'review-refused'

/** Fixed, safe text for each {@link ExternalReviewBlock}. */
export const EXTERNAL_REVIEW_BLOCK_TEXT: Readonly<Record<ExternalReviewBlock, string>> = {
  'harness-not-bridged': 'the external Harness exposes no independent permission-review interface',
  'bridge-not-offered': 'the composition offers no binding for external permission asks',
  'binding-refused': 'the pending external permission ask could not be bound to its exact action',
  'binding-unstable': 'the external permission ask changed while it was being reviewed',
  'review-refused': 'the external permission review produced no usable decision',
}

/** The exact tool action one external ask would run. */
export interface ExternalReviewAction {
  readonly name: string
  readonly parameters: unknown
}

/** Where one external ask's authority comes from. */
export interface ExternalReviewAuthorization {
  /** The native Session that owns the Harness conversation. */
  readonly sessionId: string
  /** That Session's live permission preset at binding time. */
  readonly preset: string
  /** The Harness task's own authorized filesystem boundary. */
  readonly sandbox: string
  /** The combination the Harness task runs. */
  readonly combination: string
}

/** The complete identity of one pending external permission ask. */
export interface ExternalReviewBinding {
  /** Harness reference that raised the ask, e.g. `zcode`. */
  readonly harness: string
  readonly callId: string
  /** The ACP session the ask belongs to. */
  readonly acpSessionId: string
  /** Monotonic generation of the connection that owns the ask. */
  readonly generation: number
  /** 1-based index of the owning Harness turn inside its record. */
  readonly turn: number
  /** The owning turn's stable operation identity. */
  readonly turnId: string
  /** The exact tool action the Harness asked to run. */
  readonly action: ExternalReviewAction
  /** The authorization the ask is read from. */
  readonly authorization: ExternalReviewAuthorization
}

/**
 * The composition-supplied binding of an external permission ask.
 *
 * Implementations read the live connection record; returning `null` for an ask
 * that cannot be bound exactly is the correct, conservative answer.
 */
export interface ExternalReviewBindingPort {
  bind(agent: Agent, request: ExternalReviewRequest): ExternalReviewBinding | null
}

/** The `approval/request` payload as this bridge reads it. */
export interface ExternalReviewRequest {
  readonly agent: Agent
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** Whether the bridge may claim one ask, and what it is bound to. */
export type ExternalReviewAssessment =
  | { readonly claim: true; readonly binding: ExternalReviewBinding }
  | { readonly claim: false; readonly block: ExternalReviewBlock }

/** Whether a value is a usable binding, validated field by field. */
function isBinding(value: ExternalReviewBinding | null): value is ExternalReviewBinding {
  if (value === null || typeof value !== 'object') return false
  if (typeof value.harness !== 'string' || value.harness.length === 0) return false
  if (typeof value.callId !== 'string' || !value.callId) return false
  if (typeof value.acpSessionId !== 'string' || value.acpSessionId.length === 0) return false
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) return false
  if (!Number.isSafeInteger(value.turn) || value.turn < 1) return false
  if (typeof value.turnId !== 'string' || value.turnId.length === 0) return false
  const action = value.action
  if (action === null || typeof action !== 'object') return false
  if (typeof action.name !== 'string' || action.name.length === 0) return false
  const authorization = value.authorization
  if (authorization === null || typeof authorization !== 'object') return false
  for (const field of ['sessionId', 'preset', 'sandbox', 'combination'] as const)
    if (typeof authorization[field] !== 'string' || authorization[field].length === 0) return false
  try {
    return JSON.stringify(action.parameters) !== undefined
  } catch {
    return false
  }
}

/**
 * Decide whether the bridge may claim one ask.
 *
 * An ask from a Harness this bridge does not own, a composition without a
 * binding port, a port that throws, and a binding that is incomplete or
 * malformed all land on a fixed refusal. Nothing is inferred from the ask's
 * prose.
 * @param port - the composition's binding port, when it offers one.
 * @param agent - the agent the ask was raised for.
 * @param request - the `approval/request` payload.
 * @returns the claimed binding, or the fixed reason it was refused.
 */
export function assessExternalReview(
  port: ExternalReviewBindingPort | undefined,
  agent: Agent,
  request: ExternalReviewRequest,
): ExternalReviewAssessment {
  if (!EXTERNAL_REVIEW_HARNESSES.includes(request.toolName))
    return { claim: false, block: 'harness-not-bridged' }
  if (port === undefined) return { claim: false, block: 'bridge-not-offered' }
  let binding: ExternalReviewBinding | null
  try {
    binding = port.bind(agent, request)
  } catch {
    binding = null
  }
  if (
    !isBinding(binding) ||
    binding.harness !== request.toolName ||
    binding.callId !== request.callId
  )
    return { claim: false, block: 'binding-refused' }
  return { claim: true, binding }
}

/** Whether two bindings describe exactly the same pending action. */
export function sameExternalReviewBinding(
  left: ExternalReviewBinding,
  right: ExternalReviewBinding,
): boolean {
  return (
    left.harness === right.harness &&
    left.callId === right.callId &&
    left.acpSessionId === right.acpSessionId &&
    left.generation === right.generation &&
    left.turn === right.turn &&
    left.turnId === right.turnId &&
    left.action.name === right.action.name &&
    JSON.stringify(left.action.parameters) === JSON.stringify(right.action.parameters) &&
    left.authorization.sessionId === right.authorization.sessionId &&
    left.authorization.preset === right.authorization.preset &&
    left.authorization.sandbox === right.authorization.sandbox &&
    left.authorization.combination === right.authorization.combination
  )
}

/**
 * Render the facts of one bound external ask for the reviewer.
 *
 * The Harness's own prose is a labelled fact, never an instruction, and the
 * exact action is rendered as JSON so the reviewer judges what would run.
 * @param binding - the validated binding.
 * @param request - the ask the binding came from.
 * @returns the reviewer's user text.
 */
export function externalReviewUserText(
  binding: ExternalReviewBinding,
  request: ExternalReviewRequest,
): string {
  return [
    'EXTERNAL_PERMISSION_REQUEST',
    JSON.stringify(
      {
        harness: binding.harness,
        callId: binding.callId,
        acpSessionId: binding.acpSessionId,
        generation: binding.generation,
        turn: binding.turn,
        turnId: binding.turnId,
        action: binding.action,
        authorization: binding.authorization,
        harnessReportedReason: request.reason ?? '',
      },
      null,
      2,
    ),
  ].join('\n\n')
}

/** What the bridge needs from the integration that installs it. */
export interface ExternalReviewBridge {
  /** The binding port the composition offers, or undefined when it offers none. */
  port(): ExternalReviewBindingPort | undefined
  /** Whether this agent's ask may be answered by the reviewer right now. */
  eligible(agent: Agent): boolean
  /** Run the shared tool-free reviewer for one bound ask; throwing refuses it. */
  review(binding: ExternalReviewBinding, request: ExternalReviewRequest): Promise<ReviewDecision>
  /** Whether the bound ask still describes exactly what would run. */
  fresh(binding: ExternalReviewBinding, request: ExternalReviewRequest): boolean
}

/**
 * Install the bridge on the official approval waterfall.
 *
 * The listener is prepended so a claim happens before the interactive answerer,
 * and it calls `next()` exactly once on every path that does not claim. That is
 * what keeps the ordinary human permission flow intact: a Harness this bridge
 * does not own, an ineligible agent, an unbindable ask and any internal failure
 * all delegate to the same chain they used before.
 * @param ctx - the Host context that owns the listener's lifetime.
 * @param bridge - the integration the listener answers through.
 * @returns the disposer that removes the listener.
 */
export function installExternalReviewBridge(
  ctx: Context,
  bridge: ExternalReviewBridge,
): () => void {
  /** Claim one ask, or return null so the caller delegates unchanged. */
  const claim = async (request: ApprovalRequestEvent): Promise<ApprovalOutcome | null> => {
    try {
      if (!EXTERNAL_REVIEW_HARNESSES.includes(request.toolName)) return null
      if (!bridge.eligible(request.agent)) return null
      const assessment = assessExternalReview(bridge.port(), request.agent, request)
      if (!assessment.claim) return null
      let decision: ReviewDecision
      try {
        decision = await bridge.review(assessment.binding, request)
      } catch {
        return 'rejected'
      }
      if (request.signal?.aborted === true) return 'rejected'
      if (!bridge.fresh(assessment.binding, request)) return 'rejected'
      return decision.decision === 'allow' ? 'allowed-once' : 'rejected'
    } catch {
      // Any read or wiring failure is a refusal to answer, never an allow.
      return null
    }
  }
  const off = ctx.on(
    'approval/request',
    async (request: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) => {
      const outcome = await claim(request)
      return outcome === null ? await next() : outcome
    },
    { prepend: true },
  )
  return () => off()
}
