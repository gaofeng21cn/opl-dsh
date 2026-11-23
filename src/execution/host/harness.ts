import { EngineUpdates } from './engine-updates.ts'
import {
  checkEngineUpdate,
  applyEngineUpdate,
  usesPrivateUpdateDirectory,
} from './engine-update-sources.ts'
import { featureSettings } from '../../shared/host/feature-settings.ts'
import { LlmError } from '../../shared/llm-error.ts'
import type {} from '../contracts/official-collaboration.ts'
import type { MiniMaxAccountLoginRequest } from '../contracts/minimax-account.ts'
import { MiniMaxAccount } from './minimax-account.ts'
import { ProgressWatchdog, type ProgressWatchdogLimits } from './progress-watchdog.ts'
import { executionLimitsSchema } from '../contracts/limits.ts'
import { openCodeStreamFailure } from './adapters/opencode/stream-failure.ts'
import { hostPeer, invokeHostRemote } from '../../compat/host/remote-invocation.ts'
import { gatewayGroupEnabled } from '../../gateway/host/group-settings.ts'
import { inspectHarness, inspectInstalledHarness } from './harness-registry.ts'
import { maintainHarness } from './harness-maintenance.ts'
import type { HarnessInstallation } from '../contracts/installations.ts'
import { isRemovableCombination, modelRefKey } from '../contracts/catalog.ts'
import type { MiniMaxCandidateRequest, MiniMaxCandidateResult } from '../contracts/candidate.ts'
import { RuntimeMaintenance } from './runtime-maintenance.ts'
import { prepareMiniMaxCandidate } from './minimax-candidate.ts'
import { prepareCodexRuntime } from './codex-runtime.ts'
import type {
  CodexRuntimeRequest,
  CodexRuntimeResult,
  CodexGitBashRuntime,
} from '../contracts/codex-runtime.ts'
import { ExternalModelSources } from './model-sources.ts'
import { harnessAdapters } from './adapters/index.ts'
import { acceptVisibleCliResult } from './adapters/visible-result.ts'
import { GATEWAY_GROUPS } from '../../gateway/contracts/groups.ts'
/** Owns mappings and transport only; each official Harness owns its agent loop. */
import { randomUUID } from 'node:crypto'
import { MessageEditTransactions, unresolvedMessageEdit } from './message-edit.ts'
import { MessageEditStore } from './message-edit-store.ts'
import { FileExternalEditJournal } from './message-edit-external-store.ts'
import { ExternalMessageEditTransactions } from './message-edit-external.ts'
import type { ExternalEditHistory, ExternalMessageEditDriver } from './message-edit-driver.ts'
import { kimiMessageEditDriver } from './message-edit-kimi.ts'
import type { HarnessPromptPart } from '../contracts/prompt.ts'
import {
  currentHarnessInputText,
  harnessInputError,
  requireHarnessInputText,
} from './harness-input.ts'
import {
  echoesConversationContext,
  conversationInput,
  promptContentText,
  resolvePromptContent,
  assertPromptImages,
} from './multimodal-prompt.ts'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent/types'
import type { MessageEditSend, MessageEditState } from '../contracts/message-edit.ts'
import { access, mkdir, readFile, writeFile, rename, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startControlBridge } from '../../shared/host/control-bridge.ts'
import { EventEmitter } from 'node:events'
import {
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { HarnessReasoningPreflight, HarnessStartRequest } from '../../contracts/types.ts'
import { projectlessSessionCwd } from './projectless-path.ts'
import { canonicalHarnessContext, canonicalHarnessUsage, latestHarnessContext } from './usage.ts'
import { VibeTurnUsageTracker } from './usage-vibe.ts'
import {
  parseGrokTurnUsage,
  parseOpenCodeKiloTurnUsage,
  parsePoolContextUsage,
  parsePoolTurnUsage,
  parseMiniMaxContextUsage,
} from './usage-account.ts'
import { QwenTurnUsage } from './adapters/qwen/usage.ts'
import type { HarnessContextReading } from '../contracts/usage.ts'
export type { HarnessStartRequest } from '../../contracts/types.ts'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { minimaxExecutionRegion, saveMinimaxExecutionRegion } from './minimax-execution-region.ts'
import { oplProfilePath } from '../../shared/host/profile-paths.ts'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import {
  AcpProcess,
  HarnessConfigurationError,
  HarnessTransportError,
  HarnessRequestError,
  object,
} from './acp.ts'
import { nativeFailureMessage } from './native-failure.ts'
import {
  externalAskFromToolCall,
  type HarnessExternalApprovalBinding,
  type HarnessExternalAsk,
} from './external-binding.ts'
import { waitForSession } from './session-wait.ts'
import {
  DSH_COMBINATION,
  type HarnessCatalog,
  type HarnessOrigin,
  type HarnessSession,
  type HarnessSnapshot,
  type HarnessTurn,
  type CollaborationReport,
} from '../contracts/sessions.ts'
import { ExternalEffortStore } from './external-effort-store.ts'
import { ExecutionModelResolver } from './execution-models.ts'
import { assertOfmModelAvailable } from './model-admission.ts'
import { OFM_PROVIDERS } from './ofm-source/provider.ts'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { CombinationDefinition, ModelRef } from '../contracts/catalog.ts'
import { adapterFor, defaultHarness } from './adapters/index.ts'
import { connectDsh } from './adapters/dsh.ts'
import {
  MINIMAX_CODE_HARNESS,
  MINIMAX_CODE_PROVIDER,
  isMiniMaxCodeRoute,
  minimaxReasoning,
} from './adapters/minimax.ts'
import type { AdapterOptions, HarnessAdapter } from './adapters/types.ts'
import { HarnessSessionStore } from './session-store.ts'
import { NativeHarnessConversations, harnessRequestId } from './native-conversations.ts'
import { StopEditService, type StopEditHost } from './stop-edit.ts'
import { StopEditIntentStore } from './stop-edit-intent.ts'
import { HISTORY_BOUNDARY } from './stop-edit-minimax.ts'
import { harnessAllowsFullAccess } from './permissions.ts'
import { resolveWriteScope } from './write-scope.ts'
import { harnessProxyEnvironment } from './proxy.ts'
import type {
  HarnessTaskSummary,
  HarnessSessionSummary,
  HarnessSessionsRequest,
  HarnessSessionsPage,
  HarnessDetailRequest,
  HarnessDetailPage,
} from '../contracts/views.ts'
import {
  catalogView,
  defaultExecutionCatalog,
  ExecutionCatalogStore,
  normalizeCatalog,
  type ExecutionCatalog,
} from './catalog.ts'
import {
  asSessionId,
  hash,
  now,
  required,
  type Active,
  type HarnessPromptRequest,
  type SelectionChangeState,
} from './harness-types.ts'
import {
  assertMiniMaxNativeSelectionEnabled,
  bindRoleCombination,
  cliOwnsEffort,
  combinationFor,
  conversationEffort,
  modelSelection,
  normalizeConversationSelection,
  reasoningPreflight,
  reasoningPreflightAdmitted,
  replacementFor,
  selectCombination,
  selectEffort,
  selectionForModel,
  unavailableConversationSelection,
  type HarnessSelectionHost,
} from './harness-selection.ts'
import {
  announceApproval,
  announceQuestion,
  cancelTask,
  cooperationSettings,
  delegateFrom,
  drainQueue,
  flushDeliveries,
  registerNotification,
  reportNotification,
  requireExternalReviewer,
  resultFor,
  retryDelivery,
  reviewTask,
  saveCooperationSettings,
  submitReport,
  syncNotification,
  taskResult,
  tasksFor,
  taskSummaries,
  turnSummary,
  type HarnessDelegationHost,
} from './harness-delegation.ts'
import {
  acknowledgeStopEditDraft,
  assertStopEditIdle,
  claimMessageEdit,
  commitMessageEdit,
  commitStopEdit,
  disconnectIdleConnection,
  externalContext,
  externalDriver,
  externalHistory,
  externalRecoveryHistory,
  messageEditSend,
  messageEditState,
  rebindNativeBranch,
  recordMiniMaxUsage,
  recordNativeBoundary,
  stopEdit,
  stopEditBlocked,
  stopEditBusy,
  stopEditHost,
  stopEditReviewBySession,
  stopEditRuntime,
  stopEditSettle,
  stopEditTarget,
  storedKiloHistory,
  supportsExternalEditing,
  type HarnessStopEditContext,
} from './harness-stop-edit.ts'
export { GROK_COMBINATION, DSH_COMBINATION } from '../contracts/sessions.ts'
export const HARNESS_NAMESPACE = 'harness'
export type { HarnessPromptRequest }

/** Preserve ACP usage only when the agent explicitly marks it as per-prompt. */
function acpUsage(value: unknown): TokenUsage | undefined {
  const usage = object(value)
  const owned = object(object(usage._meta)['opl/turnUsage'])
  if (owned.version === 1) return canonicalHarnessUsage(owned.usage)
  if (object(usage._meta)['opl/usageSemantics'] !== 'per-prompt') return undefined
  const integer = (key: string): number | undefined => {
    const next = usage[key]
    return typeof next === 'number' && Number.isSafeInteger(next) && next >= 0 ? next : undefined
  }
  const inputTokens = integer('inputTokens')
  const outputTokens = integer('outputTokens')
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const totalTokens = integer('totalTokens')
  const cacheReadTokens = integer('cachedReadTokens')
  const cacheWriteTokens = integer('cachedWriteTokens')
  const reasoningTokens = integer('thoughtTokens')
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

/** Read ACP's experimental context occupancy update without using it as token billing. */
function acpContextUsage(
  value: unknown,
): import('../contracts/usage.ts').HarnessContextUsage | undefined {
  const update = object(value)
  const used = update.used
  const size = update.size
  if (
    typeof used !== 'number' ||
    !Number.isSafeInteger(used) ||
    used < 0 ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    used > size
  )
    return undefined
  return { used, size }
}

export { grokConfiguration } from './adapters/grok.ts'
export { nativeHarnessMatches, defaultHarness } from './adapters/index.ts'
declare module '@deepseek-ai/cordis' {
  interface Context {
    oplHarness: HarnessService
  }
}
export class HarnessService {
  private minimaxCodeEnabledSource: (() => boolean) | undefined
  private minimaxIntegrationEnabled: boolean | undefined
  private minimaxLoginAttempt:
    { region: MiniMaxAccountLoginRequest['region']; cancelled: boolean } | undefined
  private readonly minimaxAccount = new MiniMaxAccount(async () => {
    const harness = (await this.catalogStore.get()).harnesses.find(
      (item) => item.id === 'minimax-code',
    )
    return {
      ...(harness?.command ? { command: harness.command } : {}),
      ...(harness?.prefix ? { prefix: harness.prefix } : {}),
    }
  })
  isMinimaxCodeEnabled(): boolean {
    return this.minimaxCodeEnabledSource?.() ?? true
  }
  configureMiniMaxCodeIntegration(enabled: () => boolean): void {
    this.minimaxCodeEnabledSource = enabled
  }
  private assertMinimaxCodeEnabled(): void {
    if (!this.isMinimaxCodeEnabled())
      throw new HarnessConfigurationError(
        'MiniMax 官方 mcode 集成已停用；原配置、凭据和会话仍保留，不会自动改用其他路线。',
      )
  }
  private assertMiniMaxCodeRouteEnabled(route: { harnessRef: string; modelRef: ModelRef }): void {
    if (isMiniMaxCodeRoute(route)) this.assertMinimaxCodeEnabled()
  }
  /** Apply the accepted volatile value and cooperatively stop an owned pending login. */
  async synchronizeMiniMaxCodeIntegration(): Promise<void> {
    const enabled = this.isMinimaxCodeEnabled()
    if ((this.minimaxIntegrationEnabled ?? true) === enabled) return
    this.minimaxIntegrationEnabled = enabled
    this.events.emit('catalog')
    if (enabled) return
    const attempt = this.minimaxLoginAttempt
    if (!attempt) return
    attempt.cancelled = true
    await this.minimaxAccount.cancel(attempt.region)
  }
  async minimaxRegion() {
    const harness = (await this.catalogStore.get()).harnesses.find((h) => h.id === 'minimax-code')
    return {
      region: await minimaxExecutionRegion(this.directory, harness?.prefix ?? this.options.prefix),
    }
  }
  async selectMinimaxRegion(request: MiniMaxAccountLoginRequest) {
    this.assertMinimaxCodeEnabled()
    await this.ready
    return this.runtimeMaintenance.change(
      () =>
        [...this.records.values()].some(
          (r) =>
            r.harnessRef === 'minimax-code' &&
            (this.connecting.has(r.id) ||
              this.externalEditing.has(r.id) ||
              this.active.get(r.id)?.turn ||
              r.turns.some((t) =>
                [
                  'queued',
                  'running',
                  'waiting_approval',
                  'waiting_input',
                  'waiting_child',
                  'needs_approval',
                  'needs_input',
                ].includes(t.state),
              )),
        ) || this.minimaxAccount.updateBusy(),
      async () => {
        await saveMinimaxExecutionRegion(this.directory, request.region)
        this.events.emit('catalog')
        return { region: request.region }
      },
    )
  }
  minimaxAccountStatus(request: MiniMaxAccountLoginRequest) {
    this.assertMinimaxCodeEnabled()
    return this.minimaxAccount.status(request.region)
  }
  minimaxAccountCancel(request: MiniMaxAccountLoginRequest) {
    // Cancellation owns cleanup, so it must remain available after opt-out.
    if (this.minimaxLoginAttempt?.region === request.region)
      this.minimaxLoginAttempt.cancelled = true
    return this.minimaxAccount.cancel(request.region)
  }
  async minimaxAccountLogout(request: MiniMaxAccountLoginRequest) {
    this.assertMinimaxCodeEnabled()
    await this.ready
    return this.runtimeMaintenance.change(
      () => this.runtimeBusy(),
      async () => {
        await this.assertNoGlobalActivity()
        return this.minimaxAccount.logout(request.region)
      },
    )
  }
  async minimaxAccountLogin(request: MiniMaxAccountLoginRequest) {
    this.assertMinimaxCodeEnabled()
    if (this.minimaxLoginAttempt) throw Error('官方登录尚未结束')
    const attempt = { region: request.region, cancelled: false }
    this.minimaxLoginAttempt = attempt
    try {
      await this.ready
      if (attempt.cancelled || !this.isMinimaxCodeEnabled())
        return this.minimaxAccount.status(request.region)
      return await this.runtimeMaintenance.change(
        () => this.runtimeBusy(),
        async () => {
          await this.assertNoGlobalActivity()
          if (attempt.cancelled || !this.isMinimaxCodeEnabled())
            return this.minimaxAccount.status(request.region)
          return this.minimaxAccount.login(request.region)
        },
      )
    } finally {
      if (this.minimaxLoginAttempt === attempt) this.minimaxLoginAttempt = undefined
    }
  }

  private progressLimits?: ProgressWatchdogLimits
  configureProgressLimits(limits: ProgressWatchdogLimits): void {
    this.progressLimits = {
      firstProgressMs: limits.firstProgressMs,
      idleProgressMs: limits.idleProgressMs,
      enabled: limits.enabled,
    }
  }
  /** Return the limits used when the next turn starts. */
  executionLimits(): ProgressWatchdogLimits {
    return {
      ...(this.progressLimits ?? (executionLimitsSchema({}) as ProgressWatchdogLimits)),
    }
  }
  /** Persist validated limits and apply them to subsequent turns. */
  async saveExecutionLimits(value: unknown): Promise<ProgressWatchdogLimits> {
    const limits = executionLimitsSchema(value as never) as ProgressWatchdogLimits
    const descriptor = featureSettings(this.ctx, 'opl-execution')
    if (!descriptor) throw Error('执行设置不可用')
    await this.ctx.settings.mutate(
      descriptor.ns,
      [{ op: 'set', path: ['executionLimits'], value: limits }],
      descriptor.revision,
    )
    this.configureProgressLimits(limits)
    return this.executionLimits()
  }

  private readonly runtimeMaintenance = new RuntimeMaintenance()
  private selections: Record<string, string> = {}
  private readonly externalEfforts: ExternalEffortStore
  private readonly effortChanges = new Map<string, symbol>()
  private readonly conversationOwners = new Map<
    string,
    { sessionId: string; signal?: AbortSignal }
  >()
  /** Serialize picker writes with the next prompt for each official Session. */
  private readonly selectionChanges = new Map<string, SelectionChangeState>()
  private readonly maintenance = new Map<string, NonNullable<HarnessInstallation['maintenance']>>()
  readonly engineUpdates: EngineUpdates
  private readonly engineAdmissions = new Map<string, number>()
  private engineBusy(id: string): boolean {
    return (
      this.engineAdmissions.has(id) ||
      this.maintenanceJobs.has(id) ||
      (id === MINIMAX_CODE_HARNESS &&
        (!!this.minimaxLoginAttempt || this.minimaxAccount.updateBusy())) ||
      [...this.records.values()].some(
        (r) =>
          r.harnessRef === id &&
          (this.externalEditing.has(r.id) ||
            this.finalizing.has(r.id) ||
            this.stopEdits.editing(r.acpSessionId) ||
            (r.nativeSessionId && this.stopEdits.editing(r.nativeSessionId)) ||
            this.connecting.has(r.id) ||
            this.active.get(r.id)?.turn ||
            r.turns.some((t) =>
              [
                'queued',
                'running',
                'waiting_approval',
                'waiting_input',
                'waiting_child',
                'needs_approval',
                'needs_input',
              ].includes(t.state),
            )),
      )
    )
  }
  private async enterEngine<T>(id: string, operation: () => Promise<T>): Promise<T> {
    let update = this.engineUpdates.lock(id) ?? this.maintenanceJobs.get(id)
    while (update) {
      await update
      update = this.engineUpdates.lock(id) ?? this.maintenanceJobs.get(id)
    }
    this.engineAdmissions.set(id, (this.engineAdmissions.get(id) ?? 0) + 1)
    try {
      return await operation()
    } finally {
      const count = (this.engineAdmissions.get(id) ?? 1) - 1
      if (count) this.engineAdmissions.set(id, count)
      else this.engineAdmissions.delete(id)
    }
  }
  private async closeIdleEngineConnections(id: string) {
    for (const [sessionId, connection] of this.active) {
      const record = this.records.get(sessionId)
      if (record?.harnessRef === id) await this.disconnectIdleConnection(record, connection)
    }
  }
  private readonly maintenanceJobs = new Map<string, Promise<void>>()
  private readonly records = new Map<string, HarnessSession>()
  private readonly dirtyRecords = new Map<string, HarnessSession>()
  private readonly titleUpdates = new Map<string, Promise<void>>()
  private readonly active = new Map<string, Active>()
  private readonly starting = new Map<string, Promise<HarnessSnapshot>>()
  private readonly connecting = new Map<string, Promise<void>>()
  private readonly reasoningPreflights = new Map<string, Promise<HarnessReasoningPreflight>>()
  private readonly events = new EventEmitter()
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly ready: Promise<void>
  private readonly selectionsReady: Promise<void>
  private readonly recordsReady: Promise<void>
  private disposed = false
  private pumping = false
  private readonly observed = new Set<string>()
  private readonly deliveryJobs = new Set<string>()
  private readonly pendingRuns = new Map<string, () => void>()
  private readonly tick: ReturnType<typeof setInterval>
  readonly directory: string
  readonly modelSources: ExternalModelSources
  private readonly sessionStore: HarnessSessionStore
  private readonly revisionEpoch = randomUUID()
  private revisionCounter = 0
  private readonly runtimeConnections = new Map<string, boolean>()
  /** Monotonic source of {@link Active.generation}; never reused within a process. */
  private connectionGeneration = 0
  private readonly catalogStore: ExecutionCatalogStore
  private readonly modelResolver: ExecutionModelResolver
  /** Share one catalog build among the parallel catalog/combination/selection reads. */
  private executionCatalogPending:
    { minimaxCodeEnabled: boolean; promise: Promise<ExecutionCatalog> } | undefined
  private readonly availabilityPending = new WeakMap<
    ExecutionCatalog,
    Promise<Map<string, { available: boolean; reason?: string }>>
  >()
  private readonly stopEdits: StopEditService
  private readonly stopEditIntents: StopEditIntentStore
  private readonly messageEditStore: MessageEditStore
  private readonly messageEdits: MessageEditTransactions
  private readonly externalEditJournal: FileExternalEditJournal
  private readonly externalMessageEdits: ExternalMessageEditTransactions
  private readonly externalEditing = new Set<string>()
  /** A terminal turn can still own a history read and its replacement ACP connection. */
  private readonly finalizing = new Map<string, Promise<void>>()
  private readonly externalHistories = new Map<
    string,
    { fingerprint: string; history: ExternalEditHistory }
  >()
  constructor(
    private readonly ctx: Context,
    private readonly options: {
      home?: string
      command?: string
      prefix?: string[]
      resolveKey?: () => Promise<string | undefined>
      readOfm?: () => Promise<unknown>
      minimaxCodeEnabled?: () => boolean
    } = {},
    private readonly conversations?: NativeHarnessConversations,
  ) {
    this.minimaxCodeEnabledSource = options.minimaxCodeEnabled
    this.minimaxIntegrationEnabled = this.isMinimaxCodeEnabled()
    this.directory = options.home ?? dshHomePath()
    this.modelSources = new ExternalModelSources(ctx, () => this.events.emit('catalog'))
    this.sessionStore = new HarnessSessionStore(this.directory)
    this.catalogStore = new ExecutionCatalogStore(this.directory)
    this.modelResolver = new ExecutionModelResolver(
      ctx,
      this.catalogStore,
      (ref) => this.probeExternalModel(ref),
      options.readOfm,
      () => this.isMinimaxCodeEnabled(),
    )
    this.events.setMaxListeners(100)
    this.stopEditIntents = new StopEditIntentStore(this.directory)
    this.messageEditStore = new MessageEditStore(this.directory)
    this.messageEdits = new MessageEditTransactions(this.messageEditStore)
    this.externalEditJournal = new FileExternalEditJournal(this.directory)
    this.externalMessageEdits = new ExternalMessageEditTransactions(this.externalEditJournal)
    this.stopEdits = new StopEditService(this.stopEditHost())
    this.externalEfforts = new ExternalEffortStore(this.directory)
    this.selectionsReady = Promise.all([this.loadSelections(), this.externalEfforts.ready]).then(
      () => {},
    )
    this.recordsReady = this.load()
    this.ready = Promise.all([
      this.recordsReady,
      this.selectionsReady,
      // 编辑意图台账必须先恢复，否则一次未完成的编辑会被当成从未发生过。
      this.stopEditIntents.load(),
      this.messageEditStore.load(),
      this.externalEditJournal.load(),
    ]).then(async () => {
      if (!this.conversations) return
      for (const record of this.records.values()) {
        try {
          // A persisted native identity already belongs to the official Session
          // store. Reopen that Session when it is used, not every desktop startup.
          if (record.nativeSessionId) {
            if (this.selections[record.nativeSessionId] === undefined)
              await this.bindSelection(record.nativeSessionId, record.combination)
            continue
          }
          await this.ensureConversation(record)
        } catch (error) {
          // An unavailable historical project or model must not erase its record
          // or prevent other conversations from being imported.
          this.ctx.logger.warn(`外部会话 ${record.id} 迁移未完成：${String(error)}`)
        }
      }
    })
    this.engineUpdates = new EngineUpdates(this.directory, {
      list: () => this.installations(),
      probe: checkEngineUpdate,
      busy: (id) => this.engineBusy(id),
      install: (item, target) =>
        this.runtimeMaintenance.admit(async () => {
          const def = (await this.catalogStore.get()).harnesses.find((h) => h.id === item.id)
          if (!def || JSON.stringify(def) !== JSON.stringify(item.definition))
            throw Error('启动入口配置已变化，请重新检查')
          const fresh = await inspectHarness(def, this.directory, this.command(), { fresh: true })
          if (fresh.path !== item.path || fresh.version !== item.version)
            throw Error('启动入口或版本已变化，请重新检查')
          if (!usesPrivateUpdateDirectory(fresh)) await this.closeIdleEngineConnections(item.id)
          const result = await applyEngineUpdate({ ...fresh, definition: def }, target, (message) =>
            this.ctx.logger.warn(message),
          )
          if (result.path && result.path !== fresh.path)
            await this.catalogStore.setHarnessLaunch(item.id, result.path, [], { definition: def })
          this.events.emit('catalog')
          return result.version
        }),
      log: (message) => this.ctx.logger.warn(message),
    })
    this.tick = setInterval(() => {
      void this.flushDeliveries().catch(() => {})
    }, 2000)
    this.tick.unref()
  }

  /** Reserve one ordinary Session identity and its projectless working directory. */
  async createProjectlessSession(): Promise<{ sessionId: string; cwd: string }> {
    await this.ready
    const sessionId = asSessionId(`session-${randomUUID()}`)
    const cwd = projectlessSessionCwd(this.directory, sessionId)
    return { sessionId, cwd }
  }
  private async loadSelections() {
    try {
      const value = JSON.parse(
        await readFile(oplProfilePath(this.directory, 'combination-selection.json'), 'utf8'),
      ) as unknown
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.values(value).some((item) => typeof item !== 'string')
      )
        throw Error('组合选择记录无效')
      this.selections = value as Record<string, string>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  private async bindSelection(sessionId: string, combination: string) {
    this.selections[sessionId] = combination
    const bytes = JSON.stringify(this.selections, null, 2) + '\n'
    const filename = oplProfilePath(this.directory, 'combination-selection.json')
    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
      const temp = filename + '.' + randomUUID()
      await writeFile(temp, bytes, { mode: 0o600 })
      await rename(temp, filename)
    })
    this.writeQueue = write.catch(() => {})
    await write
  }
  /** Wait for a model picker write that began before this prompt. */
  private async waitForSelectionChange(sessionId: string): Promise<boolean> {
    let waited = false
    for (;;) {
      const pending = this.selectionChanges.get(sessionId)
      if (!pending) return waited
      waited = true
      await pending.promise
      const current = this.selectionChanges.get(sessionId)
      if (current && current !== pending) continue
      if (pending.failed)
        throw new LlmError('模型切换尚未完成，请重新选择后发送；本轮未发送。', 'HARNESS_BINDING')
      return waited
    }
  }

  /** Run one picker write after the previous write and expose its completion to prompts. */
  private async runSelectionChange<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.selectionChanges.get(sessionId)
    const state: SelectionChangeState = {
      promise: Promise.resolve(),
      failed: false,
    }
    let result!: T
    state.promise = (async () => {
      await previous?.promise
      try {
        result = await operation()
      } catch (error) {
        state.failed = true
        state.error = error
      }
    })()
    this.selectionChanges.set(sessionId, state)
    try {
      await state.promise
      if (state.failed) throw state.error
      return result
    } finally {
      // A failed picker write must keep blocking later sends, including sends begun
      // after its RPC rejected. A successful explicit selection clears that refusal.
      if (!state.failed && this.selectionChanges.get(sessionId) === state)
        this.selectionChanges.delete(sessionId)
    }
  }
  private async ensureConversation(record: HarnessSession) {
    if (record.harnessRef !== 'dsh' && record.origin.kind === 'dsh') {
      if (!record.nativeSessionId) {
        record.nativeSessionId = record.origin.sessionId
        await this.save(record)
      }
      return
    }
    if (!this.conversations || record.harnessRef === 'dsh') return
    if (
      record.nativeSessionId &&
      this.ctx.agents.get(asSessionId<SessionId>(record.nativeSessionId))?.status === 'running'
    )
      return
    await this.conversations.ensure(record, () => this.save(record))
    // The conversation owner seeds model/selection on creation. Replaying the
    // picker RPC here would overwrite user choices and save each historical
    // model as the deployment default during restart.
    if (this.selections[record.nativeSessionId!] === undefined)
      await this.bindSelection(record.nativeSessionId!, record.combination)
  }
  private zcodeModeForOrigin(origin: HarnessOrigin): 'build' | 'yolo' {
    if (origin.kind !== 'dsh') return 'yolo'
    const session = this.ctx.sessions.get(asSessionId<SessionId>(origin.sessionId))
    if (!session) throw Error('ZCode 的原生会话已不存在')
    return this.ctx.permissionPresets.current(session) === 'auto' ? 'build' : 'yolo'
  }
  private conversationBinding(session: Session, definition: CombinationDefinition) {
    if (!session.header.cwd) throw Error('请先选择项目目录')
    const policy = this.ctx.agents.get(session.id)?.ctx.get('sandboxPolicy')?.resolve({ session })
    const preset = this.ctx.permissionPresets.current(session)
    const mode = policy?.mode ?? preset
    const sandbox =
      mode === 'read-only'
        ? 'read-only'
        : mode === 'danger-full-access' && harnessAllowsFullAccess(definition.harnessRef)
          ? 'full-access'
          : 'workspace'
    return {
      cwd: session.header.cwd,
      sandbox,
      taskId: `conversation:${definition.id}:${sandbox}`,
    } as const
  }
  private async load() {
    for (const record of await this.sessionStore.load()) {
      for (const turn of record.turns) {
        if (
          ['queued', 'running', 'waiting_child', 'waiting_approval', 'waiting_input'].includes(
            turn.state,
          )
        ) {
          turn.state = 'interrupted'
          turn.error = 'Host 已重启；原轮次不会自动重发，可用新的 operation 继续原生会话'
        }
        if (turn.delivery?.state === 'delivering') turn.delivery.state = 'pending'
        if (record.assignment && turn.state === 'interrupted')
          turn.delivery ??= {
            id: hash([record.id, turn.operationId]),
            state: 'pending',
            attempt: 0,
          }
      }
      this.records.set(record.id, record)
    }
    await this.sessionStore.saveChanged(this.records.values())
  }
  private async save(record: HarnessSession): Promise<void> {
    this.dirtyRecords.set(record.id, record)
    await this.flushRecords()
  }
  private async flushRecords(): Promise<void> {
    const pending = [...this.dirtyRecords.values()]
    this.dirtyRecords.clear()
    try {
      const changed = await this.sessionStore.saveChanged(pending)
      if (changed.length) this.revisionCounter += 1
    } catch (error) {
      // Retain the latest live objects, including edits made while the write awaited.
      for (const item of pending) this.dirtyRecords.set(item.id, this.records.get(item.id) ?? item)
      throw error
    }
  }
  private changed(record: HarnessSession) {
    record.updatedAt = now()
    this.dirtyRecords.set(record.id, record)
    this.revisionCounter += 1
    this.events.emit(record.id)
  }
  /** Record ACP capacity inside an open official turn; idle observations stay in Harness state. */
  private recordContextWindow(record: HarnessSession, active: Active, size: number) {
    const nativeSessionId = record.nativeSessionId
    if (!nativeSessionId || active.contextWindowRecorded === size) return
    const session = this.ctx.sessions?.get(asSessionId<SessionId>(nativeSessionId))
    if (!session) return
    const boundary = session
      .snapshotEvents()
      .findLast((event) => event.type === 'turn/start' || event.type === 'turn/end')
    if (boundary?.type !== 'turn/start') return
    const current = session.requestContext?.()
    if (
      current?.provider === record.modelRef.provider &&
      current.model === record.modelRef.model &&
      current.contextWindow === size
    ) {
      active.contextWindowRecorded = size
      return
    }
    session.append('request/context', {
      provider: record.modelRef.provider,
      model: record.modelRef.model,
      contextWindow: size,
    })
    active.contextWindowRecorded = size
  }
  private revision(): string {
    for (const record of this.records.values()) {
      const active = this.active.get(record.id)
      const connected =
        record.harnessRef === 'dsh'
          ? !!this.ctx.agents?.get(asSessionId<SessionId>(record.acpSessionId))
          : !!active?.acp && !active.acp.closed
      if (this.runtimeConnections.get(record.id) !== connected) {
        this.runtimeConnections.set(record.id, connected)
        this.revisionCounter += 1
      }
    }
    return this.revisionEpoch + ':' + this.revisionCounter
  }
  private command() {
    return this.options.command ?? (process.env.OPL_GROK_COMMAND?.trim() || 'grok')
  }
  private adapterOptions(
    command?: string,
    prefix?: string[],
    codexRuntime?: CodexGitBashRuntime,
  ): AdapterOptions {
    const launchPrefix = prefix ?? this.options.prefix
    return {
      home: this.directory,
      modelSources: this.modelSources,
      ...(codexRuntime ? { codexRuntime } : {}),
      grokCommand: this.command(),
      nativeBridgePath: fileURLToPath(new URL('./native-harness-bridge.mjs', import.meta.url)),
      ...(command ? { command } : {}),
      ...(launchPrefix ? { prefix: launchPrefix } : {}),
      ...(this.options.resolveKey ? { resolveKey: this.options.resolveKey } : {}),
    }
  }
  async installations() {
    const catalog = await this.catalogStore.get()
    return Promise.all(
      catalog.harnesses.map(async (harness) => {
        const item = await inspectHarness(harness, this.directory, this.command()),
          maintenance = this.maintenance.get(harness.id)
        const capabilities = harnessAdapters.find(
          (adapter) => adapter.id === harness.id,
        )?.capabilities
        const result: HarnessInstallation = {
          ...item,
          definition: harness,
          ...(capabilities
            ? {
                capabilities: harness.codexRuntime
                  ? { ...capabilities, permissions: ['full-access'] as ['full-access'] }
                  : capabilities,
              }
            : {}),
          ...(harness.codexRuntime
            ? {
                installable: false,
                instructions: 'OPL Git Bash 固定候选；升级与回切使用 Codex 运行时选择入口。',
              }
            : {}),
          ...(maintenance ? { maintenance } : {}),
        }
        if (harness.codexRuntime) delete result.maintenanceAction
        return result
      }),
    )
  }
  async updateHarness(id: string) {
    return this.runtimeMaintenance.admit(() => this.updateHarnessAdmitted(id))
  }
  private async updateHarnessAdmitted(id: string) {
    await this.ready
    if (this.disposed) throw Error('Harness 服务已关闭')
    if (this.maintenanceJobs.has(id)) return this.maintenance.get(id)
    if (this.engineBusy(id) || this.engineUpdates.lock(id))
      throw Error('此 Harness 正在执行任务，请完成后更新')
    const catalog = await this.catalogStore.get(),
      definition = catalog.harnesses.find((item) => item.id === id)
    if (!definition) throw Error('Harness 不存在')
    if (definition.codexRuntime)
      throw Error('Codex Git Bash 候选不使用官方更新器；请先回切官方或导入已验收新候选')
    const item = await inspectHarness(definition, this.directory, this.command())
    if (!item.maintenanceAction) throw Error('请使用此 Harness 的官方安装与更新入口')
    // Recheck after discovery so concurrent clicks cannot launch two updaters.
    if (this.maintenanceJobs.has(id)) return this.maintenance.get(id)
    if (this.engineBusy(id) || this.engineUpdates.lock(id))
      throw Error('此 Harness 正在执行任务或更新，请完成后再试')
    const state: NonNullable<HarnessInstallation['maintenance']> = {
      state: 'running',
      message: '正在运行官方安装或更新器…',
      startedAt: now(),
    }
    this.maintenance.set(id, state)
    const job = (async () => {
      try {
        const result = await this.engineUpdates.runExternalInstaller(async () => {
          await this.closeIdleEngineConnections(id)
          return maintainHarness(item, definition.proxy)
        })
        const fresh = await inspectInstalledHarness(
          definition,
          this.directory,
          result,
          this.command(),
        )
        if (fresh.verification !== 'verified' || !fresh.version)
          throw Error(
            `${fresh.error ?? '更新器已结束，但版本回读失败，请重新检测'}\n${result.message}`,
          )
        if (
          result.expectedVersion &&
          fresh.version.match(/\d+\.\d+\.\d+/)?.[0] !== result.expectedVersion
        )
          throw Error(
            `已下载 ${result.expectedVersion}，但当前启动入口仍运行 ${fresh.version}；请修复原安装器的启动入口后重试`,
          )
        const managedCommand =
          !definition.command ||
          definition.command ===
            defaultExecutionCatalog().harnesses.find((entry) => entry.id === id)?.command
        if (managedCommand && !item.installed && fresh.path) {
          const latest = await this.catalogStore.get()
          latest.harnesses = latest.harnesses.map((h) =>
            h.id === id && h.command === definition.command && fresh.path
              ? { ...h, command: fresh.path }
              : h,
          )
          await this.catalogStore.set(latest)
        }
        this.maintenance.set(id, {
          ...state,
          state: 'completed',
          message: result.message,
          finishedAt: now(),
        })
      } catch (error) {
        this.maintenance.set(id, {
          ...state,
          state: 'failed',
          message: error instanceof Error ? error.message : '安装或更新失败',
          finishedAt: now(),
        })
      } finally {
        this.maintenanceJobs.delete(id)
      }
    })()
    this.maintenanceJobs.set(id, job)
    return { ...state }
  }
  async combinations(
    request: { includeDisabled?: boolean } = {},
  ): Promise<HarnessCatalog['combinations']> {
    const catalog = await this.executionCatalog()
    let pending = this.availabilityPending.get(catalog)
    if (!pending) {
      pending = this.probeCatalogAvailability(catalog)
      this.availabilityPending.set(catalog, pending)
      const clear = () => {
        if (this.availabilityPending.get(catalog) === pending)
          this.availabilityPending.delete(catalog)
      }
      void pending.then(clear, clear)
    }
    return catalogView(catalog, await pending, request.includeDisabled === true)
  }
  /** Concurrent readers of the same snapshot share only unfinished CLI checks. */
  private async probeCatalogAvailability(catalog: ExecutionCatalog) {
    const availability = new Map<string, { available: boolean; reason?: string }>()
    const probes = new Map<HarnessAdapter, Promise<{ available: boolean; reason?: string }>>()
    const pending = new Map<string, Promise<{ available: boolean; reason?: string }>>()
    for (const combination of catalog.combinations) {
      const model = catalog.models.find(
        (item) => modelRefKey(item.ref) === modelRefKey(combination.modelRef),
      )
      const harness = catalog.harnesses.find((item) => item.id === combination.harnessRef)
      const adapter = adapterFor(combination.harnessRef, combination.modelRef, this.modelSources)
      if (!model?.available)
        availability.set(combination.id, {
          available: false,
          reason: model?.reason ?? '模型未配置或凭据未就绪',
        })
      else if (!adapter || !harness)
        availability.set(combination.id, {
          available: false,
          reason: '该模型与 Harness 尚无兼容适配器',
        })
      else {
        if (!probes.has(adapter))
          probes.set(
            adapter,
            Promise.resolve().then(() =>
              adapter.available(
                this.ctx,
                this.adapterOptions(harness.command, harness.prefix, harness?.codexRuntime),
              ),
            ),
          )
        pending.set(combination.id, probes.get(adapter)!)
      }
    }
    await Promise.all(
      [...pending].map(async ([id, probe]) => {
        availability.set(id, await probe)
      }),
    )
    return availability
  }
  /** Legacy external callers may still request full snapshots. UI uses pages. */
  async list(): Promise<HarnessCatalog> {
    return {
      combinations: await this.combinations(),
      sessions: [...this.records.values()]
        .map((record) => this.view(record))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }
  }
  /** Report local admission separately from upstream inference for the visible conversation. */
  async queueStatus(sessionId: string): Promise<{ queued: boolean }> {
    await this.ready
    return {
      queued: [...this.records.values()].some(
        (record) => record.nativeSessionId === sessionId && record.turns.at(-1)?.state === 'queued',
      ),
    }
  }
  async sessions(request: HarnessSessionsRequest = {}): Promise<HarnessSessionsPage> {
    await this.ready
    const limit = this.pageLimit(request.limit, 30)
    const revision = `${this.revision()}:list:${request.cursor ?? ''}:${limit}`
    if (request.revision === revision) return { items: [], revision, unchanged: true }
    const records = [...this.records.values()].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    )
    const index = request.cursor ? records.findIndex((record) => record.id === request.cursor) : -1
    if (request.cursor && index < 0) throw Error('会话分页游标不存在，请刷新列表')
    const page = records.slice(index + 1, index + 1 + limit)
    return {
      items: page.map((record) => this.summary(record)),
      revision,
      unchanged: false,
      ...(index + 1 + page.length < records.length && page.length
        ? { nextCursor: page.at(-1)!.id }
        : {}),
    }
  }
  async detail(request: HarnessDetailRequest): Promise<HarnessDetailPage> {
    await this.ready
    const record = this.records.get(required(request.sessionId, 'sessionId'))
    if (!record) throw Error('执行组合会话不存在')
    const totalTurns = record.turns.length,
      limit = this.pageLimit(request.limit, 30)
    if (
      request.beforeTurn !== undefined &&
      (!Number.isSafeInteger(request.beforeTurn) || request.beforeTurn < 0)
    )
      throw Error('轮次分页游标无效')
    const end = Math.min(request.beforeTurn ?? totalTurns, totalTurns),
      beforeTurn = Math.max(0, end - limit)
    const revision = `${this.revision()}:detail:${record.id}:${request.beforeTurn ?? 'latest'}:${limit}`
    if (request.revision === revision) return { revision, unchanged: true, totalTurns, beforeTurn }
    return {
      revision,
      unchanged: false,
      session: this.view(record, record.turns.slice(beforeTurn, end)),
      totalTurns,
      beforeTurn,
    }
  }
  private pageLimit(value: number | undefined, fallback: number): number {
    if (value === undefined) return fallback
    if (!Number.isSafeInteger(value) || value < 1 || value > 100)
      throw Error('分页条数必须为 1 至 100')
    return value
  }
  private summary(record: HarnessSession): HarnessSessionSummary {
    const active = this.active.get(record.id)
    return structuredClone({
      id: record.id,
      combination: record.combination,
      harnessRef: record.harnessRef,
      modelRef: record.modelRef,
      cwd: record.cwd,
      acpSessionId: record.acpSessionId,
      origin: record.origin,
      title: record.title,
      sandbox: record.sandbox,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.assignment ? { assignment: record.assignment } : {}),
      ...(record.autoWakePaused !== undefined ? { autoWakePaused: record.autoWakePaused } : {}),
      connected:
        record.harnessRef === 'dsh'
          ? !!this.ctx.agents?.get(asSessionId<SessionId>(record.acpSessionId))
          : !!active?.acp && !active.acp.closed,
      state: record.turns.at(-1)?.state ?? 'idle',
      turnCount: record.turns.length,
      ...(record.turns.at(-1)?.review
        ? { lastReviewDecision: record.turns.at(-1)!.review!.decision }
        : {}),
      ...(record.turns.at(-1)?.delivery
        ? { lastDeliveryState: record.turns.at(-1)!.delivery!.state }
        : {}),
    })
  }
  async executionCatalog(): Promise<ExecutionCatalog> {
    if (this.disposed) throw Error('组合服务已关闭')
    const minimaxCodeEnabled = this.isMinimaxCodeEnabled()
    if (this.executionCatalogPending?.minimaxCodeEnabled === minimaxCodeEnabled)
      return this.executionCatalogAfter(this.executionCatalogPending.promise, minimaxCodeEnabled)
    const pending = this.modelResolver.resolve().then((catalog) => ({
      ...catalog,
      supportedPairings: catalog.models.map((model) => {
        const supported = catalog.harnesses.flatMap((harness) => {
          const adapter = adapterFor(harness.id, model.ref, this.modelSources)
          return adapter
            ? [
                {
                  harness: harness.id,
                  permissions:
                    harness.id === 'codex' && harness.codexRuntime
                      ? ['full-access' as const]
                      : adapter.capabilities.permissions,
                },
              ]
            : []
        })
        return {
          modelRef: model.ref,
          harnessRefs: supported.map((item) => item.harness),
          permissionPolicies: Object.fromEntries(
            supported.map((item) => [item.harness, [...item.permissions]]),
          ),
        }
      }),
    }))
    this.executionCatalogPending = { minimaxCodeEnabled, promise: pending }
    void pending.then(
      () => {
        if (this.executionCatalogPending?.promise === pending)
          this.executionCatalogPending = undefined
      },
      () => {
        if (this.executionCatalogPending?.promise === pending)
          this.executionCatalogPending = undefined
      },
    )
    return this.executionCatalogAfter(pending, minimaxCodeEnabled)
  }
  private async executionCatalogAfter(
    pending: Promise<ExecutionCatalog>,
    minimaxCodeEnabled: boolean,
  ): Promise<ExecutionCatalog> {
    const catalog = await pending
    // Every caller sharing a pending read gets the same post-resolution check.
    // Never publish a projection accepted before an opt-out/opt-in completed.
    return this.isMinimaxCodeEnabled() === minimaxCodeEnabled ? catalog : this.executionCatalog()
  }
  /**
   * Availability of a model owned by an external official CLI rather than by the OPL
   * Gateway. It reads the persisted catalog directly so the model projection cannot
   * recurse into itself, and it asks the owning adapter so "installed and signed in"
   * stays defined in exactly one place.
   */
  private async probeExternalModel(
    ref: ModelRef,
  ): Promise<{ available: boolean; reason?: string }> {
    const adapter = adapterFor(defaultHarness(ref), ref, this.modelSources)
    if (!adapter) return { available: false, reason: '该模型尚无兼容的官方 CLI 适配器' }
    try {
      const harness = (await this.catalogStore.get()).harnesses.find(
        (item) => item.id === adapter.id,
      )
      return await adapter.available(
        this.ctx,
        this.adapterOptions(harness?.command, harness?.prefix, harness?.codexRuntime),
      )
    } catch {
      return { available: false, reason: '官方 CLI 状态检测未完成，请重新打开此页' }
    }
  }
  async saveExecutionCatalog(value: unknown): Promise<ExecutionCatalog> {
    // A disabled projection can still be on screen after re-enabling. Preserve its
    // hidden rows according to that view as well as the current admission snapshot.
    const hiddenMiniMaxProjection =
      value !== null &&
      typeof value === 'object' &&
      (value as { minimaxCodeEnabled?: unknown }).minimaxCodeEnabled === false
    const preserveMiniMaxRows = !this.isMinimaxCodeEnabled() || hiddenMiniMaxProjection
    await this.ready
    this.runtimeMaintenance.assertAvailable()
    const previous = await this.catalogStore.get()
    this.runtimeMaintenance.assertAvailable()
    const supplied = normalizeCatalog(value)
    // Hidden integration rows are not editable in this projection. Restore their
    // persisted values so an unrelated catalog save cannot delete or replace them.
    const next = !preserveMiniMaxRows
      ? supplied
      : normalizeCatalog({
          ...supplied,
          combinations: [
            ...supplied.combinations.filter((item) => !isMiniMaxCodeRoute(item)),
            ...previous.combinations.filter(isMiniMaxCodeRoute),
          ],
        })
    for (const combination of next.combinations) {
      const old = previous.combinations.find((item) => item.id === combination.id)
      const samePairing =
        old &&
        modelRefKey(old.modelRef) === modelRefKey(combination.modelRef) &&
        old.harnessRef === combination.harnessRef
      const unchanged = samePairing && (!combination.enabled || old.enabled)
      if (
        !unchanged &&
        !adapterFor(combination.harnessRef, combination.modelRef, this.modelSources)
      )
        throw Error('该模型与 Harness 尚无兼容适配器，未保存组合')
      if (
        combination.harnessRef === 'pi' &&
        (!samePairing || old.permissionPolicy !== combination.permissionPolicy)
      ) {
        const adapter = adapterFor(combination.harnessRef, combination.modelRef, this.modelSources)
        if (adapter && !adapter.capabilities.permissions.includes(combination.permissionPolicy))
          throw Error('所选 Harness 不支持此权限档位，未保存组合')
      }
    }
    const launch = (catalog: ExecutionCatalog) =>
      catalog.harnesses.map((h) => [h.id, h.command, h.prefix])
    const changed = JSON.stringify(launch(previous)) !== JSON.stringify(launch(next))
    const publish = async () => {
      if (changed) await this.assertNoGlobalActivity()
      await this.catalogStore.set(next)
      this.events.emit('catalog')
      return this.executionCatalog()
    }
    return changed
      ? this.runtimeMaintenance.change(() => this.runtimeBusy(), publish)
      : this.runtimeMaintenance.admit(publish)
  }
  /** Model requests use the same maintenance exclusion as external CLI admission. */
  assertRuntimeAvailable(): void {
    this.runtimeMaintenance.assertAvailable()
  }
  /** Report actual work and in-flight runtime changes before an idle update. */
  updateBusy(): boolean {
    return (
      this.runtimeBusy() ||
      this.starting.size > 0 ||
      this.selectionChanges.size > 0 ||
      this.reasoningPreflights.size > 0 ||
      this.minimaxAccount.updateBusy()
    )
  }
  /** Drain owned writes after the caller has frozen every task admission path. */
  async drainForUpdate(): Promise<void> {
    await this.ready
    await this.selectionsReady
    if (this.updateBusy()) throw Error('仍有活动任务，不能更新')
    await this.writeQueue
    await this.externalEfforts.drain()
    await Promise.all(this.titleUpdates.values())
    await this.flushRecords()
    await this.messageEditStore.drain()
    await this.externalEditJournal.drain()
    if (this.updateBusy()) throw Error('更新排空期间出现活动任务')
  }
  /**
   * Exclude reviewer settings changes from CLI admission and native model requests.
   * @param operation - Validation and durable settings publication owned by Auto Review.
   * @returns The publication result after all visible projects were checked for activity.
   */
  async changeReviewerSettings<T>(operation: () => Promise<T>): Promise<T> {
    await this.ready
    return this.runtimeMaintenance.change(
      () => this.runtimeBusy(),
      async () => {
        await this.assertNoGlobalActivity()
        return await operation()
      },
    )
  }
  private runtimeBusy(): boolean {
    return (
      this.disposed ||
      this.engineUpdates.active ||
      this.maintenanceJobs.size > 0 ||
      this.connecting.size > 0 ||
      this.finalizing.size > 0 ||
      this.ctx.agents?.list().some((agent) => agent.status === 'running') === true ||
      [...this.records.values()].some((record) =>
        record.turns.some((turn) =>
          ['queued', 'running', 'waiting_child', 'needs_approval', 'needs_input'].includes(
            turn.state,
          ),
        ),
      ) ||
      [...this.active.values()].some((active) => !!active.turn)
    )
  }
  private async assertNoGlobalActivity(): Promise<void> {
    if (this.runtimeBusy()) throw Error('仍有活动任务，不能切换 Harness 运行时')
    for (const session of this.ctx.sessions.list()) {
      const activity = await this.ctx.waterfall(
        'workspace/session-activity',
        { sessionId: session.id },
        async () => [],
      )
      if (activity.length) throw Error('仍有活动任务，不能切换 Harness 运行时')
    }
    if (this.runtimeBusy()) throw Error('仍有活动任务，不能切换 Harness 运行时')
  }
  /** Publish the verified candidate into the actual catalog; receipts do not select it. */
  async selectMiniMaxCandidate(request: MiniMaxCandidateRequest): Promise<MiniMaxCandidateResult> {
    this.assertMinimaxCodeEnabled()
    await this.ready
    return this.runtimeMaintenance.change(
      () => this.runtimeBusy(),
      async () => {
        await this.assertNoGlobalActivity()
        const verified = prepareMiniMaxCandidate(request)
        await this.assertNoGlobalActivity()
        const previous = await this.catalogStore.setHarnessLaunch(
          MINIMAX_CODE_HARNESS,
          verified.command,
          [],
        )
        this.events.emit('catalog')
        return { ...verified, ...previous, version: request.version, validation: 'static' }
      },
    )
  }
  /** Select a pinned build or restore the previous official command while all projects are idle. */
  async selectCodexRuntime(request: CodexRuntimeRequest): Promise<CodexRuntimeResult> {
    await this.ready
    return this.runtimeMaintenance.change(
      () => this.runtimeBusy(),
      async () => {
        await this.assertNoGlobalActivity()
        if (request.mode !== 'official' && request.mode !== 'git-bash')
          throw Error('Codex 运行时选择无效')
        const verified =
          request.mode === 'git-bash' ? prepareCodexRuntime(this.directory, request) : null
        await this.assertNoGlobalActivity()
        const previous = await this.catalogStore.setCodexRuntime(verified)
        this.events.emit('catalog')
        return {
          ...(verified ?? {}),
          ...previous,
          mode: request.mode,
          validation: verified ? 'static' : 'launch-settings',
        }
      },
    )
  }
  async saveHarnessProxy(harnessId: string, proxy: unknown): Promise<ExecutionCatalog> {
    await this.ready
    return this.runtimeMaintenance.admit(async () => {
      await this.catalogStore.setProxy(harnessId, proxy)
      this.events.emit('catalog')
      return this.executionCatalog()
    })
  }
  async removeCombination(id: string): Promise<ExecutionCatalog> {
    await this.ready
    return this.runtimeMaintenance.admit(async () => {
      const catalog = await this.executionCatalog()
      await this.catalogStore.removeCombination(required(id, '组合 ID'), (item) => {
        this.assertMiniMaxCodeRouteEnabled(item)
        if (!isRemovableCombination(item, catalog.recommendations))
          throw Error('只能移除非推荐的自定义组合')
      })
      this.events.emit('catalog')
      return this.executionCatalog()
    })
  }
  private view(record: HarnessSession, turns = record.turns): HarnessSnapshot {
    const active = this.active.get(record.id)
    return structuredClone({
      ...record,
      turns,
      connected:
        record.harnessRef === 'dsh'
          ? !!this.ctx.agents?.get(asSessionId<SessionId>(record.acpSessionId))
          : !!active?.acp && !active.acp.closed,
      state: record.turns.at(-1)?.state ?? 'idle',
      // `external` is host-internal binding data; the public approval DTO is a
      // generated wire contract, so it is stripped here rather than published.
      approvals: [...(active?.approvals.values() ?? [])].map(
        ({ rpcId: _, external: __, reviewCallId: ___, ...a }) => a,
      ),
    })
  }
  async snapshot(input: { sessionId: string }): Promise<HarnessSnapshot> {
    await this.ready
    const record = this.records.get(required(input?.sessionId, 'sessionId'))
    if (!record) throw Error('执行组合会话不存在')
    return this.view(record)
  }
  /** Read only the latest completed external context observation for one DSH Session. */
  async contextUsage(input: { sessionId: string }): Promise<HarnessContextReading | null> {
    await this.ready
    const sessionId = required(input?.sessionId, 'sessionId')
    const session = this.ctx.sessions.get(asSessionId<SessionId>(sessionId))
    if (!session) return null
    const selection = this.ctx.sessionProjections.snapshot(session, ['modelSelection']).values
      .modelSelection
    const route = selection?.next ?? selection?.lastUsed
    if (!route) return null
    const reading = latestHarnessContext(
      [...this.records.values()],
      sessionId,
      this.selections[sessionId],
    )
    return reading && reading.provider === route.provider && reading.model === route.model
      ? reading
      : null
  }
  async start(input: HarnessStartRequest, deferConnection = false): Promise<HarnessSnapshot> {
    return this.runtimeMaintenance.admit(() => this.startAdmitted(input, deferConnection))
  }
  private async startAdmitted(
    input: HarnessStartRequest,
    deferConnection = false,
    followConversationPermission = false,
  ): Promise<HarnessSnapshot> {
    await this.ready
    if (this.disposed) throw Error('组合服务已关闭')
    const catalog = await this.executionCatalog()
    const frozen = input.existingSessionId ? this.records.get(input.existingSessionId) : undefined
    const definition = frozen
      ? { ...frozen, enabled: true, permissionPolicy: frozen.sandbox, name: frozen.title }
      : catalog.combinations.find((x) => x.id === input?.combination && x.enabled)
    if (!definition) throw Error('未知或已停用的模型 + Harness 组合')
    this.assertMiniMaxCodeRouteEnabled(definition)
    const harness = catalog.harnesses.find((item) => item.id === definition.harnessRef)
    if (!harness || !adapterFor(harness.id, definition.modelRef, this.modelSources))
      throw Error('该组合已保存，但尚未安装对应 Harness 适配器')
    const supplied = required(input.cwd, 'cwd')
    if (!isAbsolute(supplied) || supplied.includes('\0')) throw Error('工作目录必须为绝对路径')
    const cwd = await realpath(supplied)
    if (!(await stat(cwd)).isDirectory()) throw Error('工作目录不存在')
    const origin = input.origin ?? { kind: 'desktop', sessionId: 'manual' }
    if (!['codex', 'dsh', 'harness', 'desktop'].includes(origin.kind)) throw Error('无效的来源')
    required(origin.sessionId, 'origin.sessionId')
    const parent = this.parentOf(origin)
    if (origin.kind === 'harness' && !parent) throw Error('来源组合会话不存在')
    if (
      parent &&
      (parent.cwd !== cwd ||
        (input.sandbox !== undefined &&
          input.sandbox !== 'read-only' &&
          parent.sandbox === 'read-only') ||
        (input.sandbox === 'full-access' && parent.sandbox !== 'full-access'))
    )
      throw Error('子对话必须继承原项目和权限边界')
    let ancestor = parent,
      depth = 0
    while (ancestor) {
      if (++depth >= 4) throw Error('协作嵌套已达上限')
      ancestor = this.parentOf(ancestor.origin)
    }
    const id =
      input.existingSessionId ??
      `harness-${hash([origin, input.taskId ?? randomUUID(), cwd, input.combination]).slice(0, 24)}`
    const prior = this.records.get(id)
    if (input.existingSessionId && !prior) throw Error('指定会话不存在，不会自动创建替代会话')
    // Creating a combination session is a dispatch: it needs an addressable
    // reviewer. Resuming an existing record stays allowed, so a historical
    // session remains readable and continueable for its own origin.
    if (prior === undefined && !parent) this.requireExternalReviewer(origin)
    if (prior && (prior.combination !== input.combination || prior.cwd !== cwd))
      throw Error('会话组合或项目与原记录不一致')
    if (
      input.sandbox !== undefined &&
      !['workspace', 'read-only', 'full-access'].includes(input.sandbox)
    )
      throw Error('无效的权限边界')
    if (prior && input.sandbox && prior.sandbox !== input.sandbox)
      throw Error('不能通过继续会话扩大权限')
    if (this.starting.has(id)) return this.starting.get(id)!
    // A combination that declares full access is still only a declared policy: without an explicit
    // request this call starts at the conservative workspace boundary, so no harness is widened
    // merely because a combination happens to declare full access.
    const requestedSandbox =
      input.sandbox ??
      parent?.sandbox ??
      (definition.permissionPolicy === 'full-access' ? 'workspace' : definition.permissionPolicy)
    // `generated` marks the conservative default the catalog generator picked for an automatic
    // combination, not a restriction any person declared, so it must not overwrite a permission the
    // caller already authorized. Only a declared policy narrows a task, and a caller's own request
    // still has to pass the verified-full-access gate below. A frozen definition has no `generated`
    // flag, so a stored restricted session stays restricted and cannot be widened on resume.
    const declaredReadOnly =
      !followConversationPermission &&
      definition.permissionPolicy === 'read-only' &&
      !('generated' in definition && definition.generated)
    const sandbox =
      declaredReadOnly || requestedSandbox === 'read-only' ? 'read-only' : requestedSandbox
    // An explicitly requested full-access task is never quietly downgraded. A harness without a
    // verified official full-access path is refused before any session or model request exists,
    // so the caller learns the task cannot run instead of running with weaker permissions.
    if (requestedSandbox === 'full-access' && !harnessAllowsFullAccess(definition.harnessRef))
      throw new HarnessConfigurationError(
        `Harness ${definition.harnessRef} 没有经过验证的官方 full-access 路径，已拒绝启动该受限任务；不会自动降级为工作区权限。`,
      )
    const autoReview = origin.kind === 'dsh' && this.zcodeModeForOrigin(origin) === 'build'
    if (autoReview && !['codex', 'claude', 'zcode'].includes(definition.harnessRef))
      throw new HarnessConfigurationError(
        '此 Harness 尚无已验证的官方 Auto Review 接口，请选择其他权限模式。',
      )
    const record: HarnessSession = prior ?? {
      id,
      combination: input.combination,
      harnessRef: definition.harnessRef,
      modelRef: definition.modelRef,
      cwd,
      origin,
      sandbox,
      ...(['codex', 'claude'].includes(definition.harnessRef) && origin.kind === 'dsh'
        ? { externalAutoReview: autoReview }
        : {}),
      ...(definition.harnessRef === 'zcode' ? { zcodeMode: this.zcodeModeForOrigin(origin) } : {}),
      acpSessionId: '',
      title: definition.name,
      createdAt: now(),
      updatedAt: now(),
      turns: [],
    }
    if (record.harnessRef === MINIMAX_CODE_HARNESS && record.sandbox !== 'full-access')
      throw new HarnessConfigurationError(
        'MiniMax 官方 CLI 暂不支持可验证的只读或工作区隔离。请显式授权 full-access；当前受限任务未启动。',
      )
    // Persist the identity before creating a native session. A failed setup can
    // then resume the same mapping rather than orphaning an invisible session.
    this.records.set(id, record)
    const pending = this.save(record)
      .then(() => this.ensureConversation(record))
      .then(() => (deferConnection ? undefined : this.connect(record)))
      .then(() => this.view(record))
      .finally(() => this.starting.delete(id))
    this.starting.set(id, pending)
    return pending
  }
  private parentOf(origin: HarnessOrigin): HarnessSession | undefined {
    return origin.kind === 'harness'
      ? this.records.get(origin.sessionId)
      : origin.kind === 'dsh'
        ? [...this.records.values()].find(
            (r) => r.harnessRef === 'dsh' && r.acpSessionId === origin.sessionId,
          )
        : undefined
  }
  private connect(record: HarnessSession): Promise<void> {
    return this.runtimeMaintenance.admit(() => this.connectAdmitted(record))
  }
  private connectAdmitted(record: HarnessSession): Promise<void> {
    return this.enterEngine(record.harnessRef, () => {
      if (this.disposed) return Promise.reject(Error('组合服务已关闭'))
      const pending = this.connecting.get(record.id)
      if (pending) return pending
      const connection = this.openConnection(record).finally(() =>
        this.connecting.delete(record.id),
      )
      this.connecting.set(record.id, connection)
      return connection
    })
  }
  private async openConnection(record: HarnessSession, provisional = false) {
    this.assertMiniMaxCodeRouteEnabled(record)
    const chosenHarness = (await this.catalogStore.get()).harnesses.find(
      (h) => h.id === record.harnessRef,
    )
    const launchSettings = hash([
      chosenHarness?.command,
      chosenHarness?.prefix,
      chosenHarness?.codexRuntime,
      ...(record.harnessRef === 'minimax-code'
        ? [
            await minimaxExecutionRegion(
              this.directory,
              chosenHarness?.prefix ?? this.options.prefix,
            ),
          ]
        : []),
      chosenHarness?.proxy?.mode === 'inherit' ? undefined : chosenHarness?.proxy,
    ])
    const existing = this.active.get(record.id)
    if (provisional && existing?.turn) throw Error('此会话仍在执行')
    if (existing && (record.harnessRef === 'dsh' || (existing.acp && !existing.acp.closed))) {
      if (
        !provisional &&
        (record.harnessRef === 'dsh' || existing.launchSettings === launchSettings || existing.turn)
      )
        return
      // Finish the running turn on its original connection. Idle connections load
      // their native session on a new process before another prompt is admitted.
      await existing.acp?.dispose()
      await existing.bridgeStop?.()
      this.active.delete(record.id)
    }
    const adapter = adapterFor(record.harnessRef, record.modelRef, this.modelSources)
    if (!adapter) throw Error('此组合没有兼容的 Harness 适配器')
    if (adapter.transport === 'dsh') {
      await connectDsh(this.ctx, record, () => this.save(record))
      this.active.set(record.id, {
        cancelled: false,
        turn: undefined,
        done: undefined,
        generation: ++this.connectionGeneration,
        approvals: new Map(),
      })
      this.changed(record)
      return
    }
    const launch = await adapter.prepare!(
      this.ctx,
      record,
      this.adapterOptions(
        chosenHarness?.command,
        chosenHarness?.prefix,
        chosenHarness?.codexRuntime,
      ),
    )
    const home = launch.home
    const active: Active = {
      cancelled: false,
      turn: undefined,
      done: undefined,
      generation: ++this.connectionGeneration,
      approvals: new Map(),
      launchSettings,
      editLaunch: { ...launch, env: harnessProxyEnvironment(launch.env, chosenHarness?.proxy) },
      provisional,
      ...(record.harnessRef === 'vibe' ? { vibeUsage: new VibeTurnUsageTracker() } : {}),
    }
    const bindingPath = join(home, record.id + '.control.json')
    const bridgeStop = await startControlBridge(
      {
        invoke: async (request) => {
          const p = object(request.args)
          if (request.namespace !== 'harness')
            throw Error('Capability does not allow this namespace')
          const caller: HarnessOrigin = { kind: 'harness', sessionId: record.id }
          if (request.method === 'official-tools' || request.method === 'official-call') {
            const official = this.ctx.get('oplOfficialCollaboration')
            if (!official || !record.nativeSessionId) {
              if (request.method === 'official-tools') return { enabled: false, tools: [] }
              throw Error('官方协作接入未启用或会话未关联')
            }
            const signal = request.signal ?? new AbortController().signal
            return request.method === 'official-tools'
              ? { enabled: true, tools: await official.tools(record.nativeSessionId, signal) }
              : official.call(record.nativeSessionId, required(p.name, 'tool'), p.arguments, signal)
          }
          if (
            ['list', 'delegate', 'tasks', 'report', 'review', 'result', 'cancel'].includes(
              request.method,
            ) &&
            !this.ctx.get('oplOfficialCollaboration')
          )
            throw Error('OPL 跨引擎协作已停用')
          if (request.method === 'list') return await this.combinations()
          if (request.method === 'delegate') return this.delegateFrom(caller, p, request.signal)
          if (request.method === 'tasks') return this.tasksFor(caller)
          if (request.method === 'report') return this.submitReport(caller, p)
          if (request.method === 'review') return this.reviewTask(caller, p)
          if (request.method === 'result') return this.resultFor(caller, p, request.signal)
          if (request.method === 'cancel') return this.cancelTask(caller, p.sessionId)
          if (request.method === 'start') {
            // A Grok child can request a same-project combination, with its
            // own parent identity and inherited filesystem boundary.
            if (p.existingSessionId) {
              const prior = this.records.get(p.existingSessionId)
              if (prior?.origin.kind !== 'harness' || prior.origin.sessionId !== record.id)
                throw Error('会话不属于当前组合')
            }
            return this.start({
              combination: typeof p.combination === 'string' ? p.combination : DSH_COMBINATION,
              cwd: record.cwd,
              taskId: required(p.taskId, 'taskId'),
              origin: { kind: 'harness', sessionId: record.id },
              sandbox: record.sandbox,
              ...(p.existingSessionId ? { existingSessionId: p.existingSessionId } : {}),
            })
          }
          const child = this.records.get(p.sessionId)
          if (
            child?.origin.kind !== 'harness' ||
            child.origin.sessionId !== record.id ||
            child.cwd !== record.cwd
          )
            throw Error('会话不属于当前组合')
          if (!['prompt', 'snapshot', 'wait', 'cancel'].includes(request.method))
            throw Error('Capability does not allow this operation')
          return this.invoke(request.method, p, request.signal)
        },
        stream: () => {
          throw Error('Stream not supported')
        },
      },
      hostPeer(this.ctx),
      bindingPath,
    )
    let stopping: Promise<void> | undefined
    active.bridgeStop = () => {
      if (!stopping) {
        stopping = bridgeStop()
        // Exit notifications do not await cleanup; explicit callers retain its rejection.
        void stopping.catch(() => undefined)
      }
      return stopping
    }
    const mcpPath = fileURLToPath(new URL('./harness-mcp.mjs', import.meta.url))
    const servers = await access(mcpPath).then(
      () => [
        {
          name: 'opl-harness',
          command: process.execPath,
          args: [mcpPath],
          env: [
            { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
            { name: 'OPL_HARNESS_BINDING_FILE', value: bindingPath },
          ],
        },
      ],
      () => [],
    )
    const wireModel =
      adapter.acpModelId?.(record.modelRef) ?? record.modelRef.model.split('::').at(-1)!
    const pendingUsage: unknown[] = []
    let sessionReady = false
    const acp = new AcpProcess(
      launch.command,
      launch.args,
      record.cwd,
      harnessProxyEnvironment(launch.env, chosenHarness?.proxy),
      (value) => {
        if (!sessionReady && !record.acpSessionId) {
          if (object(object(value).update).sessionUpdate === 'usage_update') {
            if (pendingUsage.length === 16) pendingUsage.shift()
            pendingUsage.push(value)
          }
          return
        }
        if (!active.provisional) this.update(this.records.get(record.id) ?? record, active, value)
        else if (object(value).sessionId === record.acpSessionId)
          active.vibeUsage?.observeUpdate(object(value).update)
      },
      (id, value) => this.ask(this.records.get(record.id) ?? record, active, id, value),
      () => {
        if (!active.provisional) this.changed(this.records.get(record.id) ?? record)
        void active.bridgeStop?.()
      },
      launch.windowsVerbatimArguments,
      // Only recognized runtime extensions can update the owned operation.
      (method, params) => {
        if (active.provisional) return
        const current = this.records.get(record.id) ?? record
        if (method === 'opl/session/usage')
          void this.recordMiniMaxUsage(current, active, params).catch(() => {})
        else if (method === HISTORY_BOUNDARY)
          void this.recordNativeBoundary(current, params).catch(() => {})
      },
      launch.clientRequests,
    )
    active.acp = acp
    active.mcpServers = servers
    active.createdSession = !record.acpSessionId
    try {
      const init = object(
        await acp.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            ...(record.harnessRef === MINIMAX_CODE_HARNESS
              ? { _meta: { 'minimax-code/extensions': { version: 1, notifications: true } } }
              : {}),
          },
          clientInfo: { name: 'opl-dsh', version: '0.2.13' },
        }),
      )
      if (init.protocolVersion !== 1) throw Error('Harness 未协商 ACP v1')
      if (record.acpSessionId && !object(init.agentCapabilities).loadSession)
        throw Error('此 Harness 不支持恢复原生会话')
      active.agentInfo = init
      await adapter.authenticate?.(acp, record, init)
      const session = object(
        await acp.request(record.acpSessionId ? 'session/load' : 'session/new', {
          ...(record.acpSessionId ? { sessionId: record.acpSessionId } : {}),
          cwd: launch.acpCwd ?? record.cwd,
          mcpServers: servers,
        }),
      )
      if (!record.acpSessionId) {
        record.acpSessionId = required(session.sessionId, 'ACP sessionId')
        if (!provisional) await this.save(record)
      }
      sessionReady = true
      const initialContext = canonicalHarnessContext(object(session._meta)['opl/contextUsage'])
      if (initialContext) {
        active.contextUsage = initialContext
        const previous = record.turns.at(-1)
        if (previous && !provisional) {
          previous.contextUsage = initialContext
          this.changed(record)
        }
      }
      for (const value of pendingUsage) {
        if (!provisional) this.update(record, active, value)
        else if (object(value).sessionId === record.acpSessionId)
          active.vibeUsage?.observeUpdate(object(value).update)
      }
      pendingUsage.length = 0
      // An adapter that owns a fixed model and reasoning configuration pins it here,
      // after the session exists and before any prompt can be sent. A refusal to honor
      // the pinned values must abort the connection rather than run on other settings.
      active.configOptions = object(session).configOptions
      active.sessionInfo = session
      let model = object(session.models).currentModelId
      if (adapter.configureSession) {
        const configured = await adapter.configureSession(
          acp,
          record,
          {
            agent: init,
            session,
            configOptions: active.configOptions,
          },
          launch,
        )
        if (configured && 'configOptions' in configured)
          active.configOptions = configured.configOptions
        if (configured?.modelId !== undefined) model = configured.modelId
      }
      if (model !== undefined && model !== wireModel)
        throw Error('Harness 返回了不同的模型，已停止')
      this.active.set(record.id, active)
      if (!provisional) this.changed(record)
    } catch (e) {
      await acp.dispose()
      await active.bridgeStop?.()
      throw e
    }
  }
  private update(record: HarnessSession, active: Active, value: unknown) {
    const envelope = object(value)
    if (envelope.sessionId !== record.acpSessionId) return
    const u = object(envelope.update)
    if (u.sessionUpdate === 'usage_update') {
      const account =
        record.harnessRef === 'vibe'
          ? active.vibeUsage!.observeUpdate(u)
          : record.harnessRef === 'pool'
            ? parsePoolContextUsage(u)
            : record.harnessRef === 'minimax-code'
              ? parseMiniMaxContextUsage(u)
              : {}
      const contextUsage = canonicalHarnessContext(
        account.contextUsage ??
          (record.harnessRef === 'vibe'
            ? undefined
            : (object(u._meta)['opl/contextUsage'] ?? {
                ...u,
                ...(typeof object(u._meta)['opl/contextEstimated'] === 'boolean'
                  ? { estimated: object(u._meta)['opl/contextEstimated'] }
                  : {}),
              })),
      )
      if (contextUsage) {
        active.contextUsage = contextUsage
        const usageTurn = active.turn ?? record.turns.at(-1)
        if (usageTurn) usageTurn.contextUsage = contextUsage
        if (contextUsage.size !== undefined)
          this.recordContextWindow(record, active, contextUsage.size)
        if (usageTurn) this.changed(record)
      }
      return
    }
    if (active.editReplay) {
      if (u.sessionUpdate === 'user_message_chunk' && object(u.content).type === 'text')
        active.editReplay.text += String(object(u.content).text ?? '')
      const id = object(u._meta)['poolside/inputEventId']
      if (typeof id === 'string' && id) {
        active.editReplay.boundaries.push({ id, text: active.editReplay.text })
        active.editReplay.text = ''
      }
      return
    }
    if (record.harnessRef === 'step-code' && u.sessionUpdate === 'session_info_update')
      this.recordStepInput(record, active, object(u._meta))
    if (record.harnessRef === 'pool' && active.turn && u.sessionUpdate === 'session_info_update') {
      const id = object(u._meta)['poolside/inputEventId']
      if (typeof id === 'string' && id)
        active.turn.native = { ...active.turn.native, userMessageId: id }
    }

    // Configuration advertisements arrive outside any turn, so this must run before the
    // turn guard: an adapter's pre-prompt check reads the latest advertised state, and a
    // notification dropped while idle would let a pinned combination drift unnoticed.
    if (u.sessionUpdate === 'config_option_update' && Array.isArray(u.configOptions)) {
      active.configOptions = u.configOptions
      return
    }
    if (
      u.sessionUpdate === 'session_info_update' &&
      typeof u.title === 'string' &&
      u.title.trim()
    ) {
      const title = u.title.trim().slice(0, 400)
      if (record.turns.some((turn) => echoesConversationContext(title, turn.prompt))) return
      record.title = title
      record.titleFromHarness = true
      this.changed(record)
      const target =
        record.nativeSessionId ??
        (record.origin.kind === 'dsh' ? record.origin.sessionId : undefined)
      const pending = (this.titleUpdates.get(record.id) ?? Promise.resolve())
        .then(async () => {
          if (target && !this.isOfficialMember(target))
            await this.native('rename', { sessionId: target, title })
          await this.save(record)
        })
        .catch(() => {
          this.ctx.logger?.warn('外部 Harness 标题未同步，原会话记录已保留')
        })
      this.titleUpdates.set(record.id, pending)
      return
    }
    if (!active.turn || active.deadlineError || active.inputReceiptError) return
    const turn = active.turn
    active.qwenUsage?.observe(u)
    if (
      (['agent_message_chunk', 'agent_thought_chunk'].includes(u.sessionUpdate) &&
        typeof u.content?.text === 'string' &&
        u.content.text.trim()) ||
      (['tool_call', 'tool_call_update'].includes(u.sessionUpdate) &&
        typeof u.toolCallId === 'string' &&
        (u.status || u.rawOutput || u.content))
    )
      active.watchdog?.progress()
    if (
      ['agent_message_chunk', 'agent_thought_chunk'].includes(u.sessionUpdate) &&
      object(u.content).type === 'text' &&
      typeof u.content.text === 'string'
    ) {
      const type = u.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'text'
      turn.content ??= turn.text ? [{ type: 'text', text: turn.text }] : []
      const last = turn.content.at(-1)
      if (last?.type === type) last.text += u.content.text
      else turn.content.push({ type, text: u.content.text })
      if (type === 'text') turn.text += u.content.text
    }
    if (
      ['tool_call', 'tool_call_update'].includes(u.sessionUpdate) &&
      typeof u.toolCallId === 'string'
    ) {
      let tool = turn.tools.find((t) => t.id === u.toolCallId)
      if (!tool) {
        tool = { id: u.toolCallId, title: '工具调用', status: 'pending', kind: 'other' }
        turn.tools.push(tool)
      }
      for (const field of ['title', 'status', 'kind'] as const)
        if (typeof u[field] === 'string') tool[field] = u[field].slice(0, 4000)
      for (const [wire, field] of [
        ['rawInput', 'inputJson'],
        ['rawOutput', 'outputJson'],
        ['content', 'contentJson'],
        ['locations', 'locationsJson'],
        ['_meta', 'metadataJson'],
      ] as const)
        if (u[wire] !== undefined) tool[field] = JSON.stringify(u[wire])
      if (turn.tools.some((tool) => ['pending', 'in_progress', 'running'].includes(tool.status)))
        active.watchdog?.pauseIdle()
      else active.watchdog?.resumeIdle()
      const owner = this.conversationOwners.get(record.id)
      if (owner) this.conversations?.tool(owner.sessionId, record, turn, u)
    }
    this.changed(record)
  }

  /** Bind Step's exact request receipt only to the current connection's open turn. */
  private recordStepInput(record: HarnessSession, active: Active, meta: Record<string, unknown>) {
    const turn = active.turn
    const inputId = meta['opl/stepInputId']
    const operationId = meta['opl/clientRequestId']
    if (
      this.active.get(record.id) !== active ||
      active.sessionInfo?.sessionId !== record.acpSessionId ||
      !turn ||
      turn !== record.turns.at(-1) ||
      !['running', 'waiting_approval', 'waiting_input'].includes(turn.state) ||
      active.cancelled ||
      active.deadlineError ||
      active.inputReceiptError ||
      typeof inputId !== 'string' ||
      !inputId ||
      typeof operationId !== 'string' ||
      operationId !== turn.operationId
    )
      return
    if (turn.native?.userMessageId === inputId) return
    if (turn.native?.userMessageId) {
      active.inputReceiptError =
        'Step 返回了相互冲突的用户消息身份，已停止本轮请求；编辑状态待核对，原任务未自动重发。'
      turn.error = active.inputReceiptError
    } else turn.native = { ...turn.native, userMessageId: inputId }
    this.changed(record)
    const stopped = active.inputReceiptError
      ? active.acp?.terminate(active.inputReceiptError)
      : undefined
    const saved = active.inputReceiptError
      ? this.persistStepInputConflict(record, turn)
      : this.save(record)
    active.inputReceiptWrite = Promise.all([active.inputReceiptWrite, saved, stopped]).then(
      () => {},
    )
    void active.inputReceiptWrite.catch(() => {
      this.ctx.logger?.warn('Step 用户消息身份尚未保存，原记录和编辑保护已保留')
    })
  }

  private async persistStepInputConflict(record: HarnessSession, turn: HarnessTurn): Promise<void> {
    const intent = record.nativeSessionId
      ? this.externalMessageEdits.intent(record.nativeSessionId)
      : undefined
    if (intent && turn.operationId === 'message-edit:' + intent.requestId)
      await this.externalEditJournal.save({ ...intent, phase: 'uncertain' })
    await this.save(record)
  }
  private ask(record: HarnessSession, active: Active, rpcId: string | number, value: unknown) {
    const p = object(value)
    if (
      p.sessionId !== record.acpSessionId ||
      !active.turn ||
      active.cancelled ||
      active.deadlineError
    ) {
      active.acp?.answer(rpcId)
      return
    }
    const options = (Array.isArray(p.options) ? p.options : [])
      .map(object)
      .filter(
        (x) =>
          typeof x.optionId === 'string' &&
          typeof x.name === 'string' &&
          ['allow_once', 'reject_once'].includes(x.kind),
      )
      .map((x) => ({
        optionId: x.optionId as string,
        name: x.name as string,
        kind: x.kind as string,
      }))
    const id = randomUUID()
    const command = object(object(p.toolCall).rawInput).command
    // The structured action of an ask that carries one. An ask without an
    // explicit tool name and `rawInput` stays unbindable, so its display text is
    // never decoded into an authorization decision.
    const external = externalAskFromToolCall(p.toolCall)
    const nativeCallId =
      typeof object(p.toolCall).toolCallId === 'string' && this.conversations
        ? this.conversations.toolId(record, active.turn, object(p.toolCall).toolCallId)
        : ToolCallId('external:' + id)
    active.approvals.set(id, {
      ...(nativeCallId === undefined ? {} : { reviewCallId: nativeCallId }),
      id,
      rpcId,
      title: String(object(p.toolCall).title ?? 'Harness 工具权限请求').slice(0, 4000),
      ...(typeof command === 'string' ? { command } : {}),
      options,
      ...(external === undefined ? {} : { external }),
    })
    active.watchdog?.pause()
    active.turn.state = 'waiting_approval'
    this.changed(record)
    void this.save(record).catch(() => this.cancel({ sessionId: record.id }))
    // Announced while the turn is still open: an approval wait would otherwise
    // stay invisible until a human decision let the turn end.
    void this.announceApproval(record, active.turn).catch(() => {})
    const owner = this.conversationOwners.get(record.id)
    const agent = owner && this.ctx.agents.get(asSessionId<SessionId>(owner.sessionId))
    if (agent) {
      void (async () => {
        const outcome = await this.ctx.get('approval')?.request({
          agent,
          toolName: record.harnessRef,
          reason:
            active.approvals.get(id)!.title + (typeof command === 'string' ? '\n\n' + command : ''),
          ...(nativeCallId === undefined ? {} : { callId: nativeCallId }),
          ...(owner.signal ? { signal: owner.signal } : {}),
        })
        if (!active.approvals.has(id)) return
        const option = options.find(
          (item) => item.kind === (outcome === 'allowed-once' ? 'allow_once' : 'reject_once'),
        )
        await this.answer({
          sessionId: record.id,
          approvalId: id,
          ...(option?.optionId ? { optionId: option.optionId } : {}),
        })
      })().catch(() => {
        if (active.approvals.has(id)) void this.answer({ sessionId: record.id, approvalId: id })
      })
    }
  }
  async answer(input: { sessionId: string; approvalId: string; optionId?: string }) {
    await this.ready
    const record = this.records.get(required(input.sessionId, 'sessionId')),
      active = this.active.get(input.sessionId)
    const ask = active?.approvals.get(required(input.approvalId, 'approvalId'))
    if (!record || !active || !ask) throw Error('授权请求已结束或不存在')
    if (input.optionId !== undefined && !ask.options.some((o) => o.optionId === input.optionId))
      throw Error('无效的授权选项')
    active.acp?.answer(ask.rpcId, input.optionId)
    active.approvals.delete(ask.id)
    if (active.approvals.size === 0) active.watchdog?.resume()
    if (active.turn) active.turn.state = active.approvals.size ? 'waiting_approval' : 'running'
    this.changed(record)
    await this.save(record)
    // The decision is the human's; this service only reports that the turn moved
    // on, and never answers a request itself.
    if (active.turn) {
      void this.reportNotification(
        record,
        active.turn,
        'running',
        this.turnSummary(active.turn),
      ).catch(() => {})
    }
    return this.view(record)
  }
  /**
   * Bind the one pending external-Harness permission ask of a native Session.
   *
   * The approval waterfall only carries the ask's tool reference and display
   * text, so the exact facts are read here, from the live connection record:
   * the ACP session and its connection generation, the owning Harness turn, the
   * structured action the ask declared, and the authorization the task runs
   * under. Nothing is derived from the ask's prose.
   *
   * This is deliberately all-or-nothing. Zero pending external asks means there
   * is nothing to bind; more than one means the pending approval request cannot
   * be attributed to an exact ask; a missing turn, an unknown record, an
   * unreadable preset or an ask without a structured action all return `null`.
   * Every `null` leaves the ask to the ordinary human approval chain.
   * @param sessionId - the native Session that owns the Harness conversation.
   * @param callId - the exact native approval request identity.
   * @returns the exact binding, or null when it cannot be proven.
   */
  externalApprovalBinding(
    sessionId: string,
    callId?: string,
  ): HarnessExternalApprovalBinding | null {
    const session = this.ctx.sessions?.get(asSessionId<SessionId>(sessionId))
    if (!session || !callId) return null
    const matches: {
      record: HarnessSession
      active: Active
      external: HarnessExternalAsk
    }[] = []
    for (const [recordId, active] of this.active) {
      if (this.conversationOwners.get(recordId)?.sessionId !== sessionId) continue
      const record = this.records.get(recordId)
      if (!record) continue
      for (const ask of active.approvals.values())
        if (ask.external !== undefined && ask.reviewCallId === callId)
          matches.push({ record, active, external: ask.external })
    }
    if (matches.length !== 1) return null
    const { record, active, external } = matches[0]!
    const turn = active.turn
    if (!turn) return null
    const index = record.turns.findIndex((item) => item.operationId === turn.operationId)
    if (index < 0) return null
    let preset: string
    try {
      preset = this.ctx.permissionPresets.current(session)
    } catch {
      return null
    }
    return {
      harness: record.harnessRef,
      callId,
      acpSessionId: record.acpSessionId,
      generation: active.generation,
      turn: index + 1,
      turnId: turn.operationId,
      action: { name: external.name, parameters: external.parameters },
      authorization: {
        sessionId,
        preset,
        sandbox: record.sandbox,
        combination: record.combination,
      },
    }
  }

  async prompt(input: HarnessPromptRequest, reasoningEffort?: string): Promise<HarnessSnapshot> {
    return this.runtimeMaintenance.admit(() => {
      requireHarnessInputText(input?.text, 'request')
      return this.promptAdmitted(input, reasoningEffort)
    })
  }
  private async promptAdmitted(
    input: HarnessPromptRequest,
    reasoningEffort?: string,
    displayPrompt?: string,
    promptContent?: HarnessPromptPart[],
  ): Promise<HarnessSnapshot> {
    await this.ready
    if (this.disposed) throw Error('组合服务已关闭')
    const record = this.records.get(required(input?.sessionId, 'sessionId'))
    if (!record) throw Error('组合会话不存在')
    this.assertMiniMaxCodeRouteEnabled(record)
    return this.enterEngine(record.harnessRef, () =>
      this.promptWithEngine(record, input, reasoningEffort, displayPrompt, promptContent),
    )
  }
  private async promptWithEngine(
    record: HarnessSession,
    input: HarnessPromptRequest,
    reasoningEffort?: string,
    displayPrompt?: string,
    promptContent?: HarnessPromptPart[],
  ): Promise<HarnessSnapshot> {
    const edit = record.nativeSessionId
      ? this.externalMessageEdits.intent(record.nativeSessionId)
      : undefined
    const replacement =
      edit?.phase === 'admitting' && input.operationId === 'message-edit:' + edit.requestId
    if ((this.externalEditing.has(record.id) || (edit && edit.phase !== 'settled')) && !replacement)
      throw Error('外部会话正在编辑或结果尚未确认')
    // 编辑与普通提示共用同一把互斥。先查一次，保证被卡住的会话不会被拉起子进程再失败。
    this.assertStopEditIdle(record)
    const text = requireHarnessInputText(input.text, 'request'),
      operation = required(input.operationId, 'operationId')
    const writeScope = await resolveWriteScope(record.cwd, input.writeScope)
    const content: unknown[] = reasoningEffort
      ? [record.id, text, reasoningEffort]
      : [record.id, text]
    if (promptContent) content.push({ promptContent })
    // Keep the existing fingerprint for old operations that did not declare ownership.
    const fingerprint = hash(writeScope ? [...content, { writeScope }] : content)
    const previous = record.turns.find((t) => t.operationId === operation)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw Error('同一个 operation ID 的内容发生变化')
      return this.view(record)
    }
    if (record.modelRef.provider === 'opl-gateway') {
      const group = GATEWAY_GROUPS.find(
        (g) =>
          g.id ===
          (record.modelRef.model.includes('::')
            ? record.modelRef.model.split('::')[0]
            : 'deepseek'),
      )
      if (group && !gatewayGroupEnabled(this.ctx, group.id))
        throw Error('此分组已停用，请在账号页激活')
    }
    await this.ensureConversation(record)
    await this.finalizing.get(record.id)
    await this.connect(record)
    const active = this.active.get(record.id)!
    // Recheck after async connection so overlapping callers cannot race.
    const repeated = record.turns.find((t) => t.operationId === operation)
    if (repeated) {
      if (repeated.fingerprint !== fingerprint) throw Error('同一个 operation ID 的内容发生变化')
      return this.view(record)
    }
    if (active.turn) throw Error('此会话仍在执行，请先等待或取消')
    // 编辑与普通提示共用同一把互斥：回退期间或结果不确定的会话都不能再写入。
    this.assertStopEditIdle(record)
    if (record.harnessRef === MINIMAX_CODE_HARNESS && reasoningEffort !== undefined) {
      if (!minimaxReasoning(record.modelRef, reasoningEffort))
        throw new HarnessConfigurationError('MiniMax 不支持所选推理设置，未发送任务。')
      record.reasoningEffort = reasoningEffort
    }
    // Registered before the prompt is written to the agent: a turn that
    // completes or pauses immediately afterwards must find its durable
    // notification record already in place, so no fast outcome can be missed.
    await this.registerNotification(record, operation)
    // Registration awaited durable storage, so recheck exactly as after the
    // connection: overlapping callers must not admit two turns into one session,
    // and a replay of one operation must be answered with the turn it already
    // created instead of executing it a second time.
    const registered = record.turns.find((t) => t.operationId === operation)
    if (registered) {
      if (registered.fingerprint !== fingerprint) throw Error('同一个 operation ID 的内容发生变化')
      return this.view(record)
    }
    if (active.turn) throw Error('此会话仍在执行，请先等待或取消')
    // 编辑与普通提示共用同一把互斥：回退期间或结果不确定的会话都不能再写入。
    this.assertStopEditIdle(record)
    record.autoWakePaused = false
    const turn: HarnessTurn = {
      operationId: operation,
      fingerprint,
      prompt: text,
      ...(promptContent ? { promptContent: structuredClone(promptContent) } : {}),
      text: '',
      state: 'queued',
      tools: [],
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(writeScope ? { writeScope } : {}),
    }
    if (!record.turns.length && !record.titleFromHarness) {
      record.title = (displayPrompt ?? text).trim().slice(0, 80)
      if (record.nativeSessionId && !this.isOfficialMember(record.nativeSessionId))
        await this.native('rename', { sessionId: record.nativeSessionId, title: record.title })
    }
    record.turns.push(turn)
    active.turn = turn
    active.cancelled = false
    this.changed(record)
    try {
      await this.save(record)
    } catch (e) {
      active.turn = undefined
      record.turns.pop()
      throw e
    }
    active.done = new Promise<void>((resolve) =>
      this.pendingRuns.set(record.id, () => {
        turn.state = 'running'
        this.changed(record)
        // Reported as observed, so the durable record says what the execution is
        // doing rather than what it was registered with.
        void this.reportNotification(record, turn, 'running', this.turnSummary(turn)).catch(
          () => {},
        )
        void (
          record.nativeSessionId && !this.conversationOwners.has(record.id)
            ? this.runConversation(record, active, turn)
            : this.run(record, active, turn)
        ).finally(resolve)
      }),
    )
    this.drainQueue()
    return this.view(record)
  }
  private native(method: string, request: object) {
    return invokeHostRemote(this.ctx, { namespace: 'session', method, args: { request } })
  }
  private isOfficialMember(sessionId: string): boolean {
    return this.ctx.sessions.get(asSessionId<SessionId>(sessionId))?.header.origin === 'subagent'
  }
  /** Admit delegated work through the real official Agent so its UI owns streaming and approvals. */
  private async runConversation(record: HarnessSession, active: Active, turn: HarnessTurn) {
    try {
      if (active.cancelled) return await this.run(record, active, turn)
      // A queued native turn may have waited through opt-out. Recheck before
      // writing a new user turn into the official Session, not only in llm/stream.
      this.assertMiniMaxCodeRouteEnabled(record)
      await this.native('prompt', {
        sessionId: record.nativeSessionId,
        requestId: harnessRequestId(record, turn),
        mode: 'queue',
        content: [{ type: 'text', text: turn.prompt }],
      })
      const agent = this.ctx.agents.get(asSessionId<SessionId>(record.nativeSessionId!))
      if (!agent) throw Error('官方会话未就绪')
      await agent.whenIdle()
      await this.ctx.sessions.flush(agent.session)
      // The official LLM stream invokes the same Harness turn through
      // conversationStream. Its ACP completion may settle just after the Agent
      // becomes idle, so wait for the service event instead of polling or
      // manufacturing a second prompt.
      if (active.turn === turn)
        await new Promise<void>((resolve) => {
          const done = () => {
            this.events.off(record.id, done)
            resolve()
          }
          this.events.once(record.id, done)
        })
      if (active.turn === turn) throw Error('官方会话未进入原 Harness 轮次')
    } catch (error) {
      if (active.turn === turn) {
        turn.state = active.cancelled ? 'cancelled' : 'failed'
        turn.error = '官方对话未完成外部任务；原指令不会自动重发。'
        active.turn = undefined
        this.changed(record)
        await this.save(record)
        await this.syncNotification(record, turn)
        this.drainQueue()
      }
    }
  }
  /**
   * Confirm and re-assert a combination's fixed model and reasoning parameters on the
   * live ACP session, immediately before a prompt is sent.
   *
   * The pinned values are re-applied rather than read from the cached advertisement: a
   * resumed session and a session whose configuration drifted must both be decided by
   * what the agent reports now. A refusal fails the turn, so no prompt is dispatched
   * with parameters the combination did not ask for.
   */
  private async pinSession(record: HarnessSession, active: Active, effort?: string) {
    const adapter = adapterFor(record.harnessRef, record.modelRef, this.modelSources)
    if (!adapter || (!adapter.configureSession && !adapter.verifySession)) return
    const acp = active.acp
    if (!acp) throw Error('Harness 连接已关闭，无法在发送任务前确认固定模型')
    const snapshot = {
      agent: active.agentInfo ?? {},
      session: active.sessionInfo ?? {},
      configOptions: active.configOptions,
    }
    const selectedRecord = effort === undefined ? record : { ...record, reasoningEffort: effort }
    if (adapter.configureSession) {
      const configured = await adapter.configureSession(
        acp,
        selectedRecord,
        snapshot,
        active.editLaunch,
      )
      if (configured && 'configOptions' in configured) {
        active.configOptions = configured.configOptions
        snapshot.configOptions = configured.configOptions
      }
    }
    adapter.verifySession?.(selectedRecord, snapshot)
  }
  private async observeEditHistory(
    record: HarnessSession,
  ): Promise<ExternalEditHistory | undefined> {
    try {
      if (record.harnessRef === 'grok-build') {
        const response = object(
          await this.active
            .get(record.id)!
            .acp!.request('_x.ai/rewind/points', { sessionId: record.acpSessionId }, 30_000),
        )
        if (!Array.isArray(response.rewind_points)) return
        return {
          sessionId: record.acpSessionId,
          token: hash(response.rewind_points),
          boundaries: response.rewind_points.map((point: { prompt_index: number }) => ({
            id: String(point.prompt_index),
          })),
        }
      }
      if (['minimax-code', 'kimi-code', 'pool'].includes(record.harnessRef)) return
      return await this.externalDriver(record)?.read(
        this.externalContext(record, new AbortController().signal),
      )
    } catch {
      // History capture is optional for normal requests; an unbound input stays unavailable for editing.
      return undefined
    }
  }

  private async run(record: HarnessSession, active: Active, turn: HarnessTurn) {
    const settled = Promise.withResolvers<void>()
    let editBefore: Pick<ExternalEditHistory, 'sessionId' | 'boundaries'> | undefined
    if (record.harnessRef === 'qwen-code') active.qwenUsage = new QwenTurnUsage()
    try {
      this.assertMiniMaxCodeRouteEnabled(record)
      delete active.deadlineError
      delete active.deadlineCleanup
      delete active.inputReceiptError
      delete active.inputReceiptWrite
      if (record.harnessRef !== 'dsh' && this.progressLimits) {
        active.watchdog = new ProgressWatchdog(this.progressLimits, () => {
          if (active.turn !== turn || active.cancelled) return
          active.deadlineError =
            '本轮在等待期限内没有新的正文、思考或工具进展，已停止；具体上游原因未知，原任务未自动重发。'
          if (active.acp)
            active.deadlineCleanup = active.acp.terminate(active.deadlineError).catch(() => {
              active.deadlineError += ' 自有 Harness 进程清理失败，请检查后再运行。'
            })
        })
        active.watchdog.start()
      }
      if (active.cancelled) {
        turn.state = 'cancelled'
        return
      }
      if (record.harnessRef !== 'dsh') {
        await this.pinSession(record, active, turn.reasoningEffort)
        if (active.cancelled) {
          turn.state = 'cancelled'
          return
        }
        const priorTurns = record.turns.slice(0, record.turns.indexOf(turn))
        const priorIds = priorTurns.map((item) => item.native?.userMessageId)
        const knownKimiPrefix =
          record.harnessRef === 'kimi-code' &&
          priorIds.every((id): id is string => typeof id === 'string' && !!id) &&
          new Set(priorIds).size === priorIds.length
        editBefore =
          active.editHistory ??
          (knownKimiPrefix
            ? { sessionId: record.acpSessionId, boundaries: priorIds.map((id) => ({ id: id! })) }
            : active.createdSession && record.turns.length === 1
              ? { sessionId: record.acpSessionId, boundaries: [] }
              : await this.observeEditHistory(record))
        const adapter = adapterFor(record.harnessRef, record.modelRef, this.modelSources)
        const edit = record.nativeSessionId
          ? this.externalMessageEdits.intent(record.nativeSessionId)
          : undefined
        if (edit?.phase === 'admitting') {
          if (turn.operationId !== 'message-edit:' + edit.requestId)
            throw Error('编辑消息的发送身份不一致')
          await this.externalMessageEdits.beginPrompt(record.nativeSessionId!, edit.requestId)
        }
        const promptParts = turn.promptContent ?? [{ type: 'text' as const, text: turn.prompt }]
        assertPromptImages(
          promptParts,
          active.editLaunch?.promptImageSupport,
          active.agentInfo,
          record.harnessRef,
        )
        const generation = active.generation
        const prompt = await resolvePromptContent(
          this.ctx.get('attachments'),
          promptParts,
          this.conversationOwners.get(record.id)?.signal,
        )
        if (
          this.disposed ||
          active.cancelled ||
          active.turn !== turn ||
          this.active.get(record.id) !== active ||
          active.generation !== generation ||
          active.acp?.closed
        )
          throw new HarnessTransportError('读取附件期间会话已停止或连接已变化，未发送任务')
        if (turn.promptContent?.some((part) => part.type === 'image'))
          await this.pinSession(record, active, turn.reasoningEffort)
        if (
          this.disposed ||
          active.cancelled ||
          active.turn !== turn ||
          this.active.get(record.id) !== active ||
          active.generation !== generation ||
          active.acp?.closed
        )
          throw new HarnessTransportError('附件请求的会话状态已变化，未发送任务')
        assertPromptImages(
          prompt,
          active.editLaunch?.promptImageSupport,
          active.agentInfo,
          record.harnessRef,
        )
        adapter?.verifyPrompt?.(
          record,
          {
            agent: active.agentInfo ?? {},
            session: active.sessionInfo ?? {},
            configOptions: active.configOptions,
          },
          prompt,
        )
        active.vibeUsage?.beginTurn()
        // A queued turn may have waited through an opt-out; recheck at the last
        // synchronous boundary before any new prompt reaches mcode.
        this.assertMiniMaxCodeRouteEnabled(record)
        const result = object(
          await active.acp!.request(
            'session/prompt',
            {
              sessionId: record.acpSessionId,
              prompt,
              // 稳定的 operation 身份随提示一起进入 Runtime；扩展据此把真实入库的
              // 用户消息绑定到这条轮次，停止后编辑才有精确边界可用。
              _meta: {
                'opl/clientRequestId': turn.operationId,
                ...(['codex', 'claude'].includes(record.harnessRef)
                  ? { reasoningEffort: turn.reasoningEffort ?? null }
                  : {}),
              },
            },
            24 * 60 * 60 * 1000,
            record.harnessRef === 'opencode'
              ? {
                  stderrFailure:
                    record.harnessRef === 'opencode'
                      ? (line) => openCodeStreamFailure(line, record.acpSessionId ?? '')
                      : undefined,
                  firstProgressTimeoutMessage:
                    'OpenCode 在超时前没有报告正文、思考、工具或授权进展，已停止本轮请求；请检查上游模型或 OpenCode CLI。原任务未自动重发。',
                  isProgress: (method, params) => {
                    if (method !== 'session/update') return false
                    const envelope = object(params)
                    if (envelope.sessionId !== record.acpSessionId) return false
                    const update = object(envelope.update)
                    return [
                      'agent_message_chunk',
                      'agent_thought_chunk',
                      'tool_call',
                      'tool_call_update',
                    ].includes(String(update.sessionUpdate))
                  },
                }
              : undefined,
          ),
        )
        if (active.inputReceiptError) throw new HarnessTransportError(active.inputReceiptError)
        if (['opencode', 'kilo'].includes(record.harnessRef)) {
          const userMessageId = result.userMessageId
          if (typeof userMessageId === 'string' && userMessageId) {
            if (turn.native?.userMessageId && turn.native.userMessageId !== userMessageId)
              throw Error('官方 Harness 返回的用户消息身份不一致')
            turn.native = { ...turn.native, userMessageId }
            await this.save(record)
          }
        }
        let usage = acpUsage(result.usage)
        // Native bridges publish the owned per-turn marker on the ACP result
        // envelope because ACP does not define a usage metadata field. Keep
        // the legacy nested usage form above, then read that envelope marker.
        if (!usage) usage = acpUsage(result)
        const resultMeta = object(result._meta)
        const resultContext = canonicalHarnessContext(resultMeta['opl/contextUsage'])
        if (resultContext) turn.contextUsage = resultContext
        const account =
          record.harnessRef === 'vibe'
            ? active.vibeUsage!.finishTurn(result)
            : record.harnessRef === 'grok-build'
              ? parseGrokTurnUsage(result)
              : record.harnessRef === 'pool'
                ? parsePoolTurnUsage(result)
                : ['opencode', 'kilo'].includes(record.harnessRef)
                  ? parseOpenCodeKiloTurnUsage(result)
                  : {}
        if (!usage) usage = account.usage
        if (usage) turn.usage = usage
        if (account.contextUsage) turn.contextUsage = account.contextUsage
        if (
          edit?.phase === 'admitting' &&
          turn.operationId === 'message-edit:' + edit.requestId &&
          ['end_turn', 'cancelled', 'refusal'].includes(String(result.stopReason))
        )
          await this.externalMessageEdits.settle(record.nativeSessionId!, edit.requestId)
        turn.stopReason = String(result.stopReason ?? 'unknown')
        turn.state = active.cancelled
          ? 'cancelled'
          : turn.stopReason === 'end_turn'
            ? 'completed'
            : turn.stopReason === 'cancelled'
              ? 'cancelled'
              : 'failed'
        // A CLI's end_turn alone does not establish a delivered answer or tool result.
        if (turn.state === 'completed') {
          const outcome = {
            stopReason: turn.stopReason,
            text: turn.text,
            tools: turn.tools.map((tool) => ({ status: tool.status })),
          }
          const verdict = adapter?.acceptResult?.(outcome) ?? acceptVisibleCliResult(outcome)
          if (!verdict.accepted) {
            turn.state = 'failed'
            turn.error =
              verdict.reason ??
              'Harness 报告成功但本轮没有结果，原任务未自动重发，也未改用其他模型或渠道。'
          }
        }
      } else {
        const unlisten = this.ctx.on(
          'session/event',
          (session, event) => {
            if (session.id !== record.acpSessionId) return
            if (event.type === 'assistant/message')
              turn.text += event.data.message.content
                .filter((c) => c.type === 'text')
                .map((c) => c.text)
                .join('')
            if (event.type === 'approval/asked') turn.state = 'waiting_approval'
            if (event.type === 'approval/decided') turn.state = 'running'
            if (event.type === 'tool/call')
              turn.tools.push({
                id: event.data.callId,
                title: event.data.name,
                status: 'pending',
                kind: 'other',
              })
            if (event.type === 'tool/result') {
              const tool = turn.tools.find((t) => t.id === event.data.message.toolCallId)
              if (tool) tool.status = event.data.message.isError ? 'failed' : 'completed'
            }
            this.changed(record)
          },
          { global: true },
        )
        const offQuestions = this.ctx.on(
          'user-questions/request',
          async (request, next) => {
            if (request.agent?.id !== record.acpSessionId) return next()
            turn.state = 'waiting_input'
            this.changed(record)
            await this.save(record)
            // A question has no Session event, so it is announced from the hook
            // that observes it, with the cursor and question ids as its identity.
            await this.announceQuestion(record, turn, request.agent?.session, request.questions)
            try {
              return await next()
            } finally {
              if (active.turn === turn && !active.cancelled) {
                turn.state = 'running'
                this.changed(record)
                void this.reportNotification(record, turn, 'running', this.turnSummary(turn)).catch(
                  () => {},
                )
              }
            }
          },
          { global: true },
        )
        try {
          this.assertMiniMaxCodeRouteEnabled(record)
          await this.native('prompt', {
            sessionId: record.acpSessionId,
            requestId: 'opl-harness-' + hash([record.id, turn.operationId]),
            mode: 'queue',
            content: [{ type: 'text', text: turn.prompt }],
          })
          const agent = this.ctx.agents.get(asSessionId<SessionId>(record.acpSessionId))
          if (!agent) throw Error('DSH 会话未就绪')
          await agent.whenIdle()
          const result = await waitForSession(
            this.ctx,
            { sessionId: agent.id },
            new AbortController().signal,
          )
          turn.state =
            result.outcome.kind === 'completed'
              ? 'completed'
              : result.outcome.kind === 'cancelled'
                ? 'cancelled'
                : 'failed'
          turn.stopReason = result.outcome.kind
          if (result.outcome.kind === 'failed')
            turn.error = nativeFailureMessage(result.outcome.code)
        } finally {
          unlisten()
          offQuestions()
        }
      }
    } catch (error) {
      // A matched error can still need a durable edit-journal write. Register
      // the barrier before exposing terminal state to stream/state readers.
      this.finalizing.set(record.id, settled.promise)
      turn.state = active.cancelled ? 'cancelled' : 'failed'
      if (error instanceof HarnessRequestError) {
        if (error.statistics.usage) turn.usage = error.statistics.usage
        if (error.statistics.contextUsage) turn.contextUsage = error.statistics.contextUsage
      }
      if (error instanceof HarnessRequestError && error.promptSettled)
        turn.stopReason = 'error_response'
      if (error instanceof HarnessRequestError && error.promptSettled && record.nativeSessionId) {
        const intent = this.externalMessageEdits.intent(record.nativeSessionId)
        if (
          intent?.phase === 'prompting' &&
          turn.operationId === 'message-edit:' + intent.requestId
        )
          await this.externalMessageEdits
            .settle(record.nativeSessionId, intent.requestId)
            .catch(() => {})
      }
      // A refused fixed configuration carries an actionable, credential-free reason and
      // must not collapse into the generic transport text.
      turn.error =
        active.deadlineError ??
        active.inputReceiptError ??
        (error instanceof HarnessTransportError || error instanceof HarnessConfigurationError
          ? error.message
          : '执行未完成，请检查 Harness 安装、所选渠道和模型。原任务未自动重发。')
    } finally {
      const qwenUsage = active.qwenUsage?.value()
      if (qwenUsage && !turn.usage) turn.usage = qwenUsage
      delete active.qwenUsage
      const partial = active.vibeUsage?.finishTurn()
      if (partial?.usage && !turn.usage) turn.usage = partial.usage
      if (partial?.contextUsage && !turn.contextUsage) turn.contextUsage = partial.contextUsage
      active.vibeUsage?.endTurn()
      this.finalizing.set(record.id, settled.promise)
      try {
        await this.finishTurn(record, active, turn, editBefore)
      } finally {
        this.finalizing.delete(record.id)
        settled.resolve()
        this.changed(record)
      }
    }
  }
  /** Release a turn only after its history read, reconnection and durable result settle. */
  private async finishTurn(
    record: HarnessSession,
    active: Active,
    turn: HarnessTurn,
    editBefore: Pick<ExternalEditHistory, 'sessionId' | 'boundaries'> | undefined,
  ): Promise<void> {
    active.watchdog?.dispose()
    delete active.watchdog
    await active.deadlineCleanup
    delete active.deadlineCleanup
    await active.inputReceiptWrite?.catch(() => {
      active.inputReceiptError ??= 'Step 用户消息身份未能保存，请检查磁盘后重新读取对话。'
    })
    delete active.inputReceiptWrite
    await this.titleUpdates.get(record.id)
    if (active.deadlineError) {
      turn.state = 'failed'
      turn.error = active.deadlineError
    }
    if (active.cancelled) {
      turn.state = 'cancelled'
      delete turn.error
    }
    if (active.inputReceiptError) {
      turn.state = 'failed'
      turn.error = active.inputReceiptError
      await this.persistStepInputConflict(record, turn).catch(() => {
        this.ctx.logger?.warn('Step 用户消息身份冲突尚未保存，编辑保护已保留')
      })
    }
    if (turn.contextUsage?.size !== undefined)
      this.recordContextWindow(record, active, turn.contextUsage.size)
    for (const p of active.approvals.values()) active.acp?.answer(p.rpcId)
    active.approvals.clear()
    active.turn = undefined
    if (editBefore && record.harnessRef !== 'dsh') {
      try {
        const after =
          record.harnessRef === 'kimi-code'
            ? await kimiMessageEditDriver().read(
                this.externalContext(record, new AbortController().signal),
              )
            : await this.observeEditHistory(record)
        if (
          after?.sessionId === editBefore.sessionId &&
          after.boundaries.length === editBefore.boundaries.length + 1 &&
          (!turn.native?.userMessageId ||
            turn.native.userMessageId === after.boundaries.at(-1)?.id) &&
          editBefore.boundaries.every((item, index) => item.id === after.boundaries[index]?.id)
        ) {
          const statistics =
            after.boundaries.slice(editBefore.boundaries.length).findLast((item) => item.statistics)
              ?.statistics ?? after.boundaries.at(-1)?.statistics
          const historyUsage = canonicalHarnessUsage(statistics?.usage)
          const historyContext = canonicalHarnessContext(statistics?.contextUsage)
          if (historyUsage && !turn.usage) turn.usage = historyUsage
          if (historyContext && !turn.contextUsage) turn.contextUsage = historyContext
          if (turn.contextUsage?.size !== undefined)
            this.recordContextWindow(record, active, turn.contextUsage.size)
          turn.native = {
            ...turn.native,
            userMessageId: after.boundaries.at(-1)!.id,
            historyVersion: after.token,
          }
          const current = this.active.get(record.id)
          if (current) current.editHistory = after
        } else delete active.editHistory
      } catch {
        // The normal answer is retained; an unverified vendor input cannot be edited.
      }
    }
    if (record.assignment) {
      if (turn.state === 'completed') {
        turn.report ??= {
          summary: turn.text,
          artifacts: [],
          checks: [],
          remaining: ['执行者未单独提交验证清单，请发起对话核验。'],
        }
        turn.review ??= { decision: 'pending' }
      }
      turn.delivery ??= { id: hash([record.id, turn.operationId]), state: 'pending', attempt: 0 }
    }
    this.changed(record)
    await this.save(record).catch(() => {
      turn.state = 'failed'
      turn.error = '结果未能持久保存，请检查磁盘后重试读取'
      this.changed(record)
    })
    // The turn's own record is written first, so the reviewer can always read
    // what the notification announces; a crash between the two writes is
    // repaired by the next reconciliation pass rather than by a resend.
    await this.syncNotification(record, turn)
    this.drainQueue()
    void this.flushDeliveries().catch(() => {})
  }
  async wait(
    input: { sessionId: string; operationId?: string },
    signal: AbortSignal,
  ): Promise<HarnessSnapshot> {
    await this.ready
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.events.off(input.sessionId, check)
        signal.removeEventListener('abort', abort)
      }
      const abort = () => {
        cleanup()
        reject(Error('等待已取消，任务可通过 snapshot 读取'))
      }
      const check = () => {
        const r = this.records.get(input.sessionId)
        if (!r) {
          cleanup()
          reject(Error('组合会话不存在'))
          return
        }
        const t = input.operationId
          ? r.turns.find((t) => t.operationId === input.operationId)
          : r.turns.at(-1)
        if (input.operationId && !t) {
          cleanup()
          reject(Error('operation 不存在'))
          return
        }
        if (
          (!t || !['queued', 'running', 'waiting_child'].includes(t.state)) &&
          !this.finalizing.has(input.sessionId)
        ) {
          cleanup()
          resolve(this.view(r))
        }
      }
      this.events.on(input.sessionId, check)
      signal.addEventListener('abort', abort, { once: true })
      check()
    })
  }
  /**
   * 停止后编辑的入口可见性。客户端只在 supported 时显示入口；
   * 磁盘上的文件永远不在本流程内，也不会被撤销。
   */
  async stopEditState(input: { sessionId: string }) {
    await this.ready
    const target = this.stopEditTarget(input.sessionId)
    if (
      target?.record?.harnessRef === MINIMAX_CODE_HARNESS &&
      !this.stopEditBlocked(input.sessionId)
    )
      await this.connect(target.record)
    return this.stopEdits.state({ sessionId: required(input.sessionId, 'sessionId') })
  }

  /** Reject model requests while the addressed conversation's history is being changed or unresolved. */
  async assertConversationEditable(sessionId: string, admittedEdit = false): Promise<void> {
    await this.ready
    // Resolve the picker before the official request hook derives its model options.
    await this.waitForSelectionChange(sessionId)
    const session = this.ctx.sessions.get(asSessionId<SessionId>(sessionId))
    if (
      !admittedEdit &&
      (this.messageEdits.pending(sessionId) ||
        (session && unresolvedMessageEdit(session.snapshotEvents())))
    )
      throw Error('编辑消息的发送结果尚未确认，请重新读取对话')
    const externalIntent = this.externalMessageEdits.intent(sessionId)
    if (
      this.externalMessageEdits.pending(sessionId) &&
      !(admittedEdit && externalIntent?.phase === 'admitting')
    )
      throw Error('外部会话编辑的结果尚未确认，请重新读取对话')
    if (this.stopEdits.editing(sessionId)) throw Error('此会话正在处理停止后编辑，请稍后再发送')
    const blocked = this.stopEditBlocked(sessionId)
    if (blocked) throw Error(blocked)
  }

  /** Check the selected model before an edit can change either conversation history. */
  async assertConversationModelAvailable(sessionId: string): Promise<void> {
    await this.ready
    await this.waitForSelectionChange(sessionId)
    const session = this.ctx.sessions.get(asSessionId<SessionId>(sessionId))
    if (!session) return
    const selection = this.ctx.sessionProjections.snapshot(session, ['modelSelection']).values
      .modelSelection
    const ref = selection?.next ?? selection?.lastUsed
    if (!ref || !OFM_PROVIDERS.includes(ref.provider)) return
    const catalog = await this.executionCatalog()
    const definition = this.combinationFor(sessionId, catalog, ref)
    await assertOfmModelAvailable(
      this.ctx,
      ref,
      this.options.readOfm,
      (definition?.harnessRef ?? defaultHarness(ref)) !== 'dsh',
    )
  }

  /** Record native defaults and CLI-owned effort omission before the Agent prepares its first step. */
  async prepareConversationModel(agent: Agent, signal?: AbortSignal): Promise<void> {
    await Promise.all([this.selectionsReady, this.recordsReady])
    signal?.throwIfAborted()
    const current = agent.model.current()
    if (!current) return
    // New Agents inherit live global defaults until their first selection is
    // recorded. Freeze that inherited choice before awaits so another Session's
    // background default save cannot change this creation. select is a no-op
    // when the same selection is already recorded on this Session.
    agent.model.select(current)
    const binding = this.selections[agent.session.id]
    const catalog = await this.executionCatalog()
    const definition = this.combinationFor(agent.session.id, catalog, current)
    const selected = await this.normalizeConversationSelection(current, definition, signal)
    signal?.throwIfAborted()
    if (this.disposed) throw Error('组合服务已关闭')
    const latest = agent.model.current()
    if (
      this.ctx.agents.get(agent.id) !== agent ||
      this.selections[agent.session.id] !== binding ||
      !latest ||
      modelRefKey(latest) !== modelRefKey(current) ||
      latest.reasoningEffort !== current.reasoningEffort
    )
      throw new LlmError('模型选择已改变，请重新发送；本轮未使用旧模型。', 'HARNESS_BINDING')
    if (selected.reasoningEffort !== current.reasoningEffort) agent.model.select(selected)
  }

  private normalizeConversationSelection(
    selection: ModelSelection,
    definition: CombinationDefinition | undefined,
    signal?: AbortSignal,
  ): Promise<AgentModelSelection> {
    return normalizeConversationSelection(this.selectionHost(), selection, definition, signal)
  }

  /** Validate the frozen request without changing its model or reasoning selection. */
  async prepareConversationRequest(
    sessionId: string,
    request: LlmCallConfig,
  ): Promise<LlmCallConfig> {
    await this.ready
    await this.waitForSelectionChange(sessionId)
    const catalog = await this.executionCatalog()
    const definition = this.combinationFor(sessionId, catalog, request)
    await assertOfmModelAvailable(
      this.ctx,
      request,
      this.options.readOfm,
      (definition?.harnessRef ?? defaultHarness(request)) !== 'dsh',
    )
    const session = this.ctx.sessions.get(asSessionId<SessionId>(sessionId))
    const selection = session
      ? this.ctx.sessionProjections.snapshot(session, ['modelSelection']).values.modelSelection
      : undefined
    const current = selection?.next ?? selection?.lastUsed
    if (current && modelRefKey(current) !== modelRefKey(request))
      throw new LlmError('模型选择已改变，请重新发送；本轮未使用旧模型。', 'HARNESS_BINDING')
    return request
  }

  private selectionHost(): HarnessSelectionHost {
    const self = this
    return {
      ctx: this.ctx,
      records: this.records,
      active: this.active,
      get selections() {
        return self.selections
      },
      externalEfforts: this.externalEfforts,
      effortChanges: this.effortChanges,
      modelSources: this.modelSources,
      catalogStore: this.catalogStore,
      reasoningPreflights: this.reasoningPreflights,
      runtimeMaintenance: this.runtimeMaintenance,
      get ready() {
        return self.ready
      },
      get selectionsReady() {
        return self.selectionsReady
      },
      get recordsReady() {
        return self.recordsReady
      },
      get disposed() {
        return self.disposed
      },
      executionCatalog: () => this.executionCatalog(),
      adapterOptions: (command, prefix, codexRuntime) =>
        this.adapterOptions(command, prefix, codexRuntime),
      conversationBinding: (session, definition) => this.conversationBinding(session, definition),
      bindSelection: (sessionId, combination) => this.bindSelection(sessionId, combination),
      runSelectionChange: (sessionId, operation) => this.runSelectionChange(sessionId, operation),
      native: (method, request) => this.native(method, request),
      assertMiniMaxCodeRouteEnabled: (route) => this.assertMiniMaxCodeRouteEnabled(route),
      cliOwnsEffort: (definition) => this.cliOwnsEffort(definition),
      normalizeConversationSelection: (selection, definition, signal) =>
        this.normalizeConversationSelection(selection, definition, signal),
      modelSelection: (sessionId) => this.modelSelection(sessionId),
      reasoningPreflight: (input) => this.reasoningPreflight(input),
      reasoningPreflightAdmitted: (input) => this.reasoningPreflightAdmitted(input),
      replacementFor: (sessionId, catalog, ref) => this.replacementFor(sessionId, catalog, ref),
      conversationEffort: (sessionId, definition, catalog) =>
        this.conversationEffort(sessionId, definition, catalog),
      combinationFor: (sessionId, catalog, ref) => this.combinationFor(sessionId, catalog, ref),
      unavailableConversationSelection: (sessionId, catalog, ref) =>
        this.unavailableConversationSelection(sessionId, catalog, ref),
      selectionForModel: (session, selected) => this.selectionForModel(session, selected),
    }
  }

  private delegationHost(): HarnessDelegationHost {
    const self = this
    return {
      ctx: this.ctx,
      records: this.records,
      active: this.active,
      observed: this.observed,
      deliveryJobs: this.deliveryJobs,
      pendingRuns: this.pendingRuns,
      get ready() {
        return self.ready
      },
      get disposed() {
        return self.disposed
      },
      get pumping() {
        return self.pumping
      },
      set pumping(value: boolean) {
        self.pumping = value
      },
      parentOf: (origin) => this.parentOf(origin),
      summary: (record) => this.summary(record),
      view: (record, turns) => this.view(record, turns),
      save: (record) => this.save(record),
      changed: (record) => this.changed(record),
      executionCatalog: () => this.executionCatalog(),
      combinations: () => this.combinations(),
      assertStopEditIdle: (record) => this.assertStopEditIdle(record),
      start: (input, deferConnection) =>
        deferConnection === undefined ? this.start(input) : this.start(input, deferConnection),
      prompt: (input, reasoningEffort) =>
        reasoningEffort === undefined ? this.prompt(input) : this.prompt(input, reasoningEffort),
      wait: (input, signal) => this.wait(input, signal),
      cancel: (input, pauseWake) =>
        pauseWake === undefined ? this.cancel(input) : this.cancel(input, pauseWake),
      native: (method, request) => this.native(method, request),
      taskResult: (origin, id, operationId) => this.taskResult(origin, id, operationId),
      syncNotification: (record, turn, read) =>
        read === undefined
          ? this.syncNotification(record, turn)
          : this.syncNotification(record, turn, read),
      drainQueue: () => this.drainQueue(),
      flushDeliveries: () => this.flushDeliveries(),
    }
  }

  private stopEditContext(): HarnessStopEditContext {
    const self = this
    return {
      ctx: this.ctx,
      directory: this.directory,
      records: this.records,
      active: this.active,
      finalizing: this.finalizing,
      connecting: this.connecting,
      externalEditing: this.externalEditing,
      externalHistories: this.externalHistories,
      get selections() {
        return self.selections
      },
      catalogStore: this.catalogStore,
      get stopEdits() {
        return self.stopEdits
      },
      stopEditIntents: this.stopEditIntents,
      messageEdits: this.messageEdits,
      externalMessageEdits: this.externalMessageEdits,
      runtimeMaintenance: this.runtimeMaintenance,
      get ready() {
        return self.ready
      },
      save: (record) => this.save(record),
      changed: (record) => this.changed(record),
      native: (method, request) => this.native(method, request),
      bindSelection: (sessionId, combination) => this.bindSelection(sessionId, combination),
      cancel: (input, pauseWake) =>
        pauseWake === undefined ? this.cancel(input) : this.cancel(input, pauseWake),
      connectAdmitted: (record) => this.connectAdmitted(record),
      enterEngine: (id, operation) => this.enterEngine(id, operation),
      openConnection: (record, provisional) =>
        provisional === undefined
          ? this.openConnection(record)
          : this.openConnection(record, provisional),
      pinSession: (record, active, effort) => this.pinSession(record, active, effort),
      assertConversationModelAvailable: (sessionId) =>
        this.assertConversationModelAvailable(sessionId),
      externalDriver: (record) => this.externalDriver(record),
      supportsExternalEditing: (record) => this.supportsExternalEditing(record),
      externalContext: (record, signal) => this.externalContext(record, signal),
      disconnectIdleConnection: (record, expected) =>
        this.disconnectIdleConnection(record, expected),
      externalHistory: (record) => this.externalHistory(record),
      storedKiloHistory: (record) => this.storedKiloHistory(record),
      externalRecoveryHistory: (record, intent) => this.externalRecoveryHistory(record, intent),
      messageEditState: (input) => this.messageEditState(input),
      stopEditTarget: (sessionId) => this.stopEditTarget(sessionId),
      stopEditBlocked: (sessionId) => this.stopEditBlocked(sessionId),
      stopEditRuntime: (target) => this.stopEditRuntime(target),
      stopEditReviewBySession: (sessionId) => this.stopEditReviewBySession(sessionId),
      stopEditBusy: (target) => this.stopEditBusy(target),
      stopEditSettle: (target) => this.stopEditSettle(target),
      commitStopEdit: (input) => this.commitStopEdit(input),
      rebindNativeBranch: (sessionId, previousSessionId, editedHead) =>
        this.rebindNativeBranch(sessionId, previousSessionId, editedHead),
    }
  }

  private externalDriver(record: HarnessSession): ExternalMessageEditDriver | undefined {
    return externalDriver(record)
  }

  /** Antigravity can allocate a fresh first input, but exposes no history rewind API. */
  private supportsExternalEditing(record: HarnessSession): boolean {
    return supportsExternalEditing(this.stopEditContext(), record)
  }

  private externalContext(record: HarnessSession, signal: AbortSignal) {
    return externalContext(this.stopEditContext(), record, signal)
  }

  /** Release only the idle connection observed here, after its owned process and bridge have exited. */
  private disconnectIdleConnection(record: HarnessSession, expected?: Active): Promise<void> {
    return disconnectIdleConnection(this.stopEditContext(), record, expected)
  }

  private externalHistory(record: HarnessSession) {
    return externalHistory(this.stopEditContext(), record)
  }

  private storedKiloHistory(record: HarnessSession) {
    return storedKiloHistory(this.stopEditContext(), record)
  }

  private externalRecoveryHistory(
    record: HarnessSession,
    intent: ReturnType<ExternalMessageEditTransactions['intent']>,
  ) {
    return externalRecoveryHistory(this.stopEditContext(), record, intent)
  }

  /** Read editable inputs and verify stopped replacements without forking or sending prompts. */
  async messageEditState(input: { sessionId: string }): Promise<MessageEditState> {
    return messageEditState(this.stopEditContext(), input)
  }

  /** Normal composer send with an exact old message target; retains the Session identity. */
  async messageEditSend(input: MessageEditSend) {
    return messageEditSend(this.stopEditContext(), input)
  }

  /** Match only the official pre-step's exact admitted replacement input. */
  async claimMessageEdit(
    agent: Agent,
    messages: readonly UserMessage[],
    turn: number,
    step: number,
  ): Promise<void> {
    return claimMessageEdit(this.stopEditContext(), agent, messages, turn, step)
  }

  /** Commit in the official open step, before request message derivation. */
  async commitMessageEdit(
    agent: Agent,
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    return commitMessageEdit(this.stopEditContext(), agent, turn, step, signal)
  }

  /**
   * 回退到所选用户消息之前，并把原文交给客户端放回普通输入框。
   * 本方法绝不自行发送：下一次模型请求只能由用户再次发送触发。
   */
  async stopEdit(input: { clientRequestId: string; sessionId: string; boundaryId: string }) {
    return stopEdit(this.stopEditContext(), input)
  }

  /** 客户端确认已把原文放回输入框，避免恢复后重复填入同一条草稿。 */
  async acknowledgeStopEditDraft(input: { sessionId: string; clientRequestId: string }) {
    return acknowledgeStopEditDraft(this.stopEditContext(), input)
  }

  private stopEditHost(): StopEditHost {
    return stopEditHost(this.stopEditContext())
  }

  private stopEditBlocked(sessionId: string): string | undefined {
    return stopEditBlocked(this.stopEditContext(), sessionId)
  }

  private assertStopEditIdle(record: HarnessSession): void {
    assertStopEditIdle(this.stopEditContext(), record)
  }

  private stopEditTarget(sessionId: string) {
    return stopEditTarget(this.stopEditContext(), sessionId)
  }

  private stopEditRuntime(target: import('./stop-edit.ts').StopEditTarget) {
    return stopEditRuntime(this.stopEditContext(), target)
  }

  private stopEditReviewBySession(sessionId: string) {
    return stopEditReviewBySession(this.stopEditContext(), sessionId)
  }

  private stopEditBusy(target: import('./stop-edit.ts').StopEditTarget) {
    return stopEditBusy(this.stopEditContext(), target)
  }

  private stopEditSettle(target: import('./stop-edit.ts').StopEditTarget) {
    return stopEditSettle(this.stopEditContext(), target)
  }

  private commitStopEdit(input: Parameters<typeof commitStopEdit>[1]) {
    return commitStopEdit(this.stopEditContext(), input)
  }

  private rebindNativeBranch(sessionId: string, previousSessionId: string, editedHead: string) {
    return rebindNativeBranch(this.stopEditContext(), sessionId, previousSessionId, editedHead)
  }

  private recordMiniMaxUsage(record: HarnessSession, active: Active, params: unknown) {
    return recordMiniMaxUsage(this.stopEditContext(), record, active, params)
  }

  private recordNativeBoundary(record: HarnessSession, params: unknown) {
    return recordNativeBoundary(this.stopEditContext(), record, params)
  }
  async cancel(input: { sessionId: string }, pauseWake = true) {
    await this.ready
    const record = this.records.get(required(input.sessionId, 'sessionId')),
      active = this.active.get(input.sessionId)
    if (!record) throw Error('组合会话不存在')
    const turn = active?.turn
    // The stop belongs to this turn even if persistence or child cancellation yields.
    if (turn) {
      active!.cancelled = true
      active!.watchdog?.dispose()
    }
    if (pauseWake) {
      record.autoWakePaused = true
      await this.save(record)
    }
    await Promise.all(
      [...this.records.values()]
        .filter(
          (child) =>
            this.parentOf(child.origin)?.id === record.id && this.active.get(child.id)?.turn,
        )
        .map((child) => this.cancel({ sessionId: child.id }, pauseWake)),
    )
    if (turn && active?.turn === turn) {
      if (active.turn.state === 'queued') {
        const launch = this.pendingRuns.get(record.id)
        this.pendingRuns.delete(record.id)
        active.turn.state = 'cancelled'
        launch?.()
      }
      for (const a of active.approvals.values()) active.acp?.answer(a.rpcId)
      active.approvals.clear()
      if (record.harnessRef === 'dsh')
        await this.native('cancel', { sessionId: record.acpSessionId })
      else {
        active.acp?.cancel(record.acpSessionId)
        if (record.nativeSessionId) {
          if (this.isOfficialMember(record.nativeSessionId))
            this.ctx.agents
              .get(asSessionId<SessionId>(record.nativeSessionId))
              ?.cancel({ kind: 'user' })
          else await this.native('cancel', { sessionId: record.nativeSessionId })
        }
      }
      const timer = setTimeout(() => {
        void active.acp?.dispose()
      }, 5000)
      await active.done
      clearTimeout(timer)
    }
    return this.view(record)
  }
  cooperationSettings() {
    return cooperationSettings(this.ctx)
  }
  async saveCooperationSettings(input: unknown) {
    return saveCooperationSettings(this.ctx, input)
  }
  async taskSummaries(origin: HarnessOrigin): Promise<HarnessTaskSummary[]> {
    return taskSummaries(this.delegationHost(), origin)
  }
  async tasksFor(origin: HarnessOrigin) {
    return tasksFor(this.delegationHost(), origin)
  }
  async delegateFrom(origin: HarnessOrigin, input: unknown, signal = new AbortController().signal) {
    return delegateFrom(this.delegationHost(), origin, input, signal)
  }
  async cancelTask(origin: HarnessOrigin, id: string) {
    return cancelTask(this.delegationHost(), origin, id)
  }
  async resultFor(origin: HarnessOrigin, input: unknown, signal = new AbortController().signal) {
    return resultFor(this.delegationHost(), origin, input, signal)
  }
  async taskResult(origin: HarnessOrigin, id: string, operationId?: string) {
    return taskResult(this.delegationHost(), origin, id, operationId)
  }
  async submitReport(origin: HarnessOrigin, input: unknown) {
    return submitReport(this.delegationHost(), origin, input)
  }
  async reviewTask(origin: HarnessOrigin, input: unknown) {
    return reviewTask(this.delegationHost(), origin, input)
  }
  async retryDelivery(id: string) {
    return retryDelivery(this.delegationHost(), id)
  }
  private requireExternalReviewer(origin: HarnessOrigin): void {
    requireExternalReviewer(origin)
  }
  private registerNotification(record: HarnessSession, operationId: string): Promise<void> {
    return registerNotification(this.ctx, record, operationId)
  }
  private turnSummary(turn: HarnessTurn): string {
    return turnSummary(turn)
  }
  private reportNotification(
    record: HarnessSession,
    turn: HarnessTurn,
    state: import('../../collaboration/host/feedback/types.ts').HarnessReportState,
    summary: string,
    pause?: import('../../collaboration/host/feedback/types.ts').HarnessPauseReport,
  ) {
    return reportNotification(this.ctx, record, turn, state, summary, pause)
  }
  private announceApproval(record: HarnessSession, turn: HarnessTurn): Promise<void> {
    return announceApproval(this.delegationHost(), record, turn)
  }
  private announceQuestion(
    record: HarnessSession,
    turn: HarnessTurn,
    session: Session | undefined,
    questions: readonly AskUserQuestionItem[],
  ): Promise<void> {
    return announceQuestion(this.delegationHost(), record, turn, session, questions)
  }
  private syncNotification(record: HarnessSession, turn: HarnessTurn, read = false): Promise<void> {
    return syncNotification(this.delegationHost(), record, turn, read)
  }
  private drainQueue() {
    drainQueue(this.delegationHost())
  }
  private flushDeliveries() {
    return flushDeliveries(this.delegationHost())
  }

  async modelSelection(sessionId: string) {
    return modelSelection(this.selectionHost(), sessionId)
  }
  /** CLI-advertised controls for third-party sources are not native provider effort IDs. */
  private cliOwnsEffort(definition: CombinationDefinition): boolean {
    return cliOwnsEffort(definition, this.modelSources)
  }
  private selectEffort(input: ModelSelection & { sessionId: string }): Promise<unknown> {
    return selectEffort(this.selectionHost(), input)
  }
  async reasoningPreflight(input: {
    sessionId: string
    combination: string
  }): Promise<HarnessReasoningPreflight> {
    return reasoningPreflight(this.selectionHost(), input)
  }
  private reasoningPreflightAdmitted(input: {
    sessionId: string
    combination: string
  }): Promise<HarnessReasoningPreflight> {
    return reasoningPreflightAdmitted(this.selectionHost(), input)
  }
  private selectionForModel(session: Session, selected: CombinationDefinition) {
    return selectionForModel(this.selectionHost(), session, selected)
  }
  private replacementFor(
    sessionId: string,
    catalog: ExecutionCatalog,
    ref: ModelRef,
  ): { record: HarnessSession; definition: CombinationDefinition } | undefined {
    return replacementFor(this.selectionHost(), sessionId, catalog, ref)
  }
  private conversationEffort(
    sessionId: string,
    definition: CombinationDefinition,
    catalog: ExecutionCatalog,
  ) {
    return conversationEffort(this.selectionHost(), sessionId, definition, catalog)
  }
  private combinationFor(
    sessionId: string,
    catalog: ExecutionCatalog,
    ref: { provider: string; model: string },
  ): CombinationDefinition | undefined {
    return combinationFor(this.selectionHost(), sessionId, catalog, ref)
  }
  private unavailableConversationSelection(
    sessionId: string,
    catalog: ExecutionCatalog,
    ref: ModelRef,
  ): boolean {
    return unavailableConversationSelection(this.selectionHost(), sessionId, catalog, ref)
  }
  async selectCombination(input: { sessionId: string; combination: string }) {
    return selectCombination(this.selectionHost(), input)
  }
  /** Bind a new official role without changing deployment defaults or an existing conversation. */
  async bindRoleCombination(agent: Agent, combination: string): Promise<void> {
    return bindRoleCombination(this.selectionHost(), agent, combination)
  }
  private assertMiniMaxNativeSelectionEnabled(sessionId: string): Promise<void> {
    return assertMiniMaxNativeSelectionEnabled(this.selectionHost(), sessionId)
  }

  /** Bridge external official Harness output through the official conversation stream. */
  async *conversationStream(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    await this.ready
    if (options.provider === MINIMAX_CODE_PROVIDER) this.assertMinimaxCodeEnabled()
    if (options.sessionId && !options.purpose)
      await this.assertMiniMaxNativeSelectionEnabled(options.sessionId)
    if (options.sessionId && !options.purpose) {
      const waited = await this.waitForSelectionChange(options.sessionId)
      if (waited) {
        const session = this.ctx.sessions.get(asSessionId<SessionId>(options.sessionId))
        const projection = session
          ? this.ctx.sessionProjections.snapshot(session, ['modelSelection']).values.modelSelection
          : undefined
        const selected = projection?.next ?? projection?.lastUsed
        if (selected && modelRefKey(selected) !== modelRefKey(options))
          throw new LlmError('模型选择已改变，请重新发送；本轮未使用旧模型。', 'HARNESS_BINDING')
      }
    }
    const catalog = options.sessionId ? await this.executionCatalog() : undefined
    if (options.sessionId && !options.purpose)
      // The first admission may have waited through opt-out. Re-read the saved
      // selection before any fallback can choose a native DSH route instead.
      await this.assertMiniMaxNativeSelectionEnabled(options.sessionId)
    const definition =
      options.sessionId && catalog
        ? this.combinationFor(options.sessionId, catalog, options)
        : undefined
    if (options.sessionId && !options.purpose && catalog && !definition) {
      if (this.unavailableConversationSelection(options.sessionId, catalog, options))
        throw new LlmError(
          '此对话原先选择的执行组合已移除或停用，请在模型菜单重新选择执行组合后发送；本轮未改用 DSH 或其他 Harness。',
          'HARNESS_BINDING',
        )
      if (catalog.combinations.some((item) => modelRefKey(item.modelRef) === modelRefKey(options)))
        throw new LlmError(
          '请在模型菜单明确选择一个已启用的执行组合，本轮未发送。',
          'HARNESS_BINDING',
        )
    }
    if (options.provider === MINIMAX_CODE_PROVIDER) this.assertMinimaxCodeEnabled()
    if (definition) this.assertMiniMaxCodeRouteEnabled(definition)
    if (!options.sessionId || options.purpose || !definition || definition.harnessRef === 'dsh') {
      if (
        options.sessionId &&
        !options.purpose &&
        definition &&
        this.selections[options.sessionId] !== definition.id &&
        !this.replacementFor(options.sessionId, catalog!, options)
      )
        await this.bindSelection(options.sessionId, definition.id)
      yield* next()
      return
    }
    const session = this.ctx.sessions.get(asSessionId<SessionId>(options.sessionId))
    if (!session) throw new LlmError('原会话已不存在', 'HARNESS_BINDING')
    if (
      this.zcodeModeForOrigin({ kind: 'dsh', sessionId: options.sessionId }) === 'build' &&
      !['codex', 'claude', 'zcode'].includes(definition.harnessRef)
    )
      throw new LlmError(
        '此 Harness 尚无已验证的官方 Auto Review 接口，请选择其他权限模式。',
        'HARNESS_PERMISSION',
      )
    const binding = this.conversationBinding(session, definition)
    const bound =
      this.replacementFor(session.id, catalog!, definition.modelRef)?.record ??
      [...this.records.values()].find(
        (record) =>
          record.nativeSessionId === options.sessionId && record.combination === definition.id,
      )
    const user = options.messages.findLast(
      (message) =>
        message.role === 'user' &&
        ['user', 'agent-message', 'subagent-settled'].includes(message.source?.kind ?? ''),
    )
    if (!user) throw harnessInputError('conversation-current', 'blank', { currentTextLength: 0 })
    const currentTextLength = currentHarnessInputText(user.content, 'conversation-current').length
    const admitted = bound?.turns.find(
      (turn) =>
        user.source?.kind === 'user' &&
        'rpcId' in user.source &&
        user.source.rpcId === harnessRequestId(bound, turn),
    )
    const editIntent = this.externalMessageEdits.intent(session.id)
    const editRpc =
      user.source?.kind === 'user' && 'rpcId' in user.source ? user.source.rpcId : undefined
    const operationId =
      admitted?.operationId ??
      (editIntent?.phase === 'admitting' && editIntent.requestId === editRpc
        ? 'message-edit:' + editRpc
        : 'conversation:' + hash(user))
    const previous = bound?.turns.find((turn) => turn.operationId === operationId)
    const messages =
      bound?.turns.length && !previous
        ? options.messages.slice(options.messages.indexOf(user))
        : previous
          ? []
          : options.messages
    const input = previous
      ? {
          text: requireHarnessInputText(previous.prompt, 'conversation-replay', {
            currentTextLength,
          }),
          content: previous.promptContent,
        }
      : conversationInput(
          messages,
          user,
          bound?.turns.length ? 'conversation-followup' : 'conversation-first-binding',
        )
    const text = input.text
    if (previous?.promptContent)
      promptContentText(previous.promptContent, 'conversation-replay', currentTextLength)
    if (
      this.selections[session.id] !== definition.id &&
      !this.replacementFor(session.id, catalog!, options)
    )
      await this.bindSelection(session.id, definition.id)
    if (
      bound &&
      ['codex', 'claude'].includes(bound.harnessRef) &&
      (bound.externalAutoReview ?? false) !== (this.zcodeModeForOrigin(bound.origin) === 'build')
    )
      throw new LlmError(
        '官方审核模式已改变，请新建对话；原会话不会绕过审批。',
        'HARNESS_PERMISSION',
      )
    if (
      bound?.harnessRef === 'zcode' &&
      (bound.zcodeMode ?? 'yolo') !== this.zcodeModeForOrigin(bound.origin)
    )
      throw new LlmError(
        'ZCode 审批模式已改变，请新建对话；原会话不会绕过审批。',
        'HARNESS_PERMISSION',
      )
    if (bound && bound.sandbox !== binding.sandbox) {
      // A previous picker implementation persisted a zero-turn record before
      // the first prompt. It is safe to refresh that unused record; once a
      // prompt has been admitted, changing its permission remains forbidden.
      if (bound.turns.length !== 0)
        throw new LlmError(
          '官方会话权限与原外部任务不一致，请恢复原权限后继续；不会自动扩大权限。',
          'HARNESS_PERMISSION',
        )
      const active = this.active.get(bound.id)
      if (active?.turn)
        throw new LlmError(
          '官方会话权限与原外部任务不一致，请恢复原权限后继续；不会自动扩大权限。',
          'HARNESS_PERMISSION',
        )
      if (active) {
        await active.acp?.dispose()
        await active.bridgeStop?.()
        this.active.delete(bound.id)
      }
      bound.sandbox = binding.sandbox
      await this.save(bound)
    }
    const started = bound
      ? this.view(bound)
      : await this.runtimeMaintenance.admit(() =>
          this.startAdmitted(
            {
              combination: definition.id,
              cwd: binding.cwd,
              origin: { kind: 'dsh', sessionId: session.id },
              taskId: binding.taskId,
              sandbox: binding.sandbox,
            },
            true,
            true,
          ),
        )
    const record = this.records.get(started.id)!
    await this.finalizing.get(record.id)
    const official = this.ctx.get('oplOfficialCollaboration')
    if (
      !record.acpSessionId &&
      record.officialInstructions === undefined &&
      official &&
      ['codex', 'claude'].includes(record.harnessRef)
    ) {
      record.officialInstructions = await official.instructions(
        session.id,
        options.signal ?? new AbortController().signal,
      )
      await this.save(record)
    }
    await this.connect(record)
    // Managed turns retain their submitted setting. The native picker value is
    // not an external CLI capability and must not be copied into a new
    // external session (for example, Kimi may not advertise `high`).
    const requestEffort = admitted
      ? admitted.reasoningEffort
      : this.cliOwnsEffort(definition)
        ? (this.conversationEffort(session.id, definition, catalog!) ?? undefined)
        : ['codex', 'claude'].includes(definition.harnessRef) ||
            definition.modelRef.provider === MINIMAX_CODE_PROVIDER
          ? options.reasoningEffort
          : undefined
    if (input.content)
      assertPromptImages(
        input.content,
        this.active.get(record.id)?.editLaunch?.promptImageSupport,
        this.active.get(record.id)?.agentInfo,
        record.harnessRef,
      )
    this.conversationOwners.set(record.id, {
      sessionId: options.sessionId,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const cancel = () => {
      void this.cancel({ sessionId: record.id }, false)
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    let index = 0,
      offset = 0,
      opened = false
    try {
      options.signal?.throwIfAborted()
      if (admitted && this.active.get(record.id)?.turn === admitted) {
        void this.run(record, this.active.get(record.id)!, admitted)
      } else {
        await this.runtimeMaintenance.admit(() =>
          this.promptAdmitted(
            { sessionId: record.id, text, operationId },
            requestEffort,
            user.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n'),
            input.content,
          ),
        )
      }
      const conversationTurn = record.turns.find((item) => item.operationId === operationId)!
      const rpcId =
        user.source?.kind === 'user' && 'rpcId' in user.source ? user.source.rpcId : undefined
      const officialMessage =
        rpcId === undefined
          ? undefined
          : session
              .snapshotEvents()
              .find(
                (event) =>
                  event.type === 'user/message' &&
                  event.data.source.kind === 'user' &&
                  'rpcId' in event.data.source &&
                  event.data.source.rpcId === rpcId,
              )
      if (officialMessage) {
        conversationTurn.native = {
          ...conversationTurn.native,
          officialSeq: Number(officialMessage.seq),
        }
        await this.save(record)
      }
      while (true) {
        options.signal?.throwIfAborted()
        const turn = record.turns.find((item) => item.operationId === operationId)!
        const content =
          turn.content ?? (turn.text ? [{ type: 'text' as const, text: turn.text }] : [])
        while (index < content.length) {
          const block = content[index]!
          if (!opened) {
            yield { type: 'block-start', index, blockType: block.type }
            opened = true
          }
          if (block.text.length > offset) {
            yield {
              type: block.type === 'reasoning' ? 'reasoning-delta' : 'text-delta',
              index,
              text: block.text.slice(offset),
            }
            offset = block.text.length
          }
          if (index === content.length - 1) break
          yield { type: 'block-end', index, block: { ...block } }
          index += 1
          offset = 0
          opened = false
        }
        if (
          !['queued', 'running', 'waiting_child', 'waiting_approval', 'waiting_input'].includes(
            turn.state,
          )
        ) {
          await this.finalizing.get(record.id)
          if (turn.state !== 'completed')
            throw new LlmError(turn.error ?? 'Harness 执行已取消或中断', 'HARNESS_FAILED')
          if (opened) yield { type: 'block-end', index, block: { ...content[index]! } }
          if (turn.usage) yield { type: 'usage', usage: turn.usage }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        await new Promise<void>((resolve) => {
          const cleanup = () => {
            this.events.off(record.id, changed)
            options.signal?.removeEventListener('abort', changed)
            resolve()
          }
          const changed = () => cleanup()
          this.events.once(record.id, changed)
          options.signal?.addEventListener('abort', changed, { once: true })
          if (options.signal?.aborted) cleanup()
        })
      }
    } finally {
      options.signal?.removeEventListener('abort', cancel)
      this.conversationOwners.delete(record.id)
    }
  }
  async invoke(
    method: string,
    input: unknown,
    signal = new AbortController().signal,
  ): Promise<unknown> {
    const p = object(input)
    switch (method) {
      case 'cooperation-settings':
        return this.cooperationSettings()
      case 'save-cooperation-settings':
        return this.saveCooperationSettings(input)
      case 'tasks':
        return this.tasksFor(p.origin)
      case 'delegate':
        return this.delegateFrom(p.origin, p, signal)
      case 'review':
        return this.reviewTask(p.origin, p)
      case 'report':
        return this.submitReport(p.origin, p)
      case 'result':
        return this.resultFor(p.origin, p, signal)
      case 'retry-delivery':
        return this.retryDelivery(p.sessionId)
      case 'harness-installations':
        return this.installations()
      case 'harness-update':
        return this.updateHarness(required(p.id, 'Harness ID'))
      case 'select-combination':
        return this.selectCombination(p as { sessionId: string; combination: string })
      case 'model-selection':
        return this.modelSelection(p.sessionId)
      case 'reasoning-preflight':
        return this.reasoningPreflight({
          sessionId: required(p.sessionId, 'sessionId'),
          combination: required(p.combination, 'combination'),
        })
      case 'select-effort':
        return this.selectEffort({
          sessionId: required(p.sessionId, 'sessionId'),
          provider: required(p.provider, 'provider'),
          model: required(p.model, 'model'),
          ...(p.reasoningEffort ? { reasoningEffort: p.reasoningEffort } : {}),
        })
      case 'list':
        return this.list()
      case 'catalog':
        return this.executionCatalog()
      case 'save-catalog':
        return this.saveExecutionCatalog(p.catalog)
      case 'save-harness-proxy':
        return this.saveHarnessProxy(p.harnessId, p.proxy)
      case 'select-codex-runtime':
        return this.selectCodexRuntime(p as CodexRuntimeRequest)
      case 'select-minimax-candidate':
        return this.selectMiniMaxCandidate(p as MiniMaxCandidateRequest)
      case 'start':
        return this.start(p as HarnessStartRequest)
      case 'prompt':
        return this.prompt(p as HarnessPromptRequest)
      case 'snapshot':
        return this.snapshot({ sessionId: p.sessionId })
      case 'cancel':
        return this.cancel({ sessionId: p.sessionId })
      case 'wait':
        return this.wait(
          { sessionId: p.sessionId, ...(p.operationId ? { operationId: p.operationId } : {}) },
          signal,
        )
      case 'answer':
        return this.answer(p as { sessionId: string; approvalId: string; optionId?: string })
      default:
        throw Error('不支持的组合操作')
    }
  }
  async dispose() {
    this.disposed = true
    clearInterval(this.tick)
    await this.engineUpdates.dispose()
    await this.minimaxAccount.dispose()
    await this.runtimeMaintenance.close()
    await this.ready
    await Promise.allSettled(this.maintenanceJobs.values())
    await Promise.allSettled([...this.connecting.values()])
    await Promise.allSettled(this.finalizing.values())
    await Promise.all(
      [...this.active.entries()].map(async ([id, a]) => {
        await this.cancel({ sessionId: id }, false)
        // A turn may have cleared `turn` while its final persistence is still pending.
        await a.done
        await a.acp?.dispose()
        await a.bridgeStop?.()
      }),
    )
    await Promise.allSettled(this.reasoningPreflights.values())
    await this.writeQueue
    await this.externalEfforts.drain()
    await Promise.all(this.titleUpdates.values())
    // Cancellation can update a record after its last normal save completed.
    // Drain the dirty set after all active turns are settled so shutdown never
    // drops the final state; a transient write failure is retried once before
    // the caller receives the error and can recover from the retained record.
    for (let attempt = 0; this.dirtyRecords.size > 0 && attempt < 2; attempt += 1)
      await this.flushRecords()
    await this.sessionStore.dispose()
    await this.catalogStore.dispose()
    await this.messageEditStore.drain()
    await this.externalEditJournal.drain()
  }
}
export const createHarnessService = (
  ctx: Context,
  options: {
    readOfm?: () => Promise<unknown>
    minimaxCodeEnabled?: () => boolean
  } = {},
) => new HarnessService(ctx, options, new NativeHarnessConversations(ctx))
