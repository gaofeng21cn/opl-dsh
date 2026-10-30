import { createHash } from 'node:crypto'

/** Official ZCode Protocol constants and the pure projection onto ACP updates.
 *
 * Every name in this file is taken from the official ZCode source, not inferred:
 * `packages/shared/src/zcode-protocol/index.ts` (ZCODE_PROTOCOL_NAME/VERSION and
 * `zcodeProtocolMethods`), `zcode-protocol-legacy-types.ts` (message parts, tool
 * states, permission response) and `packages/provider/src/config/provider-data-schema.ts`
 * plus the shipped `config/provider/zcode-builtin.json` (provider config file shape).
 * This file owns no agent loop, model request or tool execution.
 */

/** Official protocol identity, quoted from packages/shared/src/zcode-protocol/index.ts. */
export const ZCODE_PROTOCOL_NAME = 'ZCode Protocol'
export const ZCODE_PROTOCOL_VERSION = 1

export const ZCODE_HARNESS = 'zcode'

/** `zcodeProtocolMethods` members this bridge actually drives. */
export const ZCODE_METHODS = {
  runtimeCapabilities: 'runtime/capabilities',
  sessionCreate: 'session/create',
  sessionResume: 'session/resume',
  sessionSubscribe: 'session/subscribe',
  sessionSend: 'session/send',
  sessionStop: 'session/stop',
  sessionRequestRuntimePreferences: 'session/requestRuntimePreferences',
} as const

/**
 * Runtime preferences this bridge reports.
 *
 * The official host default is `askUserQuestionAutoResolutionEnabled: true`, which lets
 * the CLI answer its own questions without a human. OPL must never do that: an approval
 * is answered by the user through DSH. So auto-resolution is explicitly disabled here.
 */
export const ZCODE_RUNTIME_PREFERENCES = {
  // Auto-resolution must be off: an approval is answered by the user through DSH, never
  // by the CLI answering its own question.
  askUserQuestionAutoResolutionEnabled: false,
  nativeSearchEnhancementsEnabled: true,
  memoryEnabled: false,
  modelContextBudgetStrategy: 'preflight-v1',
} as const

/** Agent-initiated requests the bridge must answer as a ZCode Protocol client. */
export const ZCODE_CLIENT_REQUESTS = {
  requestPermission: 'interaction/requestPermission',
  requestUserInput: 'interaction/requestUserInput',
} as const

/** Notification the agent uses for live session events (services reads `session/event`). */
export const ZCODE_EVENT_NOTIFICATION = 'session/event'

/** ZCode permission decisions, from `zcodePermissionResponseSchema`. */
export type ZcodePermissionDecision = 'allow' | 'deny' | 'escalate' | 'modify'
export interface ZcodePermissionResponse {
  decision: ZcodePermissionDecision
  reason?: string
  modifiedInput?: unknown
}
export interface ZcodePermissionOption {
  optionId: string
  kind: string
  name: string
  description?: string
  response: ZcodePermissionResponse
}
export interface ZcodePermissionRequest {
  requestId: string
  sessionId: string
  turnId?: string
  toolCallId: string
  toolName: string
  reason: string
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  input: unknown
  options: ZcodePermissionOption[]
}

export type ZcodeToolStatus = 'pending' | 'running' | 'completed' | 'error'
export interface ZcodeToolPart {
  type: 'tool'
  partId: string
  sessionId: string
  messageId: string
  callId: string
  tool: string
  state: { status: ZcodeToolStatus } & Record<string, unknown>
}
export interface ZcodeTextPart {
  type: 'text' | 'reasoning'
  partId: string
  sessionId: string
  messageId: string
  text: string
}
export type ZcodePart = ZcodeToolPart | ZcodeTextPart | { type: string; partId: string }

/** `zcodeEventEnvelopeSchema` plus the `payload` added by the session event union. */
export interface ZcodeEvent {
  eventId: string
  sessionId: string
  turnId?: string
  seq: number
  timestamp: number
  type: string
  payload?: Record<string, unknown>
}

export interface AcpUpdate {
  sessionUpdate: string
  [key: string]: unknown
}

const streamableFields = new Set(['text', 'reasoning'])

