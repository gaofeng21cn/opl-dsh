/**
 * Pool message-edit driver.
 *
 * Pool exposes one official ACP extension for history mutation:
 * `_poolside/session_rewind { sessionId, eventId }`, where `eventId` is the exact
 * `poolside/inputEventId` the agent reported for a user turn. The driver never derives an
 * identity from text, ordinal or a count: a turn without that exact native id makes the
 * whole history unverifiable and blocks the edit.
 *
 * After a rewind the agent answers `{}`, which only says the request was handled. The driver
 * therefore forces a `session/load` replay and waits for the shared owner's turn mapping to
 * show exactly the retained prefix. If that verification does not arrive, the result is
 * uncertain and is thrown, never reported as success.
 *
 * It never sends a replacement prompt, writes a HarnessSession, edits DSH history, reverts
 * files or deletes an old branch.
 */
import { createHash } from 'node:crypto'
import { POOL_HARNESS } from './adapters/pool/pool-models.ts'
import type { HarnessSession } from '../contracts/sessions.ts'
import {
  ExternalMessageEditError,
  type ExternalMessageEditFailure,
} from './message-edit-opencode-common.ts'
import type {
  ExternalEditBoundary,
  ExternalEditContext,
  ExternalEditHistory,
  ExternalEditResult,
  ExternalMessageEditDriver,
} from './message-edit-driver.ts'

const REWIND_METHOD = '_poolside/session_rewind'
const REWIND_TIMEOUT_MS = 30_000

const BUSY_STATES = new Set([
  'queued',
  'waiting_child',
  'running',
  'waiting_approval',
  'waiting_input',
])

const object = (value: unknown): Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}

const string = (value: unknown): string => (typeof value === 'string' ? value : '')

function failure(code: ExternalMessageEditFailure): ExternalMessageEditError {
  return new ExternalMessageEditError(code)
}

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw failure('aborted')
}

function canonical(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort)
    if (input && typeof input === 'object') {
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        const next = (input as Record<string, unknown>)[key]
        if (next !== undefined) result[key] = sort(next)
      }
      return result
    }
    return input
  }
  return JSON.stringify(sort(value))
}

function historyToken(
  sessionId: string,
  boundaries: readonly ExternalEditBoundary[],
  record: Readonly<HarnessSession>,
): string {
  return `sha256:${createHash('sha256')
    .update(
      canonical({
        version: 1,
        sessionId,
        boundaries: boundaries.map((boundary) => ({
          id: boundary.id,
          text: boundary.text ?? '',
          unavailableReason: boundary.unavailableReason ?? '',
        })),
        operations: record.turns.map((turn) => turn.operationId),
      }),
    )
    .digest('hex')}`
}

/**
 * Boundaries are the exact `poolside/inputEventId` values the owner recorded for each
 * prompt. A missing id is not skipped: it means the vendor history is only partially
 * mapped, and a count/ordinal substitution is forbidden.
 */
function boundariesOf(record: Readonly<HarnessSession>): ExternalEditBoundary[] {
  const boundaries: ExternalEditBoundary[] = []
  const seen = new Set<string>()
  for (const turn of record.turns) {
    const id = string(turn.native?.userMessageId)
    if (!id) throw failure('protocol')
    if (seen.has(id)) throw failure('protocol')
    seen.add(id)
    const text = string(turn.prompt)
    boundaries.push({ id, ...(text.length > 0 ? { text } : {}) })
  }
  return boundaries
}

function assertIdle(record: Readonly<HarnessSession>): void {
  for (const turn of record.turns) if (BUSY_STATES.has(turn.state)) throw failure('busy')
}

function ensureHarness(context: ExternalEditContext): string {
  if (context.record.harnessRef !== POOL_HARNESS) throw failure('unsupported')
  const sessionId = string(context.record.acpSessionId)
  if (!sessionId) throw failure('stale')
  return sessionId
}

/** The agent must advertise the exact extension this driver calls. */
function assertCapability(context: ExternalEditContext): void {
  const agent = object(context.snapshot().agent)
  const capabilities = object(agent.agentCapabilities)
  const meta = object(capabilities._meta)
  if (meta['poolside/rewind'] !== true) throw failure('unsupported')
}

interface ObservedHistory {
  sessionId: string
  token: string
  boundaries: ExternalEditBoundary[]
}

function observe(context: ExternalEditContext): ObservedHistory {
  const sessionId = ensureHarness(context)
  assertCapability(context)
  ensureActive(context.signal)
  assertIdle(context.record)
  const boundaries = boundariesOf(context.record)
  return { sessionId, token: historyToken(sessionId, boundaries, context.record), boundaries }
}

/**
 * Pool driver factory. The capability check is live on every call; an agent that does not
 * advertise `poolside/rewind` is reported as unsupported rather than attempted.
 */
export function poolMessageEditDriver(): ExternalMessageEditDriver {
  return {
    async read(context): Promise<ExternalEditHistory> {
      const observed = observe(context)
      ensureActive(context.signal)
      return {
        sessionId: observed.sessionId,
        token: observed.token,
        boundaries: observed.boundaries,
      }
    },

    async rewind(context, input): Promise<ExternalEditResult> {
      ensureActive(context.signal)
      if (!string(input.operationId) || !string(input.targetId)) throw failure('target-unknown')
      const observed = observe(context)
      if (input.expected.sessionId !== observed.sessionId) throw failure('stale')
      if (input.expected.token !== observed.token) throw failure('history-changed')
      const targetIndex = observed.boundaries.findIndex(
        (boundary) => boundary.id === input.targetId,
      )
      if (targetIndex < 0) throw failure('target-unknown')
      const target = observed.boundaries[targetIndex]!
      if (target.unavailableReason) throw failure('target-unavailable')

      if (!context.replayHistory) throw failure('unsupported')
      let result: unknown
      try {
        result = await context
          .transport()
          .request(
            REWIND_METHOD,
            { sessionId: observed.sessionId, eventId: input.targetId },
            REWIND_TIMEOUT_MS,
          )
      } catch {
        // A JSON-RPC error does not distinguish "not applied" from "already applied";
        // both are uncertain and must block sends until history is re-read.
        if (context.signal.aborted) throw failure('aborted')
        throw failure('uncertain')
      }
      if (typeof result !== 'object' || result === null || Array.isArray(result))
        throw failure('uncertain')
      if (context.signal.aborted) throw failure('uncertain')

      const retained = observed.boundaries.slice(0, targetIndex)
      let after: ExternalEditHistory
      try {
        after = await context.replayHistory()
      } catch {
        throw failure('uncertain')
      }
      if (
        context.signal.aborted ||
        after.sessionId !== observed.sessionId ||
        after.boundaries.length !== retained.length ||
        retained.some(
          (item, index) =>
            item.id !== after.boundaries[index]?.id || item.text !== after.boundaries[index]?.text,
        )
      )
        throw failure('uncertain')
      return {
        sessionId: observed.sessionId,
        retained: retained.map((boundary) => ({
          previousId: boundary.id,
          nextId: boundary.id,
        })),
      }
    },
  }
}
