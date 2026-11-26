import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { withoutRememberingPermission } from '../../compat/host/permission-memory.ts'
import { LlmError } from '../../shared/llm-error.ts'
import type { MessageEditSend, MessageEditState } from '../contracts/message-edit.ts'
import type { HarnessSession, HarnessSnapshot } from '../contracts/sessions.ts'
import {
  STOP_EDIT_VERSION,
  type StopEditBoundary,
  type StopEditResult,
} from '../contracts/stop-edit.ts'
import {
  HarnessConfigurationError,
  HarnessRequestError,
  HarnessTransportError,
  object,
} from './acp.ts'
import { defaultHarness } from './adapters/index.ts'
import { MINIMAX_CODE_HARNESS, minimaxCodeModels } from './adapters/minimax.ts'
import type { ExecutionCatalogStore } from './catalog.ts'
import { currentHarnessInputText, requireHarnessInputText } from './harness-input.ts'
import {
  messageEditState as computeNativeMessageEditState,
  type MessageEditTransactions,
} from './message-edit.ts'
import { claudeMessageEditDriver } from './message-edit-claude.ts'
import { codexMessageEditDriver } from './message-edit-codex.ts'
import type {
  ExternalEditContext,
  ExternalEditHistory,
  ExternalMessageEditDriver,
} from './message-edit-driver.ts'
import {
  ExternalMessageEditTransactions,
  externalEditRecordFingerprint,
} from './message-edit-external.ts'
import { grokMessageEditDriver } from './message-edit-grok.ts'
import { createKiloMessageEditDriver, readStoredKiloHistory } from './message-edit-kilo.ts'
import { kimiMessageEditDriver } from './message-edit-kimi.ts'
import {
  externalEditChoices,
  externalEditedRecord,
  externalEditRecovery,
  externalFreshFirstChoice,
  externalPreparedChoice,
  externalReceivedInput,
  externalRecordedChoices,
  externalTerminalFailureChoice,
  externalUnsentAdmissionChoice,
  externalUnsentEmptyChoice,
  externalUnsentNativeRecovery,
} from './message-edit-mapping.ts'
import { createOpenCodeMessageEditDriver } from './message-edit-opencode.ts'
import { ExternalMessageEditError } from './message-edit-opencode-common.ts'
import { piMessageEditDriver } from './message-edit-pi.ts'
import { poolMessageEditDriver } from './message-edit-pool.ts'
import { stepMessageEditDriver } from './message-edit-step.ts'
import { zcodeMessageEditDriver } from './message-edit-zcode.ts'
import { resolvePromptContent } from './multimodal-prompt.ts'
import { harnessPermissionPreset } from './permissions.ts'
import type { RuntimeMaintenance } from './runtime-maintenance.ts'
import {
  StopEditError,
  type StopEditHost,
  type StopEditRewindOutcome,
  type StopEditRuntime,
  type StopEditService,
  type StopEditTarget,
} from './stop-edit.ts'
import type { StopEditIntentStore } from './stop-edit-intent.ts'
import {
  nativeStopEditRuntime,
  readNativeUserMessages,
  type NativeReviewFacts,
  type NativeSessionSource,
} from './stop-edit-native.ts'

export type StopEditReview = NativeReviewFacts
import { parseMiniMaxTurnUsage } from './usage-account.ts'
import { asSessionId, hash, now, required, type Active } from './harness-types.ts'

export interface HarnessStopEditContext {
  currentWorkingDirectory(session: Session): string
  ensureCurrentWorkingDirectory(session: Session): Promise<string>
  readonly ctx: Context
  readonly directory: string
  readonly records: Map<string, HarnessSession>
  readonly active: Map<string, Active>
  readonly finalizing: Map<string, Promise<void>>
  readonly connecting: Map<string, Promise<void>>
  readonly externalEditing: Set<string>
  readonly externalHistories: Map<string, { fingerprint: string; history: ExternalEditHistory }>
  readonly selections: Record<string, string>
  readonly catalogStore: ExecutionCatalogStore
  readonly stopEdits: StopEditService
  readonly stopEditIntents: StopEditIntentStore
  readonly messageEdits: MessageEditTransactions
  readonly externalMessageEdits: ExternalMessageEditTransactions
  readonly runtimeMaintenance: RuntimeMaintenance
  readonly ready: Promise<void>
  save(record: HarnessSession): Promise<void>
  changed(record: HarnessSession): void
  native(method: string, request: object): Promise<unknown>
  bindSelection(sessionId: string, combination: string): Promise<void>
  cancel(input: { sessionId: string }, pauseWake?: boolean): Promise<HarnessSnapshot>
  connectAdmitted(record: HarnessSession): Promise<void>
  enterEngine<T>(id: string, operation: () => Promise<T>): Promise<T>
  openConnection(record: HarnessSession, provisional?: boolean): Promise<void>
  pinSession(record: HarnessSession, active: Active, effort?: string): Promise<void>
  assertConversationModelAvailable(sessionId: string): Promise<void>
  externalDriver(record: HarnessSession): ExternalMessageEditDriver | undefined
  supportsExternalEditing(record: HarnessSession): boolean
  externalContext(record: HarnessSession, signal: AbortSignal): ExternalEditContext
  disconnectIdleConnection(record: HarnessSession, expected?: Active): Promise<void>
  externalHistory(record: HarnessSession): Promise<ExternalEditHistory>
  storedKiloHistory(record: HarnessSession): Promise<ExternalEditHistory>
  externalRecoveryHistory(
    record: HarnessSession,
    intent: ReturnType<ExternalMessageEditTransactions['intent']>,
  ): Promise<ExternalEditHistory>
  messageEditState(input: { sessionId: string }): Promise<MessageEditState>
  stopEditTarget(sessionId: string): StopEditTarget | undefined
  stopEditBlocked(sessionId: string): string | undefined
  stopEditRuntime(target: StopEditTarget): StopEditRuntime | undefined
  stopEditReviewBySession(sessionId: string): StopEditReview
  stopEditBusy(target: StopEditTarget): boolean
  stopEditSettle(target: StopEditTarget): Promise<void>
  commitStopEdit(input: {
    target: StopEditTarget
    outcome: StopEditRewindOutcome
    boundary: StopEditBoundary
    clientRequestId: string
    operationId: string
    keep: number
  }): Promise<StopEditResult>
  rebindNativeBranch(
    sessionId: string,
    previousSessionId: string,
    editedHead: string,
  ): Promise<NativeReviewFacts>
}

