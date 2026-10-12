/** Same-conversation editing; selection is read-only until the normal composer sends. */
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller/types'

export interface MessageEditChoice {
  seq: number
  text: string
}
export interface MessageEditState {
  sessionId: string
  supported: boolean
  busy: boolean
  head: number
  pending: boolean
  /** Exact durable input for an explicit retry; never submitted by a state read. */
  recovery?: MessageEditSend
  choices: MessageEditChoice[]
}
export interface MessageEditSend {
  prompt: SessionPromptRequest
  targetSeq: number
  head: number
}
/** Stored in an existing system/message source, never sent as model text. */
export interface MessageEditMarker {
  version: 1
  start: number
  end: number
  requestId: string
  digest: string
}
export const MESSAGE_EDIT_SOURCE = 'oplMessageEdit'

/** Read an OPL marker from durable or wire source metadata. */
export function messageEditMarker(source: unknown): MessageEditMarker | undefined {
  if (!source || typeof source !== 'object' || !(MESSAGE_EDIT_SOURCE in source)) return
  const value = source[MESSAGE_EDIT_SOURCE]
  if (!value || typeof value !== 'object') return
  if (
    !('version' in value) ||
    value.version !== 1 ||
    !('start' in value) ||
    !('end' in value) ||
    !('requestId' in value) ||
    !('digest' in value)
  )
    return
  if (
    typeof value.start !== 'number' ||
    !Number.isSafeInteger(value.start) ||
    value.start < 0 ||
    typeof value.end !== 'number' ||
    !Number.isSafeInteger(value.end) ||
    value.end < value.start ||
    typeof value.requestId !== 'string' ||
    !value.requestId ||
    typeof value.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  )
    return
  return {
    version: 1,
    start: value.start,
    end: value.end,
    requestId: value.requestId,
    digest: value.digest,
  }
}
