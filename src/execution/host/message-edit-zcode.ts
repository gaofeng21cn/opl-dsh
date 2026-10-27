/**
 * ZCode edit driver.
 *
 * ZCode's official `editUserQuery` starts the replacement turn itself, so it is
 * never used here. The driver forks at the assistant immediately before the target
 * (or creates an empty session for the first target) and returns the child identity;
 * the shared owner sends the replacement prompt exactly once. It never writes a
 * HarnessSession, edits DSH history, touches files, or deletes the parent branch.
 */
import type {
  ExternalEditBoundary,
  ExternalEditContext,
  ExternalEditHistory,
  ExternalEditResult,
  ExternalMessageEditDriver,
} from './message-edit-driver.ts'
import {
  ZCODE_EDIT_CAPABILITY,
  ZCODE_EDIT_CODES,
  ZCODE_EDIT_METHODS,
} from './adapters/zcode-protocol.ts'

export const ZCODE_EDIT_ERRORS = {
  unsupported: 'zcode-edit-unsupported',
  historyChanged: 'zcode-edit-history-changed',
  targetUnknown: 'zcode-edit-target-unknown',
  forkMismatch: 'zcode-edit-fork-mismatch',
  vendorRejected: 'zcode-edit-vendor-rejected',
  vendorUncertain: 'zcode-edit-vendor-uncertain',
  protocolInvalid: 'zcode-edit-protocol-invalid',
  aborted: 'zcode-edit-aborted',
} as const

export type ZcodeEditDriverErrorCode = (typeof ZCODE_EDIT_ERRORS)[keyof typeof ZCODE_EDIT_ERRORS]

export class ZcodeEditDriverError extends Error {
  constructor(readonly code: ZcodeEditDriverErrorCode) {
    super(code)
    this.name = 'ZcodeEditDriverError'
  }
}

const isRecord = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const sessionIdOf = (context: ExternalEditContext): string => {
  const id = context.record.acpSessionId
  if (typeof id !== 'string' || !id) throw new ZcodeEditDriverError(ZCODE_EDIT_ERRORS.unsupported)
  return id
}

const assertIdle = (context: ExternalEditContext): void => {
  if (context.signal.aborted) throw new ZcodeEditDriverError(ZCODE_EDIT_ERRORS.aborted)
}

/** Only the bridge's own complete announcement opens the surface. */
export function zcodeEditCapability(
  agent: Record<string, any> | undefined,
): { ready: true } | { ready: false; code: ZcodeEditDriverErrorCode } {
  const announced = agent?._meta?.[ZCODE_EDIT_CAPABILITY]
  if (!isRecord(announced) || announced.version !== 1)
    return { ready: false, code: ZCODE_EDIT_ERRORS.unsupported }
  const methods = Array.isArray(announced.methods) ? announced.methods : []
  if (!methods.includes(ZCODE_EDIT_METHODS.read) || !methods.includes(ZCODE_EDIT_METHODS.fork))
    return { ready: false, code: ZCODE_EDIT_ERRORS.unsupported }
  return { ready: true }
}

function mapVendorCode(code: unknown): ZcodeEditDriverErrorCode {
  switch (code) {
    case ZCODE_EDIT_CODES.targetUnknown:
      return ZCODE_EDIT_ERRORS.targetUnknown
    case ZCODE_EDIT_CODES.historyChanged:
      return ZCODE_EDIT_ERRORS.historyChanged
    case ZCODE_EDIT_CODES.forkMismatch:
      return ZCODE_EDIT_ERRORS.forkMismatch
    case ZCODE_EDIT_CODES.unsupported:
      return ZCODE_EDIT_ERRORS.unsupported
    case ZCODE_EDIT_CODES.vendorRejected:
      return ZCODE_EDIT_ERRORS.vendorRejected
    case ZCODE_EDIT_CODES.vendorUncertain:
      return ZCODE_EDIT_ERRORS.vendorUncertain
    case ZCODE_EDIT_CODES.aborted:
      return ZCODE_EDIT_ERRORS.aborted
    case ZCODE_EDIT_CODES.badRequest:
      return ZCODE_EDIT_ERRORS.protocolInvalid
    default:
      return ZCODE_EDIT_ERRORS.vendorUncertain
  }
}

function parseBoundaries(value: unknown): ExternalEditBoundary[] {
  if (!Array.isArray(value)) throw new ZcodeEditDriverError(ZCODE_EDIT_ERRORS.protocolInvalid)
  return value.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || typeof item.text !== 'string')
      throw new ZcodeEditDriverError(ZCODE_EDIT_ERRORS.protocolInvalid)
    return { id: item.id, text: item.text }
  })
}

