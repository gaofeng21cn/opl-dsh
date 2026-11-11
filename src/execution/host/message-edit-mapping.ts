/** Match official user events to vendor input identities without text or position inference. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { HarnessSession } from '../contracts/sessions.ts'
import type { MessageEditSend } from '../contracts/message-edit.ts'
import type { ExternalEditHistory, ExternalEditResult } from './message-edit-driver.ts'
import {
  editableNativeMessage,
  readNativeUserMessages,
  turnRequestIds,
} from './stop-edit-native.ts'
import { validateExternalEditResult, type ExternalEditIntent } from './message-edit-external.ts'

export interface ExternalEditChoice {
  seq: number
  text: string
  boundaryId: string
  turnIndex: number
}

/** An allocated prefix with no admitted replacement can be resumed by a new explicit edit. */
export function externalPreparedChoice(
  record: HarnessSession,
  intent: ExternalEditIntent | undefined,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): { seq: number; text: string } | undefined {
  if (
    intent?.phase !== 'ready' ||
    !intent.result ||
    intent.recordId !== record.id ||
    intent.sessionId !== record.nativeSessionId ||
    intent.result.sessionId !== record.acpSessionId ||
    record.turns.length !== intent.result.retained.length ||
    record.turns.some(
      (turn, index) => turn.native?.userMessageId !== intent.result!.retained[index]?.nextId,
    )
  )
    return
  const users = readNativeUserMessages(events)
  if (users.some((message) => message.rpcId === intent.requestId)) return
  const active = users.filter((message) => activeSeqs.has(message.seq))
  // Older journals lack the native target. A sole visible input and a confirmed empty
  // vendor prefix need no identity mapping or further rewind to start that input afresh.
  if (
    intent.targetSeq === undefined &&
    (intent.result.retained.length ||
      intent.expected.boundaries.length !== 1 ||
      active.length !== 1)
  )
    return
  const matches = active.filter(
    (message) =>
      (intent.targetSeq === undefined || message.seq === intent.targetSeq) &&
      editableNativeMessage(message),
  )
  return matches.length === 1 ? { seq: matches[0]!.seq, text: matches[0]!.text } : undefined
}

/** A committed native replacement can retry when admission never created a vendor turn. */
export function externalUnsentAdmissionChoice(
  record: HarnessSession,
  intent: ExternalEditIntent | undefined,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): { seq: number; text: string } | undefined {
  if (
    intent?.phase !== 'admitting' ||
    !intent.result ||
    intent.recordId !== record.id ||
    intent.sessionId !== record.nativeSessionId ||
    intent.result.sessionId !== record.acpSessionId ||
    record.turns.length !== intent.result.retained.length ||
    record.turns.some(
      (turn, index) =>
        !['completed', 'failed', 'cancelled'].includes(turn.state) ||
        !turn.native?.userMessageId ||
        turn.native.userMessageId !== intent.result!.retained[index]?.nextId,
    )
  )
    return
  const matches = readNativeUserMessages(events).filter(
    (message) => message.rpcId === intent.requestId,
  )
  const message = matches.length === 1 ? matches[0] : undefined
  if (!message || !activeSeqs.has(message.seq) || !editableNativeMessage(message)) return
  return { seq: message.seq, text: message.text }
}

/** Match an unappended native replacement already verified by the native transaction journal. */
export function externalUnsentNativeRecovery(
  record: HarnessSession,
  intent: ExternalEditIntent | undefined,
  recovery: MessageEditSend | undefined,
): boolean {
  return Boolean(
    intent?.phase === 'admitting' &&
    intent.result &&
    intent.recordId === record.id &&
    intent.sessionId === record.nativeSessionId &&
    intent.result.sessionId === record.acpSessionId &&
    recovery?.prompt.sessionId === intent.sessionId &&
    recovery.prompt.requestId === intent.requestId &&
    (intent.targetSeq === undefined || intent.targetSeq === recovery.targetSeq) &&
    record.turns.length === intent.result.retained.length &&
    record.turns.every(
      (turn, index) =>
        ['completed', 'failed', 'cancelled'].includes(turn.state) &&
        turn.native?.userMessageId &&
        turn.native.userMessageId === intent.result!.retained[index]?.nextId,
    ),
  )
}