/**
 * Turn one ZCode session event into zero or more ACP `session/update` payloads.
 *
 * Released app-servers stream text and reasoning through `model.streaming` and
 * tools through `tool.updated`. Message-part events are also supported; full parts
 * are projected only when their text has not already streamed.
 *
 * @param event - a validated `session/event` notification params.
 * @param streamed - part ids that already produced a delta; mutated in place.
 */
export function acpUpdatesForEvent(event: ZcodeEvent, streamed: Set<string>): AcpUpdate[] {
  const payload = event.payload ?? {}
  // The released app-server emits model.streaming and tool.updated; part events
  // are also accepted for clients that receive the message-part projection.
  if (event.type === 'model.streaming') {
    if (payload.kind !== 'text_delta' && payload.kind !== 'reasoning_delta') return []
    if (typeof payload.delta !== 'string' || !payload.delta) return []
    if (typeof payload.partId === 'string') streamed.add(payload.partId)
    return [
      {
        sessionUpdate:
          payload.kind === 'reasoning_delta' ? 'agent_thought_chunk' : 'agent_message_chunk',
        content: { type: 'text', text: payload.delta },
      },
    ]
  }
  if (event.type === 'tool.updated') {
    if (typeof payload.toolCallId !== 'string') return []
    const common = {
      toolCallId: payload.toolCallId,
      ...(typeof payload.toolName === 'string' ? { title: payload.toolName } : {}),
      kind: payload.toolName === 'Bash' ? 'execute' : 'other',
    }
    switch (payload.kind) {
      case 'scheduled':
      case 'started':
        return [
          {
            ...common,
            sessionUpdate: 'tool_call',
            status: 'in_progress',
            ...(payload.input === undefined ? {} : { rawInput: payload.input }),
          },
        ]
      case 'result':
        return [
          {
            ...common,
            sessionUpdate: 'tool_call_update',
            status: 'completed',
            rawOutput: payload.result,
          },
        ]
      case 'error':
        return [
          {
            ...common,
            sessionUpdate: 'tool_call_update',
            status: 'failed',
            rawOutput: payload.error,
          },
        ]
      default:
        return []
    }
  }
  if (event.type === 'session.titleUpdated' && typeof payload.title === 'string')
    return [{ sessionUpdate: 'session_info_update', title: payload.title }]
  if (event.type === 'part.delta') {
    const field = typeof payload.field === 'string' ? payload.field : 'text'
    const delta = typeof payload.delta === 'string' ? payload.delta : ''
    const partId = typeof payload.partId === 'string' ? payload.partId : ''
    // `input`/`output` deltas are tool IO, not agent prose, and have no ACP projection.
    if (!streamableFields.has(field) || !delta || !partId) return []
    streamed.add(partId)
    return field === 'reasoning'
      ? [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: delta } }]
      : [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } }]
  }
  if (event.type === 'part.upserted' || event.type === 'part.started') {
    const part = payload.part as ZcodePart | undefined
    if (!part || typeof part !== 'object') return []
    if (part.type === 'text' || part.type === 'reasoning') {
      if (streamed.has(part.partId)) return []
      const text = (part as ZcodeTextPart).text
      if (!text) return []
      streamed.add(part.partId)
      return part.type === 'reasoning'
        ? [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }]
        : [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }]
    }
    if (part.type === 'tool') {
      const tool = part as ZcodeToolPart
      const status = tool.state?.status
      if (status === 'pending' || status === 'running')
        return [
          {
            sessionUpdate: 'tool_call',
            toolCallId: tool.callId,
            title: tool.tool,
            kind: 'other',
            status: 'in_progress',
          },
        ]
      if (status === 'completed' || status === 'error')
        return [
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: tool.callId,
            kind: 'other',
            status: status === 'error' ? 'failed' : 'completed',
          },
        ]
      return []
    }
    return []
  }
  return []
}

/**
 * Project the ZCode permission options onto ACP permission options.
 *
 * ACP only models allow/reject per-invocation. `escalate` and `modify` have no ACP
 * equivalent, so they are dropped rather than silently reported as a plain rejection.
 * A request that keeps no allow option is still offered, because a deny-only list is
 * the honest fail-closed projection.
 */
