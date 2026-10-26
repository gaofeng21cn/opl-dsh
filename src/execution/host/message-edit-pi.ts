/**
 * Pi message-edit driver.
 *
 * The Pi bridge owns the official `pi --mode rpc` process, so history observation and the
 * boundary fork live in `./adapters/pi/pi-bridge.ts` and are exposed as two private ACP
 * methods (`opl/edit/read`, `opl/edit/rewind`). This file only validates their structured
 * replies and maps them onto the shared driver contract.
 *
 * It never sends a replacement prompt, writes a HarnessSession, edits DSH history, reverts
 * files or deletes an old branch. A first-message fork reports `ephemeral: true` because
 * Pi allocates the session file lazily; the shared owner must not persist that identity as
 * loadable until the replacement prompt has created the file.
 */
import { PI_HARNESS } from './adapters/pi/pi-models.ts'
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

const READ_METHOD = 'opl/edit/read'
const REWIND_METHOD = 'opl/edit/rewind'
const READ_TIMEOUT_MS = 15_000
const REWIND_TIMEOUT_MS = 45_000

const object = (value: unknown): Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}

const string = (value: unknown): string => (typeof value === 'string' ? value : '')

const FAILURE_CODES = new Set<ExternalMessageEditFailure>([
  'unsupported',
  'busy',
  'aborted',
  'stale',
  'history-changed',
  'target-unknown',
  'target-unavailable',
  'control-unavailable',
  'fork-rejected',
  'uncertain',
  'protocol',
])

function failure(code: ExternalMessageEditFailure): ExternalMessageEditError {
  return new ExternalMessageEditError(code)
}

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw failure('aborted')
}

/** Read the structured refusal the bridge returns for an expected edit outcome. */
function refusal(reply: Record<string, any>): ExternalMessageEditError {
  const code = string(reply.code) as ExternalMessageEditFailure
  return failure(FAILURE_CODES.has(code) ? code : 'protocol')
}

function parseBoundaries(value: unknown): ExternalEditBoundary[] {
  if (!Array.isArray(value)) throw failure('protocol')
  const seen = new Set<string>()
  return value.map((raw) => {
    const item = object(raw)
    const id = string(item.id)
    if (!id || seen.has(id)) throw failure('protocol')
    seen.add(id)
    const text = item.text
    if (text !== undefined && typeof text !== 'string') throw failure('protocol')
    const unavailableReason = item.unavailableReason
    if (unavailableReason !== undefined && typeof unavailableReason !== 'string')
      throw failure('protocol')
    return {
      id,
      ...(typeof text === 'string' && text.length > 0 ? { text } : {}),
      ...(typeof unavailableReason === 'string' && unavailableReason.length > 0
        ? { unavailableReason }
        : {}),
    }
  })
}

function parseHistory(value: unknown): ExternalEditHistory {
  const reply = object(value)
  if (reply.ok !== true) throw refusal(reply)
  const sessionId = string(reply.sessionId)
  const token = string(reply.token)
  if (!sessionId || !token) throw failure('protocol')
  const boundaries = parseBoundaries(reply.boundaries)
  const settled = reply.settledInputId
  if (settled !== undefined && (typeof settled !== 'string' || settled !== boundaries.at(-1)?.id))
    throw failure('protocol')
  return {
    sessionId,
    token,
    boundaries,
    ...(typeof settled === 'string' ? { settledInputId: settled } : {}),
  }
}

function parseResult(value: unknown): ExternalEditResult {
  const reply = object(value)
  if (reply.ok !== true) throw refusal(reply)
  const sessionId = string(reply.sessionId)
  if (!sessionId) throw failure('protocol')
  if (!Array.isArray(reply.retained)) throw failure('protocol')
  const seenPrevious = new Set<string>()
  const retained = reply.retained.map((raw) => {
    const item = object(raw)
    const previousId = string(item.previousId)
    const nextId = string(item.nextId)
    if (!previousId || !nextId || seenPrevious.has(previousId)) throw failure('protocol')
    seenPrevious.add(previousId)
    return { previousId, nextId }
  })
  const ephemeral = reply.ephemeral
  if (ephemeral !== undefined && typeof ephemeral !== 'boolean') throw failure('protocol')
  return {
    sessionId,
    retained,
    ...(ephemeral === true ? { ephemeral: true } : {}),
  }
}

function ensureHarness(context: ExternalEditContext): string {
  if (context.record.harnessRef !== PI_HARNESS) throw failure('unsupported')
  const sessionId = string(context.record.acpSessionId)
  if (!sessionId) throw failure('stale')
  return sessionId
}

/** Translate a transport failure without ever echoing provider text. */
function transportFailure(error: unknown, signal: AbortSignal): ExternalMessageEditError {
  if (signal.aborted) return failure('aborted')
  if (error instanceof ExternalMessageEditError) return error
  return failure('uncertain')
}

async function request(
  context: ExternalEditContext,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  ensureActive(context.signal)
  try {
    return await context.transport().request(method, params, timeoutMs)
  } catch (error) {
    throw transportFailure(error, context.signal)
  }
}

/**
 * Pi driver factory. The bridge advertises `opl/edit/*` in its initialize `_meta`; this
 * driver still treats an unsupported/malformed reply as a fixed refusal rather than
 * assuming the capability from the harness name alone.
 */
export function piMessageEditDriver(): ExternalMessageEditDriver {
  return {
    async read(context) {
      const sessionId = ensureHarness(context)
      const value = await request(context, READ_METHOD, { sessionId }, READ_TIMEOUT_MS)
      const history = parseHistory(value)
      if (history.sessionId !== sessionId) throw failure('stale')
      ensureActive(context.signal)
      return history
    },

    async rewind(context, input) {
      const sessionId = ensureHarness(context)
      ensureActive(context.signal)
      if (!string(input.operationId) || !string(input.targetId)) throw failure('target-unknown')
      if (!input.expected || input.expected.sessionId !== sessionId) throw failure('stale')
      const value = await request(
        context,
        REWIND_METHOD,
        {
          sessionId,
          operationId: input.operationId,
          targetId: input.targetId,
          expectedToken: input.expected.token,
        },
        REWIND_TIMEOUT_MS,
      )
      const result = parseResult(value)
      // The bridge already verified the retained prefix against live Pi entries. The
      // driver only re-checks that the identity it returns is not the one being replaced.
      if (result.sessionId === sessionId) throw failure('protocol')
      if (context.signal.aborted) throw failure('uncertain')
      return result
    },
  }
}