/** An empty fork with no vendor send can be replaced explicitly even if its file was never created. */
export function externalUnsentEmptyChoice(
  record: HarnessSession,
  intent: ExternalEditIntent | undefined,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): { seq: number; text: string } | undefined {
  const turn = record.turns[0]
  if (
    !intent?.result?.ephemeral ||
    intent.phase !== 'admitting' ||
    intent.result.retained.length ||
    intent.recordId !== record.id ||
    intent.sessionId !== record.nativeSessionId ||
    intent.result.sessionId !== record.acpSessionId ||
    record.turns.length !== 1 ||
    !turn ||
    turn.state !== 'failed' ||
    turn.native?.userMessageId ||
    turn.operationId !== 'message-edit:' + intent.requestId
  )
    return
  const messages = readNativeUserMessages(events).filter(
    (message) =>
      activeSeqs.has(message.seq) &&
      (turn.native?.officialSeq === undefined || message.seq === turn.native.officialSeq) &&
      message.rpcId === intent.requestId &&
      editableNativeMessage(message),
  )
  return messages.length === 1 ? { seq: messages[0]!.seq, text: messages[0]!.text } : undefined
}

/** Recover a terminal external failure from the exact persisted vendor input identity. */
export function externalTerminalFailureChoice(
  record: HarnessSession,
  intent: ExternalEditIntent | undefined,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): { seq: number; text: string } | undefined {
  const turn = record.turns.at(-1)
  if (
    !intent?.result ||
    intent.phase !== 'settled' ||
    intent.recordId !== record.id ||
    intent.sessionId !== record.nativeSessionId ||
    intent.result.sessionId !== record.acpSessionId ||
    !turn ||
    turn.state !== 'failed' ||
    turn.stopReason !== 'error_response' ||
    !turn.native?.userMessageId ||
    turn.operationId !== 'message-edit:' + intent.requestId
  )
    return
  const matches = readNativeUserMessages(events).filter(
    (message) =>
      activeSeqs.has(message.seq) &&
      message.rpcId === intent.requestId &&
      (turn.native?.officialSeq === undefined || message.seq === turn.native.officialSeq) &&
      editableNativeMessage(message),
  )
  return matches.length === 1 ? { seq: matches[0]!.seq, text: matches[0]!.text } : undefined
}

/** Recover a missing vendor input id only from its durable exact request receipt. */
export function externalReceivedInput(
  record: HarnessSession,
  history: ExternalEditHistory,
  intent: ExternalEditIntent | undefined,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): string | undefined {
  const turn = record.turns.at(-1)
  if (
    !intent?.result ||
    !['prompting', 'settled', 'uncertain'].includes(intent.phase) ||
    intent.recordId !== record.id ||
    intent.sessionId !== record.nativeSessionId ||
    intent.result.sessionId !== record.acpSessionId ||
    history.sessionId !== record.acpSessionId ||
    !turn ||
    !['failed', 'cancelled'].includes(turn.state) ||
    turn.operationId !== 'message-edit:' + intent.requestId ||
    turn.native?.userMessageId ||
    turn.native?.officialSeq === undefined ||
    record.turns.length !== intent.result.retained.length + 1 ||
    history.boundaries.length !== record.turns.length ||
    new Set(history.boundaries.map((boundary) => boundary.id)).size !== history.boundaries.length ||
    record.turns
      .slice(0, -1)
      .some(
        (prior, index) =>
          !prior.native?.userMessageId ||
          prior.native.userMessageId !== intent.result!.retained[index]?.nextId ||
          prior.native.userMessageId !== history.boundaries[index]?.id,
      )
  )
    return
  const messages = readNativeUserMessages(events).filter(
    (message) => message.rpcId === intent.requestId,
  )
  if (
    messages.length !== 1 ||
    messages[0]!.seq !== turn.native.officialSeq ||
    !activeSeqs.has(messages[0]!.seq) ||
    !editableNativeMessage(messages[0]!)
  )
    return
  const receipts = history.receivedInputs?.filter((entry) => entry.requestId === intent.requestId)
  const receipt = receipts?.length === 1 ? receipts[0] : undefined
  if (!receipt?.inputId || receipt.inputId !== history.boundaries.at(-1)?.id) return
  return receipt.inputId
}