export function externalDriver(record: HarnessSession): ExternalMessageEditDriver | undefined {
  switch (record.harnessRef) {
    case 'codex':
      return codexMessageEditDriver
    case 'claude':
      return claudeMessageEditDriver
    case 'grok-build':
      return grokMessageEditDriver
    case 'zcode':
      return zcodeMessageEditDriver
    case 'opencode':
      return createOpenCodeMessageEditDriver()
    case 'kilo':
      return createKiloMessageEditDriver()
    case 'pi':
      return piMessageEditDriver()
    case 'kimi-code':
      return kimiMessageEditDriver()
    case 'pool':
      return poolMessageEditDriver()
    case 'step-code':
      return stepMessageEditDriver()
    default:
      return undefined
  }
}

/** Antigravity can allocate a fresh first input, but exposes no history rewind API. */
export function supportsExternalEditing(
  host: Pick<HarnessStopEditContext, 'externalDriver'>,
  record: HarnessSession,
): boolean {
  return record.harnessRef === 'antigravity' || host.externalDriver(record) !== undefined
}

export function externalContext(
  host: HarnessStopEditContext,
  record: HarnessSession,
  signal: AbortSignal,
): ExternalEditContext {
  const active = host.active.get(record.id)
  if (!active?.acp || !active.editLaunch) throw Error('外部会话尚未连接')
  return {
    record,
    launch: active.editLaunch,
    signal,
    transport: () => {
      const current = host.active.get(record.id)?.acp
      if (!current || current.closed) throw Error('外部会话连接已变化')
      return current
    },
    snapshot: () => {
      const current = host.active.get(record.id)
      if (!current) throw Error('外部会话连接已变化')
      return {
        agent: current.agentInfo ?? {},
        session: current.sessionInfo ?? {},
        configOptions: current.configOptions,
      }
    },
    disconnect: () => host.disconnectIdleConnection(record, active),
    reconnect: async (id) => {
      if (id !== record.acpSessionId) throw Error('新会话身份必须先持久保存')
      await host.connectAdmitted(record)
    },
    replayHistory: async () => {
      const current = host.active.get(record.id)
      if (!current?.acp || current.turn || current.editReplay) throw Error('外部会话暂时无法回读')
      const replay = { text: '', boundaries: [] as { id: string; text: string }[] }
      current.editReplay = replay
      try {
        await current.acp.request(
          'session/load',
          {
            sessionId: record.acpSessionId,
            cwd: current.editLaunch?.acpCwd ?? record.cwd,
            mcpServers: current.mcpServers ?? [],
          },
          30_000,
        )
        if (signal.aborted || replay.text) throw Error('外部历史回读未确认')
        return {
          sessionId: record.acpSessionId,
          token: hash(replay.boundaries),
          boundaries: replay.boundaries,
        }
      } finally {
        delete current.editReplay
      }
    },
  }
}

/** Release only the idle connection observed here, after its owned process and bridge have exited. */
export async function disconnectIdleConnection(
  host: HarnessStopEditContext,
  record: HarnessSession,
  expected?: Active,
): Promise<void> {
  const current = host.active.get(record.id)
  if (current && expected && current !== expected) throw Error('外部会话连接已变化')
  if (current?.turn || host.connecting.has(record.id)) throw Error('外部会话仍在执行或连接')
  if (!current) return
  await current.acp?.dispose()
  if (host.active.get(record.id) !== current || current.turn) throw Error('外部会话连接已变化')
  await current.bridgeStop?.()
  if (host.active.get(record.id) !== current || current.turn) throw Error('外部会话连接已变化')
  host.active.delete(record.id)
}

export async function externalHistory(
  host: HarnessStopEditContext,
  record: HarnessSession,
): Promise<ExternalEditHistory> {
  const active = host.active.get(record.id)
  const stored = record.harnessRef === 'kilo' && (!active?.acp || active.acp.closed)
  if (stored && active) await host.disconnectIdleConnection(record, active)
  if (!stored) await host.connectAdmitted(record)
  const fingerprint = externalEditRecordFingerprint(record)
  const cached = host.externalHistories.get(record.id)
  if (cached?.fingerprint === fingerprint) return cached.history
  const driver = host.externalDriver(record)
  if (!driver) throw Error('此执行引擎尚不支持编辑消息')
  const intent = record.nativeSessionId
    ? host.externalMessageEdits.intent(record.nativeSessionId)
    : undefined
  const last = record.turns.at(-1)
  const readRecord =
    intent?.phase === 'admitting' &&
    last?.state === 'failed' &&
    last.operationId === 'message-edit:' + intent.requestId &&
    !last.native?.userMessageId
      ? { ...record, turns: record.turns.slice(0, -1) }
      : record
  const history = stored
    ? await host.storedKiloHistory(readRecord)
    : await driver.read({
        ...host.externalContext(record, new AbortController().signal),
        record: readRecord,
      })
  if (
    externalEditRecordFingerprint(record) !== fingerprint ||
    history.sessionId !== record.acpSessionId
  )
    throw Error('编辑历史已变化')
  host.externalHistories.set(record.id, { fingerprint, history })
  const current = host.active.get(record.id)
  if (current) current.editHistory = history
  return history
}

/** Read persisted Kilo identities without preparing a route to a possibly retired model. */
export async function storedKiloHistory(
  host: HarnessStopEditContext,
  record: HarnessSession,
): Promise<ExternalEditHistory> {
  const harness = (await host.catalogStore.get()).harnesses.find((h) => h.id === 'kilo')
  return readStoredKiloHistory(
    record,
    {
      home: host.directory,
      ...(harness?.command ? { command: harness.command } : {}),
      ...(harness?.prefix ? { prefix: harness.prefix } : {}),
    },
    new AbortController().signal,
  )
}

