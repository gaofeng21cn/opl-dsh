/**
 * Kimi Code message-edit driver.
 *
 * Kimi's ACP surface has no history rewind. The official local server does:
 * `POST /api/v1/sessions/{id}:undo {count}` with the exact user-anchor transcript at
 * `GET /api/v1/sessions/{id}/transcript/user-messages`. The driver therefore uses the
 * shared owner's sequential lifecycle:
 *
 *   disconnect ACP → start authenticated local web server → read/undo → close server →
 *   reconnect ACP
 *
 * The server is started by `./adapters/kimi/kimi-edit-control.ts`, which reuses the
 * adapter's suite-owned profile, uses the printed bearer token (never
 * `--dangerous-bypass-auth`) and suppresses the provider-model catalog refresh through the
 * official public environment controls. It never reads or rewrites a credential.
 *
 * The undo count is derived only from the official user anchors: user prompts, user-slash
 * skill/plugin activations and shell input. A partial list, an unknown anchor or a
 * compaction boundary refuses the edit; text, ordinal or count inference is never used.
 */
import { createHash } from 'node:crypto'
import { KIMI_HARNESS } from './adapters/kimi/kimi-models.ts'
import {
  startKimiControl,
  type KimiControl,
  type KimiUserMessage,
} from './adapters/kimi/kimi-edit-control.ts'
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

const BUSY_STATES = new Set(['queued', 'running', 'waiting_approval', 'waiting_input'])

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

function ensureHarness(context: ExternalEditContext): string {
  if (context.record.harnessRef !== KIMI_HARNESS) throw failure('unsupported')
  const sessionId = string(context.record.acpSessionId)
  if (!sessionId) throw failure('stale')
  return sessionId
}

function assertIdle(record: Readonly<HarnessSession>): void {
  for (const turn of record.turns) if (BUSY_STATES.has(turn.state)) throw failure('busy')
}

/** The engine's undo anchor vocabulary, read from the official transcript origin. */
function isUndoAnchor(origin: Record<string, any>): boolean {
  const kind = string(origin.kind)
  if (!kind || kind === 'user') return true
  if (kind === 'skill_activation' || kind === 'plugin_command')
    return string(origin.trigger) === 'user-slash'
  if (kind === 'shell_command') return string(origin.phase) === 'input'
  return false
}

interface Anchors {
  readonly all: readonly KimiUserMessage[]
  readonly token: string
}

function anchorsOf(sessionId: string, messages: readonly KimiUserMessage[]): Anchors {
  const all = messages.filter((message) => isUndoAnchor(message.origin))
  const token = `sha256:${createHash('sha256')
    .update(
      canonical({
        version: 1,
        sessionId,
        anchors: all.map((message) => ({
          turnId: message.turnId,
          ordinal: message.ordinal,
          prompt: message.prompt,
          state: message.state,
          origin: {
            kind: string(message.origin.kind),
            trigger: string(message.origin.trigger),
            phase: string(message.origin.phase),
          },
          attachmentIds: message.attachmentIds,
        })),
      }),
    )
    .digest('hex')}`
  return { all, token }
}

function boundaryOf(message: KimiUserMessage): ExternalEditBoundary {
  const text = message.prompt
  const unavailable = text.trim().length === 0 ? '这条消息没有可编辑文本' : undefined
  return {
    id: message.turnId,
    ...(text.length > 0 ? { text } : {}),
    ...(unavailable ? { unavailableReason: unavailable } : {}),
  }
}

/**
 * One sequential control lifecycle. `reconnect` is always attempted; a reconnect failure
 * after a mutation is uncertain, never a clean failure.
 */
async function withControl<T>(
  context: ExternalEditContext,
  sessionId: string,
  run: (control: KimiControl) => Promise<T>,
): Promise<T> {
  let control: KimiControl | undefined
  let primary: unknown
  let result: T | undefined
  try {
    await context.disconnect()
    control = await startKimiControl({
      launch: context.launch,
      cwd: context.record.cwd,
      signal: context.signal,
    })
    result = await run(control)
  } catch (error) {
    primary = error
  } finally {
    await control?.close()
    try {
      await context.reconnect(sessionId)
    } catch {
      if (!primary) primary = failure('uncertain')
    }
  }
  if (primary) throw primary
  return result as T
}