/** Confirm a failed replacement using its journal, official request and complete vendor prefix. */
export function externalEditRecovery(
  record: HarnessSession,
  history: ExternalEditHistory,
  intent: ExternalEditIntent | undefined,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): { kind: 'settled' } | { kind: 'unsent'; choice: { seq: number; text: string } } | undefined {
  if (
    !intent?.result ||
    intent.sessionId !== record.nativeSessionId ||
    intent.recordId !== record.id ||
    intent.result.sessionId !== record.acpSessionId ||
    history.sessionId !== record.acpSessionId
  )
    return
  const turn = record.turns.at(-1)
  if (
    !turn ||
    !['failed', 'cancelled'].includes(turn.state) ||
    turn.operationId !== 'message-edit:' + intent.requestId ||
    record.turns.length !== intent.result.retained.length + 1
  )
    return
  const messages = readNativeUserMessages(events).filter(
    (message) =>
      activeSeqs.has(message.seq) &&
      message.seq === turn.native?.officialSeq &&
      message.rpcId === intent.requestId &&
      editableNativeMessage(message),
  )
  if (messages.length !== 1) return
  const prefix = record.turns.slice(0, -1).map((item) => item.native?.userMessageId)
  if (
    prefix.some((id, index) => !id || id !== intent.result!.retained[index]?.nextId) ||
    new Set(history.boundaries.map((item) => item.id)).size !== history.boundaries.length ||
    prefix.some((id, index) => id !== history.boundaries[index]?.id)
  )
    return
  if (
    ['admitting', 'settled'].includes(intent.phase) &&
    !turn.native?.userMessageId &&
    history.boundaries.length === prefix.length
  )
    return { kind: 'unsent', choice: { seq: messages[0]!.seq, text: messages[0]!.text } }
  const inputId = turn.native?.userMessageId
  if (
    ['prompting', 'settled'].includes(intent.phase) &&
    !inputId &&
    !prefix.length &&
    history.boundaries.length === 1 &&
    history.settledInputId === history.boundaries[0]!.id
  )
    return { kind: 'settled' }
  if (
    ['prompting', 'settled', 'uncertain'].includes(intent.phase) &&
    inputId &&
    history.boundaries.length === prefix.length + 1 &&
    history.boundaries.at(-1)?.id === inputId &&
    (turn.stopReason === 'error_response' || history.settledInputId === inputId)
  )
    return { kind: 'settled' }
}