/** Read a vendor prefix for a terminal replacement failure without mapping the failed input. */
export async function externalRecoveryHistory(
  host: HarnessStopEditContext,
  record: HarnessSession,
  intent: ReturnType<ExternalMessageEditTransactions['intent']>,
): Promise<ExternalEditHistory> {
  const last = record.turns.at(-1)
  if (
    !intent ||
    !last ||
    !['settled', 'admitting'].includes(intent.phase) ||
    last.operationId !== 'message-edit:' + intent.requestId ||
    last.state === 'running' ||
    last.native?.userMessageId
  )
    return host.externalHistory(record)
  const driver = host.externalDriver(record)
  if (!driver) throw Error('此执行引擎尚不支持编辑消息')
  const active = host.active.get(record.id)
  if (record.harnessRef === 'kilo' && (!active?.acp || active.acp.closed)) {
    if (active) await host.disconnectIdleConnection(record, active)
    return host.storedKiloHistory({ ...record, turns: record.turns.slice(0, -1) })
  }
  await host.connectAdmitted(record)
  return driver.read({
    ...host.externalContext(record, new AbortController().signal),
    record: { ...record, turns: record.turns.slice(0, -1) },
  })
}

export async function messageEditState(
  host: HarnessStopEditContext,
  input: { sessionId: string },
): Promise<MessageEditState> {
  await host.ready
  let session = host.ctx.sessions.get(
    asSessionId<SessionId>(required(input.sessionId, 'sessionId')),
  )
  const target = host.stopEditTarget(input.sessionId)
  if (!session && target?.record && host.supportsExternalEditing(target.record)) {
    const restored = await host.ctx.sessionController.resolveAgent(
      asSessionId<SessionId>(input.sessionId),
    )
    if (!('error' in restored)) session = restored.agent.session
  }
  const supported =
    target?.harness === 'dsh' && !target.record && !host.stopEditBlocked(input.sessionId)
  if (!session)
    return {
      sessionId: input.sessionId,
      supported: false,
      busy: false,
      pending: false,
      head: -1,
      choices: [],
      ...(target?.record && host.supportsExternalEditing(target.record)
        ? {
            pending:
              host.externalMessageEdits.pending(input.sessionId) ||
              host.messageEdits.pending(input.sessionId),
            unavailable: { reason: 'history-busy' as const, retryable: true },
          }
        : {}),
    }
  if (target?.record) await host.finalizing.get(target.record.id)
  const agent = host.ctx.agents.get(session.id)
  if (target?.record && host.supportsExternalEditing(target.record)) {
    const record = target.record
    const busy =
      agent?.status === 'running' ||
      Boolean(agent?.inbox.nextTurn.length || agent?.inbox.nextStep.length) ||
      Boolean(host.active.get(record.id)?.turn) ||
      host.finalizing.has(record.id) ||
      host.externalEditing.has(record.id)
    const abandoned = !busy && agent ? host.messageEdits.unadmitted(agent) : undefined
    const admission = host.externalMessageEdits.intent(session.id)
    const prepared =
      abandoned && admission && admission.requestId === abandoned.input.prompt.requestId
        ? externalPreparedChoice(
            record,
            { ...admission, phase: 'ready' },
            session.snapshotEvents(),
            new Set<number>(session.surface.nodes),
          )?.seq === abandoned.input.targetSeq
        : false
    if (prepared && admission?.phase === 'admitting' && agent) {
      await host.externalMessageEdits.reopenUnadmitted(session.id, admission.requestId)
      await host.messageEdits.recoverUnadmitted(agent)
    } else if (prepared && admission?.phase === 'ready' && agent) {
      await host.messageEdits.recoverUnadmitted(agent)
    }
    let pending =
      host.externalMessageEdits.pending(session.id) || host.messageEdits.pending(session.id)
    const base = { sessionId: session.id, head: Number(session.seq) - 1, busy, pending }
    const nativeRecovery = !busy ? host.messageEdits.recovery(session) : undefined
    if (nativeRecovery && externalUnsentNativeRecovery(record, admission, nativeRecovery))
      return { ...base, supported: true, choices: [], recovery: nativeRecovery }
    if (busy || host.messageEdits.pending(session.id))
      return { ...base, supported: true, choices: [] }
    const intent = host.externalMessageEdits.intent(session.id)
    const lastTurn = record.turns.at(-1)
    const terminalEdit = Boolean(
      ['opencode', 'kilo'].includes(record.harnessRef) &&
      ['settled', 'uncertain'].includes(intent?.phase ?? '') &&
      lastTurn?.state === 'failed' &&
      lastTurn.operationId === 'message-edit:' + intent?.requestId,
    )
    const preparedChoice = externalPreparedChoice(
      record,
      intent,
      session.snapshotEvents(),
      new Set<number>(session.surface.nodes),
    )
    if (preparedChoice)
      return { ...base, pending: false, supported: true, choices: [preparedChoice] }
    const admissionChoice = externalUnsentAdmissionChoice(
      record,
      intent,
      session.snapshotEvents(),
      new Set<number>(session.surface.nodes),
    )
    if (admissionChoice)
      return { ...base, pending: false, supported: true, choices: [admissionChoice] }
    const emptyChoice = externalUnsentEmptyChoice(
      record,
      intent,
      session.snapshotEvents(),
      new Set<number>(session.surface.nodes),
    )
    if (emptyChoice) return { ...base, pending: false, supported: true, choices: [emptyChoice] }
    const terminalChoice = externalTerminalFailureChoice(
      record,
      intent,
      session.snapshotEvents(),
      new Set<number>(session.surface.nodes),
    )
    if (terminalChoice && !terminalEdit)
      return { ...base, pending: false, supported: true, choices: [terminalChoice] }
    if (pending && !terminalEdit && !['admitting', 'prompting'].includes(intent?.phase ?? ''))
      return {
        ...base,
        supported: true,
        choices: [],
        unavailable: { reason: 'mapping-unavailable', retryable: false },
      }
    if (!pending && !terminalEdit) {
      const events = session.snapshotEvents()
      const activeSeqs = new Set<number>(session.surface.nodes)
      const choices = (
        record.harnessRef === 'antigravity'
          ? []
          : externalRecordedChoices(record, events, activeSeqs)
      ).map(({ seq, text }) => ({
        seq,
        text,
      }))
      const first = externalFreshFirstChoice(record, events, activeSeqs)
      if (first) choices.unshift(first)
      return {
        ...base,
        supported: true,
        choices,
        ...(choices.length || !record.turns.length
          ? {}
          : { unavailable: { reason: 'mapping-unavailable' as const, retryable: false } }),
      }
    }
    host.externalEditing.add(record.id)
    let phase = 'history-read'
    try {
      if (terminalEdit) host.externalHistories.delete(record.id)
      const history = terminalEdit
        ? await host.externalHistory(record)
        : await host.externalRecoveryHistory(record, intent)
      const received = externalReceivedInput(
        record,
        history,
        intent,
        session.snapshotEvents(),
        new Set<number>(session.surface.nodes),
      )
      if (received && lastTurn?.native && !lastTurn.native.userMessageId) {
        lastTurn.native.userMessageId = received
        await host.save(record)
      }
      phase = 'recovery-check'
      const recovery = externalEditRecovery(
        record,
        history,
        intent,
        session.snapshotEvents(),
        new Set<number>(session.surface.nodes),
      )
      const currentAgent = host.ctx.agents.get(session.id)
      if (
        currentAgent !== agent ||
        currentAgent?.status === 'running' ||
        currentAgent?.inbox.nextTurn.length ||
        currentAgent?.inbox.nextStep.length
      )
        return { ...base, busy: true, supported: true, choices: [] }
      if (recovery?.kind === 'settled') {
        phase = 'journal-settle'
        if (intent?.phase === 'prompting')
          await host.externalMessageEdits.settle(session.id, intent.requestId)
        else if (intent?.phase === 'uncertain')
          await host.externalMessageEdits.confirmTerminalHistory(session.id, intent.requestId)
        pending = false
      }
      if (terminalEdit && recovery?.kind !== 'settled') {
        if (intent?.phase === 'settled')
          await host.externalMessageEdits.retainUncertainty(session.id, intent.requestId)
        return {
          ...base,
          pending: true,
          supported: true,
          choices: [],
          unavailable: { reason: 'mapping-unavailable', retryable: false },
        }
      }
      if (pending && recovery?.kind !== 'unsent')
        return {
          ...base,
          supported: true,
          choices: [],
          unavailable: { reason: 'mapping-unavailable', retryable: false },
        }
      phase = 'choices'
      const choices = externalEditChoices(
        record,
        history,
        session.snapshotEvents(),
        new Set<number>(session.surface.nodes),
      ).map(({ seq, text }) => ({ seq, text }))
      if (recovery?.kind === 'unsent') choices.push(recovery.choice)
      if (!pending) {
        const first = externalFreshFirstChoice(
          record,
          session.snapshotEvents(),
          new Set<number>(session.surface.nodes),
        )
        if (first) choices.unshift(first)
      }
      return {
        ...base,
        pending: false,
        supported: true,
        choices: choices.map(({ seq, text }) => ({ seq, text })),
        ...(choices.length
          ? {}
          : { unavailable: { reason: 'mapping-unavailable' as const, retryable: false } }),
      }
    } catch (error) {
      const code =
        error instanceof ExternalMessageEditError
          ? error.code
          : error instanceof HarnessConfigurationError
            ? 'configuration'
            : error instanceof HarnessRequestError
              ? 'acp-request'
              : error instanceof HarnessTransportError
                ? 'transport'
                : 'unclassified'
      host.ctx.logger?.warn(
        `外部编辑历史暂未确认，未修改历史或发送消息（phase=${phase} code=${code}）`,
      )
      return {
        ...base,
        pending,
        supported: true,
        choices: [],
        unavailable: {
          reason:
            error instanceof ExternalMessageEditError && error.code === 'busy'
              ? 'history-busy'
              : 'history-unavailable',
          retryable: true,
        },
      }
    } finally {
      host.externalEditing.delete(record.id)
    }
  }
  if (agent) await host.messageEdits.recoverUnadmitted(agent)
  const state = computeNativeMessageEditState(session, agent?.status === 'running', supported)
  const recovery =
    !state.busy && !agent?.inbox.nextTurn.length && !agent?.inbox.nextStep.length
      ? host.messageEdits.recovery(session)
      : undefined
  return {
    ...state,
    pending: state.pending || host.messageEdits.pending(input.sessionId),
    ...(recovery ? { recovery } : {}),
  }
}