/**
 * Kimi driver factory. The capability is not advertised by ACP; the shared owner selects
 * this driver for the Kimi harness and must not expose an entry before `read` succeeds.
 */
export function kimiMessageEditDriver(): ExternalMessageEditDriver {
  return {
    async read(context): Promise<ExternalEditHistory> {
      const sessionId = ensureHarness(context)
      ensureActive(context.signal)
      assertIdle(context.record)
      return await withControl(context, sessionId, async (control) => {
        const messages = await control.readUserMessages(sessionId)
        const anchors = anchorsOf(sessionId, messages)
        for (const anchor of anchors.all) if (BUSY_STATES.has(anchor.state)) throw failure('busy')
        ensureActive(context.signal)
        return {
          sessionId,
          token: anchors.token,
          boundaries: anchors.all.map(boundaryOf),
        }
      })
    },

    async rewind(context, input): Promise<ExternalEditResult> {
      const sessionId = ensureHarness(context)
      ensureActive(context.signal)
      if (!string(input.operationId) || !string(input.targetId)) throw failure('target-unknown')
      if (!input.expected || input.expected.sessionId !== sessionId) throw failure('stale')
      assertIdle(context.record)

      return await withControl(context, sessionId, async (control) => {
        const before = anchorsOf(sessionId, await control.readUserMessages(sessionId))
        if (before.token !== input.expected.token) throw failure('history-changed')
        const index = before.all.findIndex((anchor) => anchor.turnId === input.targetId)
        if (index < 0) throw failure('target-unknown')
        const target = before.all[index]!
        const boundary = boundaryOf(target)
        if (boundary.unavailableReason) throw failure('target-unavailable')
        const expected = input.expected.boundaries.find((item) => item.id === input.targetId)
        if (!expected) throw failure('target-unknown')
        if ((expected.text ?? '') !== (boundary.text ?? '')) throw failure('history-changed')
        ensureActive(context.signal)

        // Count only official user anchors from the target to the tail (inclusive).
        const count = before.all.length - index
        let undo
        try {
          undo = await control.undo(sessionId, count)
        } catch (error) {
          // The request may already have reached the engine; an aborted transport is
          // uncertain, never a clean cancellation.
          if (context.signal.aborted) throw failure('uncertain')
          throw error
        }
        if (undo.status === 401 || undo.status === 403) throw failure('control-unavailable')
        if (undo.status < 200 || undo.status >= 300) throw failure('uncertain')
        const body = object(undo.body)
        const code = body.code
        if (code !== 0) {
          if (code === 40911) {
            const reason = string(object(body.data).reason)
            // The precheck refuses before mutation. A compaction boundary is a real
            // restriction; an insufficient/empty count means the official anchor list and
            // the engine disagree, so the mapping is unverified.
            if (reason === 'compaction_boundary') throw failure('target-unavailable')
            throw failure('protocol')
          }
          throw failure('uncertain')
        }
        if (context.signal.aborted) throw failure('uncertain')

        const after = anchorsOf(sessionId, await control.readUserMessages(sessionId))
        const retained = before.all.slice(0, index)
        if (after.all.length !== retained.length) throw failure('uncertain')
        for (let position = 0; position < retained.length; position += 1) {
          const previous = retained[position]!
          const next = after.all[position]!
          if (next.turnId !== previous.turnId) throw failure('uncertain')
          if (next.prompt !== previous.prompt) throw failure('uncertain')
          if (next.state !== previous.state) throw failure('uncertain')
          if (next.attachmentIds.length !== previous.attachmentIds.length)
            throw failure('uncertain')
          for (let item = 0; item < previous.attachmentIds.length; item += 1)
            if (next.attachmentIds[item] !== previous.attachmentIds[item])
              throw failure('uncertain')
        }
        return {
          sessionId,
          retained: retained.map((anchor) => ({
            previousId: anchor.turnId,
            nextId: anchor.turnId,
          })),
        }
      })
    },
  }
}