function parseRetained(value: unknown): { previousId: string; nextId: string }[] {
  if (!Array.isArray(value)) throw new ZcodeEditDriverError(ZCODE_EDIT_ERRORS.protocolInvalid)
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.previousId !== 'string' ||
      !item.previousId ||
      typeof item.nextId !== 'string' ||
      !item.nextId
    )
      throw new ZcodeEditDriverError(ZCODE_EDIT_ERRORS.protocolInvalid)
    return { previousId: item.previousId, nextId: item.nextId }
  })
}

async function readHistory(context: ExternalEditContext): Promise<ExternalEditHistory> {
  const capability = zcodeEditCapability(context.snapshot().agent)
  if (!capability.ready) throw new ZcodeEditDriverError(capability.code)
  const sessionId = sessionIdOf(context)
  assertIdle(context)
  let response: unknown
  try {
    response = await context.transport().request(ZCODE_EDIT_METHODS.read, { sessionId }, 60_000)
  } catch {
    throw new ZcodeEditDriverError(ZCODE_EDIT_ERRORS.vendorUncertain)
  }
  assertIdle(context)
  if (!isRecord(response)) throw new ZcodeEditDriverError(ZCODE_EDIT_ERRORS.protocolInvalid)
  if (response.ok !== true) throw new ZcodeEditDriverError(mapVendorCode(response.code))
  if (
    typeof response.sessionId !== 'string' ||
    !response.sessionId ||
    typeof response.token !== 'string' ||
    !response.token
  )
    throw new ZcodeEditDriverError(ZCODE_EDIT_ERRORS.protocolInvalid)
  return {
    sessionId: response.sessionId,
    token: response.token,
    boundaries: parseBoundaries(response.boundaries),
  }
}

export const zcodeMessageEditDriver: ExternalMessageEditDriver = {
  async read(context) {
    return readHistory(context)
  },

  async rewind(context, input): Promise<ExternalEditResult> {
    assertIdle(context)
    const capability = zcodeEditCapability(context.snapshot().agent)
    if (!capability.ready) throw new ZcodeEditDriverError(capability.code)
    const sessionId = sessionIdOf(context)
    assertIdle(context)
    const abort = () => {
      // Fire-and-forget: the bridge checks this before its mutation. A failure to
      // deliver the abort does not turn an unknown fork into a success.
      void context
        .transport()
        .request(ZCODE_EDIT_METHODS.abort, { operationId: input.operationId }, 5_000)
        .catch(() => undefined)
    }
    context.signal.addEventListener('abort', abort, { once: true })
    let response: unknown
    try {
      response = await context.transport().request(
        ZCODE_EDIT_METHODS.fork,
        {
          sessionId,
          targetId: input.targetId,
          expectedToken: input.expected.token,
          operationId: input.operationId,
        },
        120_000,
      )
    } catch {
      // The fork may have happened. Never retry or query a command to guess.
      throw new ZcodeEditDriverError(ZCODE_EDIT_ERRORS.vendorUncertain)
    } finally {
      context.signal.removeEventListener('abort', abort)
    }
    if (context.signal.aborted) {
      // If the bridge returned success, the child may already exist: unknown, not
      // a clean abort. If it returned a refusal, no mutation is claimed.
      if (isRecord(response) && response.ok === true)
        throw new ZcodeEditDriverError(ZCODE_EDIT_ERRORS.vendorUncertain)
      throw new ZcodeEditDriverError(ZCODE_EDIT_ERRORS.aborted)
    }
    if (!isRecord(response)) throw new ZcodeEditDriverError(ZCODE_EDIT_ERRORS.protocolInvalid)
    if (response.ok !== true) throw new ZcodeEditDriverError(mapVendorCode(response.code))
    if (typeof response.sessionId !== 'string' || !response.sessionId)
      throw new ZcodeEditDriverError(ZCODE_EDIT_ERRORS.protocolInvalid)
    const retained = parseRetained(response.retained)
    // The shared owner must persist this child identity before it reconnects or
    // binds anything. The driver deliberately does not call disconnect/reconnect:
    // a crash between fork and persistence must leave a durable child id for the
    // owner's invoking journal, not a binding this process already changed.
    return { sessionId: response.sessionId, retained }
  },
}

/** Factory alias for adapter registration. */
export function createZcodeMessageEditDriver(): ExternalMessageEditDriver {
  return zcodeMessageEditDriver
}