export async function messageEditSend(host: HarnessStopEditContext, input: MessageEditSend) {
  await host.ready
  const target = host.stopEditTarget(input.prompt.sessionId)?.record
  if (target && target.harnessRef !== 'dsh') {
    const text = currentHarnessInputText(input.prompt.content, 'edit-request')
    requireHarnessInputText(
      'user: ' +
        input.prompt.content
          .flatMap((part) =>
            part.type === 'text' ? (part.text ? [part.text] : []) : ['[图片附件]'],
          )
          .join('\n'),
      'edit-request',
      { currentTextLength: text.length },
    )
  }
  return host.runtimeMaintenance.admit(async () => {
    await host.assertConversationModelAvailable(input.prompt.sessionId)
    const state = await host.messageEditState({ sessionId: input.prompt.sessionId })
    if (!state.supported || state.busy) throw Error('请先停止当前对话，再编辑消息')
    const resolved = await host.ctx.sessionController.resolveAgent(input.prompt.sessionId)
    if ('error' in resolved) throw Error('对话暂时无法编辑，请重新打开')
    const agent = resolved.agent
    if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length)
      throw Error('请先处理待发送消息，再编辑对话')
    const record = host.stopEditTarget(input.prompt.sessionId)?.record
    if (
      record &&
      state.recovery &&
      externalUnsentNativeRecovery(
        record,
        host.externalMessageEdits.intent(agent.id),
        state.recovery,
      )
    )
      return agent.runMaintenance((signal) =>
        host.messageEdits.send(agent, input, () =>
          host.ctx.sessionController.prompt(input.prompt, signal),
        ),
      )
    const original = readNativeUserMessages(agent.session.snapshotEvents()).find(
      (message) => message.seq === input.targetSeq,
    )
    const images = original?.content?.filter((part) => part.type === 'image') ?? []
    let expectedContent = images.length
      ? [
          ...input.prompt.content.map((part) => {
            if (part.type !== 'text') throw Error('编辑图片消息时请保留原图片，仅修改文本')
            return { type: 'text' as const, text: part.text }
          }),
          ...images.map((part) => ({ type: 'image' as const, attachment: part.attachment })),
        ]
      : undefined
    const promptForEdit = async (signal: AbortSignal) => {
      if (!expectedContent) return input.prompt
      signal.throwIfAborted()
      const attachments = host.ctx.get('attachments')
      if (!attachments) throw new LlmError('图片附件存储尚未就绪，未发送任务', 'HARNESS_INPUT')
      const content = await resolvePromptContent(attachments, expectedContent, signal)
      signal.throwIfAborted()
      const prompt = {
        ...input.prompt,
        content: content.map((part, index) =>
          part.type === 'text'
            ? part
            : {
                type: 'image' as const,
                mediaType: part.mimeType as import('@deepseek-ai/dsh-attachment').ImageMediaType,
                data: part.data,
                ...(expectedContent![index]?.type === 'image' &&
                expectedContent![index]!.attachment.name
                  ? { name: expectedContent![index]!.attachment.name }
                  : {}),
              },
        ),
      }
      const admitted = await attachments.admitPromptContent(prompt.content)
      signal.throwIfAborted()
      expectedContent = admitted.filter((part) => part.type !== 'file')
      return prompt
    }
    if (!record)
      return agent.runMaintenance(async (signal) => {
        const prompt = await promptForEdit(signal)
        return host.messageEdits.send(
          agent,
          input,
          () => host.ctx.sessionController.prompt(prompt, signal),
          expectedContent,
        )
      })
    const driver = host.externalDriver(record)
    if (!host.supportsExternalEditing(record) || host.externalEditing.has(record.id))
      throw Error('此会话暂时不能编辑')
    if (!state.choices.some((choice) => choice.seq === input.targetSeq))
      throw Error('消息已变化，请重新选择')
    if (
      input.prompt.mode !== 'queue' ||
      input.prompt.content.some((part) => part.type !== 'text') ||
      !input.prompt.content.some((part) => part.type === 'text' && part.text.trim())
    )
      throw Error('编辑消息需要非空文本，暂不支持附件')
    host.externalEditing.add(record.id)
    try {
      return await agent.runMaintenance(async (signal) => {
        const prompt = await promptForEdit(signal)
        signal.throwIfAborted()
        const priorIntent = host.externalMessageEdits.intent(agent.id)
        const preparedChoice = externalPreparedChoice(
          record,
          priorIntent,
          agent.session.snapshotEvents(),
          new Set<number>(agent.session.surface.nodes),
        )
        const admissionChoice = externalUnsentAdmissionChoice(
          record,
          priorIntent,
          agent.session.snapshotEvents(),
          new Set<number>(agent.session.surface.nodes),
        )
        const emptyChoice = externalUnsentEmptyChoice(
          record,
          priorIntent,
          agent.session.snapshotEvents(),
          new Set<number>(agent.session.surface.nodes),
        )
        const fresh =
          !preparedChoice && !emptyChoice && (!priorIntent || priorIntent.phase === 'settled')
            ? externalFreshFirstChoice(
                record,
                agent.session.snapshotEvents(),
                new Set<number>(agent.session.surface.nodes),
              )?.seq === input.targetSeq
            : false
        if (!driver && !fresh && !emptyChoice && !preparedChoice)
          throw Error('此执行引擎仅支持编辑首条消息；中途编辑请使用 OpenCode 组合')
        const history =
          emptyChoice || preparedChoice || fresh
            ? undefined
            : await host.externalRecoveryHistory(record, priorIntent)
        const recovery = history
          ? externalEditRecovery(
              record,
              history,
              priorIntent,
              agent.session.snapshotEvents(),
              new Set<number>(agent.session.surface.nodes),
            )
          : undefined
        const prepared =
          preparedChoice?.seq === input.targetSeq || admissionChoice?.seq === input.targetSeq
        const empty =
          emptyChoice?.seq === input.targetSeq || (prepared && priorIntent?.result?.ephemeral)
        const unsent =
          empty ||
          prepared ||
          (recovery?.kind === 'unsent' && recovery.choice.seq === input.targetSeq)
        const choice = history
          ? externalEditChoices(
              record,
              history,
              agent.session.snapshotEvents(),
              new Set<number>(agent.session.surface.nodes),
            ).find((item) => item.seq === input.targetSeq)
          : undefined
        if (!choice && !unsent && !fresh) throw Error('消息已变化，请重新选择')
        if (!fresh && !empty) await host.connectAdmitted(record)
        signal.throwIfAborted()
        const allocateEmpty = async () => {
          await host.disconnectIdleConnection(record)
          signal.throwIfAborted()
          const allocation = { ...record, acpSessionId: '', turns: [] }
          await host.enterEngine(record.harnessRef, () => host.openConnection(allocation, true))
          return { sessionId: allocation.acpSessionId, retained: [], ephemeral: true }
        }
        const result = fresh
          ? await host.externalMessageEdits.prepareFirst(
              { record, signal },
              { requestId: input.prompt.requestId, targetSeq: input.targetSeq },
              allocateEmpty,
            )
          : unsent
            ? await host.externalMessageEdits.reuseUnsent(
                { record, signal, targetSeq: input.targetSeq },
                priorIntent!.requestId,
                input.prompt.requestId,
                empty ? allocateEmpty : undefined,
              )
            : await host.externalMessageEdits.prepare(
                host.externalContext(record, signal),
                driver!,
                {
                  requestId: input.prompt.requestId,
                  targetId: choice!.boundaryId,
                  targetSeq: input.targetSeq,
                  expected: history!,
                },
              )
        const next = fresh
          ? { ...record, acpSessionId: result.sessionId, turns: [] }
          : unsent
            ? {
                ...record,
                acpSessionId: result.sessionId,
                turns: prepared ? record.turns : record.turns.slice(0, -1),
              }
            : externalEditedRecord(record, history!, choice!.boundaryId, result)
        Object.assign(record, next)
        await host.save(record)
        let current = host.active.get(record.id)
        const reconnect = !current?.acp || current.acp.closed
        if (reconnect) {
          await host.connectAdmitted(record)
          signal.throwIfAborted()
          current = host.active.get(record.id)
        }
        if (!current?.acp || current.acp.closed) throw Error('编辑后的连接已断开')
        current.provisional = false
        delete current.editHistory
        const needsPreparedLoad =
          prepared && !result.ephemeral && current.sessionInfo?.sessionId !== result.sessionId
        current.sessionInfo = { ...current.sessionInfo, sessionId: result.sessionId }
        if (
          !reconnect &&
          (needsPreparedLoad ||
            (history &&
              result.sessionId !== history.sessionId &&
              (!result.ephemeral || record.harnessRef === 'claude')))
        ) {
          current.sessionInfo = object(
            await current.acp.request('session/load', {
              sessionId: result.sessionId,
              cwd: current.editLaunch?.acpCwd ?? record.cwd,
              mcpServers: current.mcpServers ?? [],
            }),
          )
          current.configOptions = current.sessionInfo.configOptions
          await host.pinSession(record, current, record.reasoningEffort)
        }
        let value: { accepted: true } | undefined
        await host.externalMessageEdits.admit(agent.id, input.prompt.requestId, async () => {
          value = await host.messageEdits.send(
            agent,
            { ...input, head: Number(agent.session.seq) - 1 },
            () => host.ctx.sessionController.prompt(prompt, signal),
            expectedContent,
          )
        })
        return value!
      })
    } finally {
      const current = host.active.get(record.id)
      if (current?.provisional) {
        await current.acp?.dispose()
        await current.bridgeStop?.()
        host.active.delete(record.id)
      }
      host.externalEditing.delete(record.id)
    }
  })
}

