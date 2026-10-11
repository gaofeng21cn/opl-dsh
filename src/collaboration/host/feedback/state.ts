/** Pure task state, bounded notices, and stable identities. */
import { createHash } from 'node:crypto'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { HarnessState } from '../../../execution/contracts/sessions.ts'
import type { NeedsInputNoticeState, TaskRecordState, ReceiptRecordState } from './spec.ts'
import type { HarnessReportState, TaskState, TaskReceipt } from './types.ts'
const sessionRequestId = <T extends string>(value: string) => value as T

/** The states in which a task still accepts new observations. */
export const OPEN_STATES: readonly TaskState[] = [
  'queued',
  'accepted',
  'running',
  'waiting_approval',
  'waiting_input',
  'disconnected',
]

/** The states that notify by default: an outcome or a pause a reviewer acts on. */
export const DEFAULT_NOTIFY_STATES: readonly TaskState[] = [
  'completed',
  'failed',
  'waiting_approval',
  'waiting_input',
]

/** Longest tail of deciding event positions one evidence record keeps. */
const EVIDENCE_EVENT_LIMIT = 8

/** Namespace every combination feedback task id carries, so it is never read as a native caller's id. */
const HARNESS_TASK_NAMESPACE = 'harness-task'

/**
 * The exact protocol failure the bounded automatic resume handles.
 *
 * A failure qualifies only when the provider reported an HTTP 400
 * invalid-request whose message states that `reasoning_text` must be passed
 * back. A summary that merely mentions the token is not enough.
 */
const REASONING_TEXT_STATUS = 400
const REASONING_TEXT_CODE = 'INVALID_REQUEST'
const REASONING_TEXT_TOKEN = /\breasoning_text\b/i
const REASONING_TEXT_PASSBACK = /must be passed back/i

/**
 * The user instruction one automatic resume submits.
 *
 * It is a real model-visible user message recorded in the Session log, so the
 * resumed turn is auditable; it names the protocol failure and forbids the two
 * things that would falsify recovery: repeating committed tool calls and
 * fabricating the missing reasoning. Model selection and thinking state are
 * left to the Session's existing configuration.
 */
export const AUTO_RESUME_PROMPT = [
  'Automatic protocol recovery: the previous turn was interrupted by the provider error',
  '"reasoning_text must be passed back", which cannot be retried as the same request.',
  'Continue the task from the last committed step. Do not repeat tool calls that already',
  'completed, do not fabricate the missing reasoning, and do not restart the task.',
].join(' ')

/**
 * Whether one recorded turn end is the bounded automatic-resume condition.
 * @param reason - the loop's durable `turn/end` reason.
 * @returns true only for an HTTP 400 invalid-request failure that states reasoning_text must be passed back.
 */
export function isReasoningTextProtocolFailure(reason: TurnEndReason | null | undefined): boolean {
  if (reason === null || reason === undefined || reason.kind !== 'error') return false
  const failure = reason.error
  if (failure.status !== REASONING_TEXT_STATUS) return false
  if (failure.code.toUpperCase() !== REASONING_TEXT_CODE) return false
  return REASONING_TEXT_TOKEN.test(failure.message) && REASONING_TEXT_PASSBACK.test(failure.message)
}

/**
 * The summary of a turn that completed with tool protocol syntax in its text.
 * @param families - the marker families found.
 * @returns the one-line summary a notification carries.
 */
export function unverifiedCompletionSummary(families: readonly string[]): string {
  return (
    'the turn completed, but its final text carries tool syntax nothing executed ' +
    `(${families.join(', ')}): the business outcome is not verified`
  )
}

/** The state, summary, and delivery facts one recorded turn end settles. */
export interface TurnSettlement {
  readonly state: Extract<TaskState, 'completed' | 'failed' | 'cancelled'>
  readonly summary: string
  readonly resumeEligible: boolean
  readonly leakedToolSyntax: readonly string[] | null
}

/**
 * Whether two recorded marker-family lists describe the same observation.
 * @param left - one stored list, or null.
 * @param right - the list just derived, or null.
 * @returns true when both are absent or name the same families in order.
 */
export function sameFamilies(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  if (left === null || right === null) return left === right
  return left.length === right.length && left.every((family, index) => family === right[index])
}

/**
 * The original dispatched task one record belongs to, treating a record an
 * earlier build wrote as its own root.
 * @param record - the stored task.
 * @returns the root task id.
 */
export function rootTaskIdOf(record: TaskRecordState): string {
  return record.rootTaskId ?? record.taskId
}

/**
 * Stable durable identity of one combination operation's feedback task.
 *
 * The identity hashes the whole tuple instead of joining its parts: the same
 * dispatcher task name and operation name are legitimate in more than one
 * combination session — two Codex reviewers, two projects, or two combinations
 * produce different sessions carrying the same names — and a joined string would
 * make the second legal dispatch collide with the first and fail. The real
 * combination session id is therefore part of the hashed tuple, and the
 * namespace prefix keeps the result from ever being read as a native caller's
 * id. Nothing here depends on object identity, wall-clock time, or which turn
 * happened to end last, so a retry of one operation lands on the same task, a
 * new instruction gets its own, and an old `completed` can never be read as the
 * outcome of a newer turn.
 * @param execution - the combination execution: its session, dispatcher task, and operation.
 * @returns the feedback task id.
 */