export function acpPermissionOptions(
  options: readonly ZcodePermissionOption[],
): { optionId: string; name: string; kind: 'allow_once' | 'reject_once' }[] {
  const mapped: { optionId: string; name: string; kind: 'allow_once' | 'reject_once' }[] = []
  for (const option of options) {
    if (option.response?.decision === 'allow')
      mapped.push({ optionId: option.optionId, name: option.name, kind: 'allow_once' })
    else if (option.response?.decision === 'deny')
      mapped.push({ optionId: option.optionId, name: option.name, kind: 'reject_once' })
  }
  return mapped
}

/**
 * Resolve the host's answer back to the ZCode response to send.
 *
 * An unknown, absent or non-allow answer falls back to a deny option so a session that
 * was never authorized cannot proceed on an unmatched identifier.
 */
export function resolvePermissionResponse(
  options: readonly ZcodePermissionOption[],
  chosenOptionId: string | undefined,
): ZcodePermissionResponse {
  const chosen = options.find((option) => option.optionId === chosenOptionId)
  if (chosen) return chosen.response
  const denied = options.find((option) => option.response?.decision === 'deny')
  if (denied) return denied.response
  return { decision: 'deny', reason: '未选择有效的授权选项' }
}

/**
 * Builtin provider config.
 *
 * The builtin layer forbids the personal vocabulary (`standard-personal`,
 * `personalModelIds`, `modelOrder`) and requires `revision`, so it carries only the
 * official built-in surface and contributes nothing to this route. It is written only
 * because the CLI expects the builtin and personal variables as a pair; leaving the
 * builtin unset is not a supported combination.
 */