export async function claimMessageEdit(
  host: HarnessStopEditContext,
  agent: Agent,
  messages: readonly UserMessage[],
  turn: number,
  step: number,
): Promise<void> {
  await host.ready
  host.messageEdits.claim(agent, messages, turn, step)
}

export async function commitMessageEdit(
  host: HarnessStopEditContext,
  agent: Agent,
  turn: number,
  step: number,
  signal: AbortSignal,
): Promise<boolean> {
  await host.ready
  return host.messageEdits.commit(agent, turn, step, signal, () =>
    host.ctx.sessions.flush(agent.session),
  )
}

export async function stopEdit(
  host: HarnessStopEditContext,
  input: { clientRequestId: string; sessionId: string; boundaryId: string },
) {
  return host.runtimeMaintenance.admit(async () => {
    await host.ready
    try {
      return await host.stopEdits.rewind({
        clientRequestId: required(input.clientRequestId, 'clientRequestId'),
        sessionId: required(input.sessionId, 'sessionId'),
        boundaryId: required(input.boundaryId, 'boundaryId'),
      })
    } catch (error) {
      if (error instanceof StopEditError)
        throw new Error(`停止后编辑被拒绝（${error.reason}）：${error.message}`)
      host.ctx.logger.warn(`停止后编辑失败：${error instanceof Error ? error.name : 'unknown'}`)
      throw new Error('停止后编辑被拒绝（rewind-failed）：操作未能完成，请稍后重试')
    }
  })
}