export function harnessTaskIdOf(execution: {
  readonly harnessSessionId: string
  readonly taskId: string
  readonly operationId: string
}): string {
  const identity = createHash('sha256')
    .update(
      JSON.stringify([
        HARNESS_TASK_NAMESPACE,
        execution.harnessSessionId,
        execution.taskId,
        execution.operationId,
      ]),
    )
    .digest('hex')
  return `${HARNESS_TASK_NAMESPACE}:${identity}`
}

/**
 * Map one observed combination turn state onto the task state it reports.
 *
 * The mapping reads the executor's own record, never a wish: an unfinished turn
 * is `accepted` or `running`, a pause keeps its waiting state, and a turn this
 * Host can no longer observe — because it restarted while the operation was in
 * flight — is `disconnected`, which is observed but never notified.
 * `interrupted` is deliberately not a failure: the original instruction is not
 * resent, and calling an unobserved outcome a failure would be the one wrong
 * answer.
 * @param state - the state the execution Harness service recorded for the turn.
 * @returns the task state that turn reports.
 */
export function harnessTaskStateOf(state: HarnessState): HarnessReportState {
  switch (state) {
    case 'queued':
      return 'accepted'
    case 'idle':
    case 'waiting_child':
    case 'running':
      return 'running'
    case 'waiting_approval':
      return 'waiting_approval'
    case 'waiting_input':
      return 'waiting_input'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      // `interrupted`: the Host restarted and no outcome was observed.
      return 'disconnected'
  }
}

/**
 * Whether two durable execution references describe the same execution.
 *
 * A re-registration may only be idempotent: one feedback task must always name
 * the same combination session, the same operation, and the same dispatcher
 * task, so a delivery can never be retargeted at another Session.
 * @param left - stored execution reference.
 * @param right - execution reference just supplied.
 * @returns true when both name the same execution.
 */
export function sameHarnessExecution(
  left: TaskRecordState['execution'],
  right: TaskRecordState['execution'],
): boolean {
  if (left.kind !== 'harness-session' || right.kind !== 'harness-session')
    return left.kind === right.kind
  return (
    left.harnessSessionId === right.harnessSessionId &&
    left.harnessRef === right.harnessRef &&
    left.combination === right.combination &&
    left.taskId === right.taskId &&
    left.operationId === right.operationId
  )
}

/**
 * Stable durable identity of the user instruction one attempt submits, so a
 * duplicate notification or a crash replay presents the same request id.
 * @param rootTaskId - original dispatched task the attempt belongs to.
 * @param attempt - one-based attempt number.
 * @returns the branded request id carried by the submitted user message.
 */
export function resumeRequestIdOf(rootTaskId: string, attempt: number): SessionRequestId {
  return sessionRequestId<SessionRequestId>(`task-feedback-resume:${rootTaskId}:${String(attempt)}`)
}

/**
 * Stable identity of one structured-question pause.
 *
 * The caller-provided question ids name the questions, so a replay of one
 * request yields the same identity; the log cursor separates a genuinely new
 * ask that reuses an id in a later turn from that replay. Identities are the
 * durable key of a waiting delivery, so they never depend on object identity or
 * on the accident of the log having advanced.
 * @param seq - Session log cursor the request was observed at.
 * @param questions - the request's questions, in caller order.
 * @returns the identity string carried by this pause.
 */
export function questionObservationKey(
  seq: number,
  questions: readonly AskUserQuestionItem[],
): string {
  return `${String(seq)}:${questions.map((question) => question.id).join('|')}`
}

/**
 * One bounded single-line rendering of caller-supplied pause text.
 *
 * Question text, option labels, and tool names are written by a caller and read
 * by the receiving model, so collapsing every whitespace run is what keeps one
 * field on one line: without it, a question could inject text that reads as one
 * of the notification's own framing lines. The cap bounds the whole notice.
 * @param text - the caller's text.
 * @param maxChars - cap on the returned line, excluding the truncation marker.
 * @returns the collapsed, capped line.
 */