/** Only exact, unique identities present in both active histories can be edited. */
export function externalEditChoices(
  record: HarnessSession,
  history: ExternalEditHistory,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): ExternalEditChoice[] {
  if (record.acpSessionId !== history.sessionId) return []
  const boundaries = new Map(history.boundaries.map((boundary) => [boundary.id, boundary]))
  if (boundaries.size !== history.boundaries.length) return []
  const messages = readNativeUserMessages(events).filter((message) => activeSeqs.has(message.seq))
  const nativeIds = record.turns.map((turn) => turn.native?.userMessageId).filter(Boolean)
  if (new Set(nativeIds).size !== nativeIds.length) return []
  const choices: ExternalEditChoice[] = []
  for (const [turnIndex, turn] of record.turns.entries()) {
    const id = turn.native?.userMessageId
    const boundary = id ? boundaries.get(id) : undefined
    if (!boundary || boundary.unavailableReason) continue
    if (
      history.boundaries[turnIndex]?.id !== id ||
      record.turns
        .slice(0, turnIndex)
        .some(
          (prior, index) =>
            !prior.native?.userMessageId ||
            prior.native.userMessageId !== history.boundaries[index]?.id,
        )
    )
      continue
    const requestIds = turnRequestIds(record, turn)
    const matches = messages.filter((message) =>
      turn.native?.officialSeq !== undefined
        ? message.seq === turn.native.officialSeq
        : message.rpcId !== undefined && requestIds.includes(message.rpcId),
    )
    if (matches.length !== 1) continue
    const message = matches[0]!
    if (!editableNativeMessage(message)) continue
    const images = turn.promptContent?.filter((part) => part.type === 'image').length ?? 0
    if ((boundary.imageCount ?? 0) !== images) continue
    if (message.attachments.length && !images) continue
    choices.push({ seq: message.seq, text: message.text, boundaryId: boundary.id, turnIndex })
  }
  const counts = new Map<number, number>()
  for (const choice of choices) counts.set(choice.seq, (counts.get(choice.seq) ?? 0) + 1)
  return choices.filter((choice) => counts.get(choice.seq) === 1)
}

/** Display saved exact input identities without launching a CLI or admitting a model request. */
export function externalRecordedChoices(
  record: HarnessSession,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): ExternalEditChoice[] {
  return externalEditChoices(
    record,
    {
      sessionId: record.acpSessionId,
      token: 'recorded-inputs',
      boundaries: record.turns.flatMap((turn) =>
        turn.native?.userMessageId
          ? [
              {
                id: turn.native.userMessageId,
                ...(record.harnessRef !== 'grok-build' && turn.promptContent
                  ? {
                      imageCount: turn.promptContent.filter((part) => part.type === 'image').length,
                    }
                  : {}),
              },
            ]
          : [],
      ),
    },
    events,
    activeSeqs,
  )
}

/** An unbound first input can start a fresh vendor session because it retains no vendor prefix. */
export function externalFreshFirstChoice(
  record: HarnessSession,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): { seq: number; text: string } | undefined {
  const turn = record.turns[0]
  if (!record.acpSessionId || !turn || turn.native?.userMessageId) return
  const messages = readNativeUserMessages(events).filter((message) => activeSeqs.has(message.seq))
  const first = messages[0]
  if (!first || !editableNativeMessage(first)) return
  const matches = messages.filter((message) =>
    turn.native?.officialSeq !== undefined
      ? message.seq === turn.native.officialSeq
      : message.rpcId !== undefined && turnRequestIds(record, turn).includes(message.rpcId),
  )
  if (matches.length !== 1 || matches[0]!.seq !== first.seq) return
  return { seq: first.seq, text: first.text }
}

/** Prepare a new binding in memory; the owner persists it only after the vendor result journal. */
export function externalEditedRecord(
  record: HarnessSession,
  history: ExternalEditHistory,
  targetId: string,
  result: ExternalEditResult,
): HarnessSession {
  validateExternalEditResult(history, targetId, result)
  const target = record.turns.findIndex((turn) => turn.native?.userMessageId === targetId)
  if (target < 0 || record.acpSessionId !== history.sessionId)
    throw Error('编辑目标未绑定到当前会话')
  const retained = record.turns.slice(0, target)
  if (
    retained.length !== result.retained.length ||
    retained.some(
      (turn, index) => turn.native?.userMessageId !== result.retained[index]!.previousId,
    )
  )
    throw Error('编辑后的轮次映射不一致')
  const next = structuredClone(record)
  next.acpSessionId = result.sessionId
  next.turns = structuredClone(retained).map((turn, index) => ({
    ...turn,
    native: { ...turn.native, userMessageId: result.retained[index]!.nextId },
  }))
  return next
}