export async function acknowledgeStopEditDraft(
  host: HarnessStopEditContext,
  input: { sessionId: string; clientRequestId: string },
) {
  await host.ready
  return {
    acknowledged: await host.stopEdits.acknowledge({
      sessionId: required(input.sessionId, 'sessionId'),
      clientRequestId: required(input.clientRequestId, 'clientRequestId'),
    }),
  }
}

export function stopEditHost(host: HarnessStopEditContext): StopEditHost {
  return {
    resolve: (sessionId) => host.stopEditTarget(sessionId),
    addressedSession: (target) =>
      target.record
        ? target.record.harnessRef === 'dsh'
          ? target.record.acpSessionId
          : (target.record.nativeSessionId ?? target.record.acpSessionId)
        : target.sessionId,
    runtime: (target) => host.stopEditRuntime(target),
    busy: (target) => host.stopEditBusy(target),
    stopAndWait: (target) => host.stopEditSettle(target),
    nextOperationId: () => 'stop-edit-' + randomUUID(),
    intent: (sessionId) => host.stopEditIntents.get(sessionId),
    plan: async (input) => {
      await host.stopEditIntents.plan({
        sessionId: input.target.sessionId,
        clientRequestId: input.clientRequestId,
        boundaryId: input.boundaryId,
        pendingOperationId: input.pendingOperationId,
        pendingDraft: input.pendingDraft,
        preservedSessionId: input.preservedSessionId,
      })
    },
    markRewinding: async (sessionId) => {
      await host.stopEditIntents.markRewinding(sessionId)
    },
    blocked: (sessionId) => host.stopEditBlocked(sessionId),
    commit: (input) => host.commitStopEdit(input),
    markUncertain: async (sessionId, reason) => {
      await host.stopEditIntents.markUncertain(sessionId, reason)
    },
    acknowledgeDraft: (sessionId, clientRequestId) =>
      host.stopEditIntents.acknowledge(sessionId, clientRequestId),
  }
}

