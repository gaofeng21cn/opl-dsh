/**
 * The exact facts of one external-Harness permission ask.
 *
 * An external ACP/CLI Harness runs its own agent loop, so its tool calls never
 * pass through the native `tools/pre-execute` gate; what reaches this Host is its
 * own permission ask. That ask carries a structured `toolCall` and nothing else —
 * the ACP transport does not know about turns, connections or authorization — so
 * those facts are composed here from the live connection record, never parsed
 * out of the ask's prose.
 *
 *  - `name` is read from the ask's explicit OPL extension slot, never from the
 *    human-facing `title`;
 *  - `parameters` is the ask's `rawInput` verbatim;
 *  - an ask without both is **not bindable**, and a caller must then leave it to
 *    the ordinary human approval chain instead of reviewing a guess.
 *
 * This module deliberately imports nothing: the OPL ZCode bridge runs in its own
 * process and imports the same extension key, so it must stay dependency-free.
 */

/** Read a JSON object member without trusting its shape. */
function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * OPL-internal `_meta` key that carries the external tool name.
 *
 * `_meta` is the ACP extension slot the protocol reserves for exactly this; the
 * OPL ZCode bridge sets it from the official request's `toolName`, and the host
 * reads it back without ever decoding the ask's display text.
 */
export const EXTERNAL_TOOL_NAME_META = 'opl/toolName'

/** The structured action of one external permission ask. */
export interface HarnessExternalAsk {
  /** ACP tool-call identity the ask carries, when the Harness supplied one. */
  readonly toolCallId?: string
  readonly name: string
  readonly parameters: unknown
}

/**
 * Read the structured action out of one ACP `session/request_permission`
 * `toolCall`, or refuse it.
 *
 * A missing, empty or non-string tool name, a missing `rawInput`, and a
 * `rawInput` that is not serializable all yield `undefined`: the caller must
 * treat that as "not reviewable" rather than as a tool with no arguments.
 * @param toolCall - the raw `toolCall` member of the permission request.
 * @returns the structured action, or undefined when it is not exactly bindable.
 */
export function externalAskFromToolCall(toolCall: unknown): HarnessExternalAsk | undefined {
  const call = object(toolCall)
  const name = object(call['_meta'])[EXTERNAL_TOOL_NAME_META]
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return undefined
  if (!Object.hasOwn(call, 'rawInput')) return undefined
  const parameters = call['rawInput']
  try {
    if (JSON.stringify(parameters) === undefined) return undefined
  } catch {
    return undefined
  }
  const toolCallId = call['toolCallId']
  return {
    name,
    parameters,
    ...(typeof toolCallId === 'string' && toolCallId.length > 0 ? { toolCallId } : {}),
  }
}

/** Where one external ask's authority comes from. */
export interface HarnessExternalAuthorization {
  /** The native Session that owns the Harness conversation. */
  readonly sessionId: string
  /** That Session's live permission preset at binding time. */
  readonly preset: string
  /** The Harness task's own authorized filesystem boundary. */
  readonly sandbox: string
  /** The combination the Harness task was started with. */
  readonly combination: string
}

/**
 * The complete binding of one pending external permission ask.
 *
 * Every member is an exact fact read from the live connection record; a review
 * that cannot obtain all of them is refused rather than approximated.
 */
export interface HarnessExternalApprovalBinding {
  readonly harness: string
  /** Native approval identity of this exact pending ask. */
  readonly callId: string
  readonly acpSessionId: string
  /** Monotonic generation of the connection that owns the ask. */
  readonly generation: number
  /** 1-based index of the owning Harness turn inside its record. */
  readonly turn: number
  /** The owning turn's stable operation identity. */
  readonly turnId: string
  readonly action: { readonly name: string; readonly parameters: unknown }
  readonly authorization: HarnessExternalAuthorization
}