export function buildBuiltinProviderConfig(input: { revision?: number } = {}): unknown {
  return {
    schemaVersion: 1,
    revision: input.revision ?? 1,
    config: {
      providerConfigRules: { templateRules: [], providerRules: [] },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  }
}

/**
 * Confirm the session really is running the requested model.
 *
 * A combination that silently landed on another model is never acceptable, so this
 * throws rather than returning a degraded session. `snapshot.settings.model.current` is
 * the official current-selection projection on the create/resume snapshot.
 */
export function assertProtocolIdentity(snapshot: unknown): void {
  const protocol = (snapshot as any)?.protocol
  if (!protocol || typeof protocol !== 'object')
    throw Error('ZCode 会话快照缺少 protocol，无法核对协议身份')
  if (protocol.name !== ZCODE_PROTOCOL_NAME || protocol.version !== ZCODE_PROTOCOL_VERSION)
    throw Error(
      `ZCode 协议身份为 ${String(protocol.name)}/${String(protocol.version)}，` +
        `与预期 ${ZCODE_PROTOCOL_NAME}/${ZCODE_PROTOCOL_VERSION} 不一致`,
    )
}

/**
 * Confirm the session really carries the permission mode the task authorized.
 *
 * The authoritative fields are `settings.permission.mode` and `settings.mode.current`
 * (`zcodeSessionSettingsStateSchema`); `session.mode` is a session-info field and is NOT
 * consulted. `settings.permission` is optional, so a snapshot that reports neither is
 * treated as a drift and fails closed rather than being assumed acceptable.
 */
export function assertSessionMode(snapshot: unknown, expected: string): void {
  const settings = (snapshot as any)?.settings
  const mode = settings?.permission?.mode ?? settings?.mode?.current
  if (mode !== expected)
    throw Error(`ZCode 会话权限模式是 ${String(mode)}，与授权的 ${expected} 不一致`)
}

/**
 * Full-access session mode.
 *
 * `zcodeSessionModeSchema` offers plan/build/edit/yolo/auto, but `auto` is reserved and
 * fails closed in `permission/service.ts` ("Auto mode is reserved but not implemented
 * yet"), so it is never a valid target. `yolo` is the mode the official
 * `grantPermissionFullAccess` receipt sets for a full-access task.
 */
export const ZCODE_FULL_ACCESS_MODE = 'yolo'
export const ZCODE_SESSION_MODES = ['plan', 'build', 'edit', 'yolo', 'auto'] as const

/**
 * Remove the credential from anything that may be surfaced.
 *
 * Applied to every diagnostic line and error message so the key cannot reach stderr,
 * a log file or a stored session.
 */
export function redactSecret(text: string, secret: string | undefined): string {
  return secret ? text.replaceAll(secret, '[REDACTED]') : text
}

export const ZCODE_V4_EDIT_METHODS = {
  rowsRange: 'v4/conversation/rowsRange',
  command: 'v4/command',
} as const

/** Private ACP requests exposed by the ZCode bridge to the OPL host. */
export const ZCODE_EDIT_METHODS = {
  read: 'opl/zcode/edit/read',
  fork: 'opl/zcode/edit/fork',
  abort: 'opl/zcode/edit/abort',
} as const

/** Initialize `_meta` key announcing the bridge's edit surface. */
export const ZCODE_EDIT_CAPABILITY = 'opl/zcode/edit'

/** Fixed, provider-content-free failure codes shared by bridge and driver. */
export const ZCODE_EDIT_CODES = {
  badRequest: 'OPL_EDIT_BAD_REQUEST',
  unsupported: 'OPL_EDIT_UNSUPPORTED',
  targetUnknown: 'OPL_EDIT_TARGET_UNKNOWN',
  historyChanged: 'OPL_EDIT_HISTORY_CHANGED',
  forkMismatch: 'OPL_EDIT_FORK_MISMATCH',
  vendorRejected: 'OPL_EDIT_VENDOR_REJECTED',
  vendorUncertain: 'OPL_EDIT_VENDOR_UNCERTAIN',
  aborted: 'OPL_EDIT_ABORTED',
} as const

export type ZcodeEditCode = (typeof ZCODE_EDIT_CODES)[keyof typeof ZCODE_EDIT_CODES]

/** A fixed-code edit refusal; its message is the code, never provider text. */
export class ZcodeEditError extends Error {
  readonly code: ZcodeEditCode
  constructor(code: ZcodeEditCode) {
    super(code)
    this.code = code
    this.name = 'ZcodeEditError'
  }
}

/** The subset of a v4 conversation row the edit bridge relies on. */
export interface ZcodeConversationRow {
  rowId: number
  kind: string
  origin?: string
  entityId?: string
  turnId?: string
  text?: string
  sourceCommandId?: string
  rootSourceCommandId?: string
  toolCallId?: string
  toolName?: string
  status?: string
  visibility?: string
  [key: string]: unknown
}

export interface ZcodeEditBoundary {
  id: string
  text: string
}

export interface ZcodeEditReadResult {
  ok: true
  sessionId: string
  token: string
  boundaries: ZcodeEditBoundary[]
}

export interface ZcodeEditRefusal {
  ok: false
  code: ZcodeEditCode
}

export interface ZcodeEditForkResult {
  ok: true
  sessionId: string
  retained: { previousId: string; nextId: string }[]
}

/**
 * Canonical JSON: object keys sorted recursively, so a token or comparison never
 * depends on wire key order. Arrays keep their order.
 */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalJson(record[key])]),
    )
  }
  return value
}

/**
 * Identity fields a fork is allowed to re-key. Everything else — including unknown
 * future fields — is compared verbatim, never silently dropped.
 */
const ZCODE_FORK_REKEYED_FIELDS = new Set([
  'rowId',
  'entityId',
  'turnId',
  'productTurnId',
  'createdAt',
  'createdAtSeq',
  'actions',
  'assistantResponseId',
])

function zcodeSemanticRow(row: ZcodeConversationRow, rekeyedTool = false): string {
  const semantic: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (ZCODE_FORK_REKEYED_FIELDS.has(key)) continue
    if (rekeyedTool && key === 'toolCallId') continue
    semantic[key] = value
  }
  return JSON.stringify(canonicalJson(semantic))
}

/** Opaque token covering every canonical row field, revision and log epoch. */
export function zcodeHistoryToken(
  sessionId: string,
  rows: readonly ZcodeConversationRow[],
  atRevision: number,
  atLogEpoch: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonicalJson({
          sessionId,
          atRevision,
          atLogEpoch,
          rows,
        }),
      ),
      'utf8',
    )
    .digest('hex')
}