export function stopEditBlocked(
  host: HarnessStopEditContext,
  sessionId: string,
): string | undefined {
  const branch = [...host.records.values()].find(
    (record) => record.nativeSessionId === sessionId || record.acpSessionId === sessionId,
  )
  const previous = branch?.stopEdit?.previousSessionId
  const sourceIntent = previous ? host.stopEditIntents.get(previous) : undefined
  if (sourceIntent?.phase === 'uncertain') return sourceIntent.reason
  if (sourceIntent?.phase === 'rewinding') return '编辑分支的提交尚未确认，请先核对会话历史后再发送'
  const intent = host.stopEditIntents.get(sessionId)
  if (!intent) return undefined
  if (intent.phase === 'uncertain') return intent.reason
  if (intent.phase === 'rewinding')
    return '上一次停止后编辑在改动途中中断，请先核对会话历史后再发送'
  if (
    intent.result?.moved &&
    minimaxCodeModels().some((model) => model.model === intent.result?.review.model) &&
    intent.result.preservedSessionId === sessionId
  )
    return '这是编辑前保留的会话，请打开编辑分支后继续'
  return undefined
}

export function assertStopEditIdle(host: HarnessStopEditContext, record: HarnessSession): void {
  const ids = record.nativeSessionId
    ? [record.acpSessionId, record.nativeSessionId]
    : [record.acpSessionId]
  for (const id of ids) {
    if (host.stopEdits.editing(id)) throw Error('此会话正在处理停止后编辑，请稍后再发送')
    const blocked = host.stopEditBlocked(id)
    if (blocked) throw Error(blocked)
  }
}

export function stopEditTarget(
  host: HarnessStopEditContext,
  sessionId: string,
): StopEditTarget | undefined {
  const session = host.ctx.sessions?.get(asSessionId<SessionId>(sessionId))
  const current = session
    ? host.ctx.sessionProjections.snapshot(session, ['modelSelection']).values.modelSelection
    : undefined
  const selected = current?.next ?? current?.lastUsed
  for (const record of host.records.values())
    if (record.acpSessionId === sessionId || record.nativeSessionId === sessionId) {
      if (selected && defaultHarness(selected) !== record.harnessRef) return undefined
      return { sessionId, harness: record.harnessRef === 'dsh' ? 'dsh' : 'minimax-code', record }
    }
  if (session && !session.header.origin) {
    if (selected && defaultHarness(selected) !== 'dsh') return undefined
    return { sessionId, harness: 'dsh' }
  }
  return undefined
}

export function stopEditRuntime(
  host: HarnessStopEditContext,
  target: StopEditTarget,
): StopEditRuntime | undefined {
  const record = target.record
  if (record && record.harnessRef !== 'dsh') return undefined
  if (target.harness === 'dsh') return nativeStopEditRuntime(nativeStopEditSource(host))
  return undefined
}

function nativeStopEditSource(host: HarnessStopEditContext): NativeSessionSource {
  const sessionOf = (sessionId: string) => host.ctx.sessions.get(asSessionId<SessionId>(sessionId))
  return {
    events: (sessionId) => sessionOf(sessionId)?.snapshotEvents(),
    running: (sessionId) =>
      host.ctx.agents.get(asSessionId<SessionId>(sessionId))?.status === 'running',
    whenIdle: async (sessionId) => {
      const agent = host.ctx.agents.get(asSessionId<SessionId>(sessionId))
      if (agent) await agent.whenIdle()
    },
    cwd: (sessionId) => {
      const session = sessionOf(sessionId)
      return session ? host.currentWorkingDirectory(session) : undefined
    },
    validateBranch: (sessionId) => {
      const session = sessionOf(sessionId)
      const permissions = host.ctx.get('permissionPresets')
      if (!session || !permissions || permissions.current(session) === 'custom')
        throw new StopEditError('missing-mapping', '无法完整复制原会话权限，请先选择内置权限选项')
      const selection = host.ctx.sessionProjections.snapshot(session, ['modelSelection']).values
        .modelSelection
      if (!(selection?.next ?? selection?.lastUsed))
        throw new StopEditError('missing-mapping', '无法读取原会话模型选择，已放弃回退')
    },
    fork: async (sessionId, atSeq) => {
      const value = object(await host.native('fork', { sessionId, atSeq }))
      return required(value.sessionId, 'forked sessionId')
    },
    create: async (_sessionId, cwd) => {
      const id = `session-${randomUUID()}`
      const workspace = await host.ctx.workspaceRegistry.create(cwd)
      await host.native('create', { sessionId: id, workspaceId: workspace.id })
      return id
    },
    rebind: (sessionId, previousSessionId, editedHead) =>
      host.rebindNativeBranch(sessionId, previousSessionId, editedHead),
  }
}

export function stopEditReviewBySession(
  host: HarnessStopEditContext,
  sessionId: string,
): StopEditReview {
  const session = host.ctx.sessions.get(asSessionId<SessionId>(sessionId))
  const record = [...host.records.values()].find(
    (item) => item.acpSessionId === sessionId || item.nativeSessionId === sessionId,
  )
  const presets = host.ctx.get('permissionPresets')
  const cwd = session ? host.currentWorkingDirectory(session) : (record?.cwd ?? '')
  return {
    model: record?.modelRef.model ?? '未知',
    ...(record?.reasoningEffort ? { effort: record.reasoningEffort } : {}),
    permissions:
      session && presets
        ? presets.current(session)
        : record
          ? harnessPermissionPreset(record.sandbox)
          : '未知',
    cwd,
    workspaceId: cwd ? '已随分支复制' : '',
    ...(cwd ? { project: cwd } : {}),
    title: '',
  }
}

export function stopEditBusy(host: HarnessStopEditContext, target: StopEditTarget): boolean {
  if (target.record && host.active.get(target.record.id)?.turn) return true
  return stopEditOfficialSessions(target).some(
    (sessionId) => host.ctx.agents.get(asSessionId<SessionId>(sessionId))?.status === 'running',
  )
}

function stopEditOfficialSessions(target: StopEditTarget): string[] {
  const record = target.record
  if (record)
    return [record.harnessRef === 'dsh' ? record.acpSessionId : record.nativeSessionId].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
  return [target.sessionId]
}

export async function stopEditSettle(
  host: HarnessStopEditContext,
  target: StopEditTarget,
): Promise<void> {
  if (target.record && host.stopEditBusy(target))
    await host.cancel({ sessionId: target.record.id }, false)
  for (const sessionId of stopEditOfficialSessions(target)) {
    const agent = host.ctx.agents.get(asSessionId<SessionId>(sessionId))
    if (agent) {
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
    }
  }
}