export function boundedLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars)}…`
}

/**
 * The questions one pause notice carries, bounded in count, options, and text.
 * @param questions - the request's questions, in caller order.
 * @param maxQuestions - cap on the questions carried.
 * @param maxOptions - cap on the options one question carries.
 * @param maxChars - cap on each rendered text field.
 * @returns the bounded questions.
 */
export function boundedQuestions(
  questions: readonly AskUserQuestionItem[],
  maxQuestions: number,
  maxOptions: number,
  maxChars: number,
): NeedsInputNoticeState['questions'] {
  return questions.slice(0, maxQuestions).map((question) => ({
    id: question.id,
    question: boundedLine(question.question, maxChars),
    header: question.header === undefined ? null : boundedLine(question.header, maxChars),
    options: (question.options ?? []).slice(0, maxOptions).map((option) => ({
      label: boundedLine(option.label, maxChars),
      description:
        option.description === undefined ? null : boundedLine(option.description, maxChars),
    })),
    multiSelect: question.multiSelect === true,
    intent: question.intent?.kind ?? null,
  }))
}

/**
 * Whether one recorded user message is the automatic-resume instruction with
 * the given deterministic identity.
 * @param event - one committed Session event.
 * @param requestId - instruction identity the attempt submitted.
 * @returns true when this event is that exact instruction.
 */
export function isResumeInstruction(event: SessionEvent, requestId: string): boolean {
  if (event.type !== 'user/message') return false
  const source = event.data.source
  return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
}

/**
 * Map a recorded turn end onto the task state it settles.
 * @param reason - the loop's durable `turn/end` reason.
 * @returns the terminal task state for that reason.
 */
export function settledState(
  reason: TurnEndReason,
): Extract<TaskState, 'completed' | 'failed' | 'cancelled'> {
  switch (reason.kind) {
    case 'completed':
      return 'completed'
    case 'aborted':
      return 'cancelled'
    default:
      // `error`, `blocked`, `max-tokens`, `interrupted`, and any reason a plugin
      // adds all end the turn without completing: the task failed, and calling
      // that success would be the one wrong answer.
      return 'failed'
  }
}

/**
 * The record one transition would write, or undefined when it changes nothing.
 *
 * This is the single decision rule for a state change, so a transition a
 * caller folds into its own serialized write and one published by the live
 * watcher cannot disagree.
 * @param record - the task as last read, with any turn this transition learns.
 * @param state - the state now observed.
 * @param summary - one line describing what was observed.
 * @param event - the event that decided the state, when one did.
 * @param waitKey - stable identity of this pause for a waiting state; absent otherwise.
 * @param resumeEligible - whether the observed failure matches the bounded automatic-resume condition.
 * @param leakedToolSyntax - tool-invocation markup found in a completed turn's visible text, when any.
 * @returns the record to publish, or undefined when the observation changes nothing.
 */
export function decideTransition(
  record: TaskRecordState,
  now: string,
  state: TaskState,
  summary: string,
  event: SessionEvent | undefined,
  waitKey?: string,
  resumeEligible = false,
  leakedToolSyntax: readonly string[] | null = null,
): TaskRecordState | undefined {
  if (!OPEN_STATES.includes(record.state)) return undefined
  if (event !== undefined && record.evidence.eventSeqs.includes(Number(event.seq))) return undefined
  const nextWaitKey = waitKey ?? null
  // A pause's notice belongs to that pause alone: the caller that observes a
  // waiting state puts it on the record, and every transition out of a
  // waiting state drops it, so no later outcome carries a stale question.
  const nextNeedsInput =
    state === 'waiting_input' || state === 'waiting_approval' ? (record.needsInput ?? null) : null
  const eligible = state === 'failed' && resumeEligible
  const leaked =
    state === 'completed' && leakedToolSyntax !== null && leakedToolSyntax.length > 0
      ? [...leakedToolSyntax]
      : null
  // A replay of the same observation changes nothing. Waiting states pass no
  // event, so their identity is the deciding key rather than a log position.
  if (
    event === undefined &&
    record.state === state &&
    record.summary === summary &&
    record.waitKey === nextWaitKey &&
    record.resumeEligible === eligible &&
    sameFamilies(record.leakedToolSyntax, leaked)
  )
    return undefined
  const evidence = {
    ...record.evidence,
    turn: record.turn,
    seq: event?.seq ?? record.evidence.seq,
    eventSeqs:
      event === undefined
        ? record.evidence.eventSeqs
        : [...record.evidence.eventSeqs, Number(event.seq)].slice(-EVIDENCE_EVENT_LIMIT),
  }
  return {
    ...record,
    state,
    summary,
    waitKey: nextWaitKey,
    needsInput: nextNeedsInput,
    resumeEligible: eligible,
    leakedToolSyntax: leaked,
    evidence,
    updatedAt: now,
  }
}

/**
 * The durable id of the notification one task state owes.
 *
 * A waiting state carries its pause identity so two distinct pauses stay two
 * deliveries while a replay stays one. Records an older build wrote have no
 * wait key; their deciding event position is the compatible fallback.
 * @param record - the task state being notified.
 * @returns the delivery id.
 */
export function deliveryIdOf(record: TaskRecordState): string {
  if (record.state !== 'waiting_approval' && record.state !== 'waiting_input')
    return `${record.taskId}@${record.state}`
  const waitKey =
    record.waitKey ?? (record.evidence.seq === null ? null : String(record.evidence.seq))
  return `${record.taskId}@${record.state}${waitKey === null ? '' : `@${waitKey}`}`
}

/** One stored receipt as callers see it. */
export function projectReceipt(record: ReceiptRecordState): TaskReceipt {
  return {
    deliveryId: record.deliveryId,
    taskId: record.taskId,
    status: record.status,
    ownerId: record.ownerId,
    claimEpoch: record.claimEpoch,
    leaseExpiresAt: record.leaseExpiresAt,
    claimedAt: record.claimedAt,
    updatedAt: record.updatedAt,
  }
}