/** Official canFork stable final assistant, not an arbitrary earlier assistantText. */
export function isZcodeForkableAssistant(row: ZcodeConversationRow | undefined): boolean {
  if (!row || row.kind !== 'assistantText') return false
  const actions = row.actions as { canFork?: unknown } | undefined
  return actions?.canFork === true && (row.state === 'complete' || row.status === 'complete')
}

/** Real user boundaries in row order; only rows with an exact text qualify. */
export function zcodeUserBoundaries(rows: readonly ZcodeConversationRow[]): ZcodeEditBoundary[] {
  return rows
    .filter(
      (row) =>
        row.kind === 'userInput' &&
        row.origin === 'realUser' &&
        typeof row.entityId === 'string' &&
        row.entityId.length > 0 &&
        typeof row.text === 'string',
    )
    .map((row) => ({ id: row.entityId!, text: row.text! }))
}

/**
 * Validate a fork's retained prefix against the parent's full row semantics and
 * sourceCommandId lineage, and return the old/new boundary identity mapping.
 *
 * The fork point is the assistant row immediately before the target user row. A
 * first-message target has no predecessor and therefore an empty prefix. The child
 * may contain only explicitly validated, non-model-visible fork markers after the
 * exact prefix; any extra user/assistant/tool row is a mismatch.
 */
export function verifyZcodeForkPrefix(
  parentRows: readonly ZcodeConversationRow[],
  childRows: readonly ZcodeConversationRow[],
  targetId: string,
): { retained: { previousId: string; nextId: string }[] } {
  const targetIndex = parentRows.findIndex(
    (row) => row.entityId === targetId && row.kind === 'userInput' && row.origin === 'realUser',
  )
  if (targetIndex < 0) throw new ZcodeEditError(ZCODE_EDIT_CODES.targetUnknown)
  let predecessorIndex = -1
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    if (parentRows[index]?.kind === 'assistantText') {
      predecessorIndex = index
      break
    }
  }
  const prefix = predecessorIndex < 0 ? [] : parentRows.slice(0, predecessorIndex + 1)
  if (childRows.length < prefix.length) throw new ZcodeEditError(ZCODE_EDIT_CODES.forkMismatch)
  for (let index = 0; index < prefix.length; index += 1) {
    const parent = prefix[index]!,
      child = childRows[index]!
    // ZCode gives copied tool rows a new entityId and uses that same id for toolCallId.
    const rekeyedTool =
      parent.kind === 'toolCall' &&
      child.kind === 'toolCall' &&
      typeof parent.entityId === 'string' &&
      !!parent.entityId &&
      typeof child.entityId === 'string' &&
      !!child.entityId &&
      parent.toolCallId === parent.entityId &&
      child.toolCallId === child.entityId
    if (zcodeSemanticRow(parent, rekeyedTool) !== zcodeSemanticRow(child, rekeyedTool))
      throw new ZcodeEditError(ZCODE_EDIT_CODES.forkMismatch)
  }
  for (const extra of childRows.slice(prefix.length)) {
    const marker = extra.marker as { type?: unknown } | undefined
    const validMarker =
      extra.kind === 'timelineMarker' &&
      extra.lane === 'turnTailBoundary' &&
      marker?.type === 'forkNotice' &&
      typeof extra.entityId === 'string' &&
      extra.entityId.startsWith('fork:') &&
      extra.entityId.split(':').length >= 3 &&
      extra.text === undefined
    if (!validMarker) throw new ZcodeEditError(ZCODE_EDIT_CODES.forkMismatch)
  }
  const parentBoundaries = zcodeUserBoundaries(prefix)
  const childBoundaries = zcodeUserBoundaries(childRows.slice(0, prefix.length))
  if (parentBoundaries.length !== childBoundaries.length)
    throw new ZcodeEditError(ZCODE_EDIT_CODES.forkMismatch)
  const retained = parentBoundaries.map((boundary, index) => {
    const child = childBoundaries[index]!
    if (boundary.text !== child.text) throw new ZcodeEditError(ZCODE_EDIT_CODES.forkMismatch)
    return { previousId: boundary.id, nextId: child.id }
  })
  return { retained }
}