export async function commitStopEdit(
  host: HarnessStopEditContext,
  input: {
    target: StopEditTarget
    outcome: StopEditRewindOutcome
    boundary: StopEditBoundary
    clientRequestId: string
    operationId: string
    keep: number
  },
): Promise<StopEditResult> {
  const { target, outcome, boundary, clientRequestId, operationId, keep } = input
  const record = target.record
  const previousSessionId = host.stopEdits.addressedSession(target)
  const removedTurns = record ? record.turns.length - keep : 0
  if (record) {
    record.turns = record.turns.slice(0, keep)
    if (record.harnessRef === 'dsh') record.acpSessionId = outcome.sessionId
    else record.nativeSessionId = outcome.sessionId
    record.stopEdit = {
      clientRequestId,
      previousSessionId,
      sessionId: outcome.sessionId,
      boundaryId: boundary.id,
      pendingOperationId: operationId,
      removedTurns,
      at: now(),
    }
    host.changed(record)
    await host.save(record)
  }
  const result: StopEditResult = {
    sessionId: outcome.sessionId,
    clientRequestId,
    preservedSessionId: outcome.preservedSessionId,
    branchTitle: outcome.review.title,
    moved: outcome.sessionId !== outcome.preservedSessionId,
    boundary,
    draft: outcome.draft,
    unrestored: outcome.unrestored,
    removedTurns,
    review: {
      ...outcome.review,
      feedback: {
        ...(record?.assignment ? { taskId: record.assignment.taskId } : {}),
        pendingDeliveries: (record?.turns ?? []).filter(
          (turn) => turn.delivery?.state !== 'delivered',
        ).length,
        operationId,
      },
    },
    version: STOP_EDIT_VERSION,
  }
  await host.stopEditIntents.markCommitted(outcome.sessionId, outcome.preservedSessionId, result)
  return result
}

export async function rebindNativeBranch(
  host: HarnessStopEditContext,
  sessionId: string,
  previousSessionId: string,
  editedHead: string,
): Promise<NativeReviewFacts> {
  const previous = host.ctx.sessions.get(asSessionId<SessionId>(previousSessionId))
  const record = [...host.records.values()].find(
    (item) => item.acpSessionId === previousSessionId || item.nativeSessionId === previousSessionId,
  )
  const cwd = previous ? await host.ensureCurrentWorkingDirectory(previous) : record?.cwd
  if (!cwd) throw new StopEditError('rewind-failed', '原会话缺少项目目录，已放弃回退')
  const session = host.ctx.sessions.get(asSessionId<SessionId>(sessionId))
  if (!session) throw new StopEditError('rewind-failed', '新分支会话未就绪')
  if ((await host.ensureCurrentWorkingDirectory(session)) !== cwd)
    throw new StopEditError('rewind-failed', '新分支的项目目录与原会话不一致，已放弃回退')
  if (!previous) throw new StopEditError('rewind-failed', '原会话已关闭')
  const selection = host.ctx.sessionProjections.snapshot(previous, ['modelSelection']).values
    .modelSelection
  const selected: ModelSelection | undefined =
    selection?.next ?? selection?.lastUsed ?? record?.modelRef
  if (!selected) throw new StopEditError('rewind-failed', '原会话缺少可复核的模型选择')
  await host.native('selectModel', { sessionId, ...selected })
  const permissions = host.ctx.get('permissionPresets')
  if (!permissions) throw new StopEditError('rewind-failed', '官方权限服务不可用')
  withoutRememberingPermission(session, () =>
    permissions.set(session, permissions.current(previous)),
  )
  const base = record?.title ?? editedHead
  const title = `${base} · 编辑分支`
  await host.native('rename', { sessionId, title })
  if (record) {
    const binding = host.selections[previousSessionId]
    if (binding) await host.bindSelection(sessionId, binding)
  }
  const facts = host.stopEditReviewBySession(sessionId)
  return {
    model: selected.model,
    ...('reasoningEffort' in selected && selected.reasoningEffort
      ? { effort: selected.reasoningEffort }
      : facts.effort
        ? { effort: facts.effort }
        : {}),
    permissions: facts.permissions,
    cwd: facts.cwd,
    workspaceId: facts.workspaceId,
    ...(facts.project ? { project: facts.project } : {}),
    title,
  }
}

export async function recordMiniMaxUsage(
  host: HarnessStopEditContext,
  record: HarnessSession,
  active: Active,
  params: unknown,
) {
  const data = object(params)
  const turn = active.turn
  if (
    record.harnessRef !== MINIMAX_CODE_HARNESS ||
    host.active.get(record.id) !== active ||
    !turn ||
    active.cancelled ||
    data.version !== 1 ||
    data.sessionId !== record.acpSessionId ||
    data.operationId !== turn.operationId ||
    typeof data.turnId !== 'string' ||
    data.turnId !== turn.native?.turnId
  )
    return
  const usage = parseMiniMaxTurnUsage(data.rows, data.turnId, record.modelRef.model)
  if (!usage) return
  turn.usage = usage
  host.changed(record)
  await host.save(record)
}

export const HISTORY_BOUNDARY = 'opl/session/history/boundary'

export async function recordNativeBoundary(
  host: HarnessStopEditContext,
  record: HarnessSession,
  params: unknown,
) {
  const data = object(params)
  if (data.sessionId !== record.acpSessionId) return
  const clientRequestId = typeof data.clientRequestId === 'string' ? data.clientRequestId : ''
  const userMessageId = typeof data.userMessageId === 'string' ? data.userMessageId : ''
  if (!clientRequestId || !userMessageId) return
  const turn = record.turns.find((item) => item.operationId === clientRequestId)
  if (!turn || turn.native?.turnId) return
  turn.native = {
    ...turn.native,
    userMessageId,
    ...(typeof data.turnId === 'string' ? { turnId: data.turnId } : {}),
    ...(typeof data.historyVersion === 'string' ? { historyVersion: data.historyVersion } : {}),
  }
  await host.save(record)
}
