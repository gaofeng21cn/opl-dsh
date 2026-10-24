import type {
  MiniMaxAccountStatus,
  MiniMaxAccountLoginRequest,
} from '../contracts/minimax-account.ts'
/** Typed UI boundary; lifecycle, authorization and sessions stay in the execution owner. */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { HarnessService } from './harness.ts'
import type { HarnessProxy } from '../contracts/catalog.ts'
import type { CodexRuntimeRequest, CodexRuntimeResult } from '../contracts/codex-runtime.ts'
import type { MiniMaxCandidateRequest, MiniMaxCandidateResult } from '../contracts/candidate.ts'
import type { MessageEditSend, MessageEditState } from '../contracts/message-edit.ts'
import type { SessionPromptValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  HarnessSessionsRequest,
  HarnessSessionsPage,
  HarnessDetailRequest,
  HarnessDetailPage,
  HarnessTaskSummary,
} from '../contracts/views.ts'
import type {
  ExecutionCatalog,
  HarnessCatalog,
  HarnessSnapshot,
  HarnessInstallation,
  HarnessSelection,
  HarnessStartRequest,
  HarnessPromptRequest,
  SessionRequest,
  StopEditRequest,
  StopEditResult,
  StopEditState,
  StopEditStateRequest,
  CooperationSettings,
  HarnessOrigin,
  HarnessReasoningPreflight,
  DelegateRequest,
  ReviewRequest,
  ReportRequest,
} from '../../contracts/types.ts'
import type { ExecutionLimits } from '../contracts/limits.ts'
declare module '@deepseek-ai/cordis' {
  interface Context {
    oplExecution: ExecutionService
  }
}
export class ExecutionService extends TypertRemoteService {
  @Remote('minimax-account-status')
  minimaxAccountStatus(request: MiniMaxAccountLoginRequest): Promise<MiniMaxAccountStatus> {
    return this.execution.minimaxAccountStatus(request)
  }
  @Remote('minimax-account-cancel')
  minimaxAccountCancel(request: MiniMaxAccountLoginRequest): Promise<MiniMaxAccountStatus> {
    return this.execution.minimaxAccountCancel(request)
  }
  @Remote('minimax-account-logout')
  minimaxAccountLogout(request: MiniMaxAccountLoginRequest): Promise<MiniMaxAccountStatus> {
    return this.execution.minimaxAccountLogout(request)
  }
  @Remote('minimax-account-login')
  minimaxAccountLogin(request: MiniMaxAccountLoginRequest): Promise<MiniMaxAccountStatus> {
    return this.execution.minimaxAccountLogin(request)
  }

  /** Reserve a regular Session identity with an explicit non-Workspace working directory. */
  @Remote('projectless-session')
  projectlessSession(): Promise<{ sessionId: string; cwd: string }> {
    return this.execution.createProjectlessSession()
  }
  /** Read same-conversation edit choices without changing history. */
  @Remote('message-edit-state')
  messageEditState(request: { sessionId: string }): Promise<MessageEditState> {
    return this.execution.messageEditState(request)
  }
  /** Replace selected history when the ordinary composer submits. */
  @Remote('message-edit-send')
  messageEditSend(request: MessageEditSend): Promise<SessionPromptValue> {
    return this.execution.messageEditSend(request)
  }
  constructor(
    ctx: Context,
    private readonly execution: HarnessService,
  ) {
    super(ctx, 'oplExecution')
  }
  @Remote('catalog')
  catalog(): Promise<ExecutionCatalog> {
    return this.execution.executionCatalog()
  }
  /** Import or select an immutable MiniMax candidate while all projects are idle. */
  @Remote('select-minimax-candidate')
  selectMiniMaxCandidate(request: MiniMaxCandidateRequest): Promise<MiniMaxCandidateResult> {
    return this.execution.selectMiniMaxCandidate(request)
  }
  /** Select or restore a verified Codex runtime without changing permissions. */
  @Remote('select-codex-runtime')
  selectCodexRuntime(request: CodexRuntimeRequest): Promise<CodexRuntimeResult> {
    return this.execution.selectCodexRuntime(request)
  }
  @Remote('save-catalog')
  saveCatalog(request: { catalog: ExecutionCatalog }): Promise<ExecutionCatalog> {
    return this.execution.saveExecutionCatalog(request.catalog)
  }
  /** Merge only the named Harness's proxy against the latest persisted catalog. */
  @Remote('save-harness-proxy')
  saveHarnessProxy(request: { harnessId: string; proxy: HarnessProxy }): Promise<ExecutionCatalog> {
    return this.execution.saveHarnessProxy(request.harnessId, request.proxy)
  }
  @Remote('list')
  list(): Promise<HarnessCatalog> {
    return this.execution.list()
  }
  @Remote('combinations')
  combinations(request: { includeDisabled?: boolean }): Promise<HarnessCatalog['combinations']> {
    return this.execution.combinations(request)
  }
  @Remote('queue-status')
  queueStatus(request: { sessionId: string }): Promise<{ queued: boolean }> {
    return this.execution.queueStatus(request.sessionId)
  }
  @Remote('execution-limits')
  executionLimits(): ExecutionLimits {
    return this.execution.executionLimits()
  }
  @Remote('save-execution-limits')
  saveExecutionLimits(request: ExecutionLimits): Promise<ExecutionLimits> {
    return this.execution.saveExecutionLimits(request)
  }
  @Remote('sessions')
  sessions(request: HarnessSessionsRequest): Promise<HarnessSessionsPage> {
    return this.execution.sessions(request)
  }
  @Remote('detail')
  detail(request: HarnessDetailRequest): Promise<HarnessDetailPage> {
    return this.execution.detail(request)
  }
  @Remote('harness-installations')
  installations(): Promise<HarnessInstallation[]> {
    return this.execution.installations()
  }
  @Remote('harness-update')
  async update(request: { id: string }): Promise<null> {
    await this.execution.updateHarness(request.id)
    return null
  }
  @Remote('start')
  start(request: HarnessStartRequest): Promise<HarnessSnapshot> {
    return this.execution.start(request)
  }
  @Remote('prompt')
  prompt(request: HarnessPromptRequest): Promise<HarnessSnapshot> {
    return this.execution.prompt(request)
  }
  @Remote('snapshot')
  snapshot(request: SessionRequest): Promise<HarnessSnapshot> {
    return this.execution.snapshot(request)
  }
  @Remote('wait')
  wait(
    request: { sessionId: string; operationId?: string },
    signal: AbortSignal,
  ): Promise<HarnessSnapshot> {
    return this.execution.wait(request, signal)
  }
  @Remote('delegate')
  delegate(request: DelegateRequest, signal: AbortSignal): Promise<HarnessSnapshot> {
    return this.execution.delegateFrom(request.origin, request, signal)
  }
  @Remote('report')
  report(request: ReportRequest): Promise<{ saved: boolean; operationId: string }> {
    return this.execution.submitReport(request.origin, request)
  }
  @Remote('review')
  review(request: ReviewRequest): Promise<HarnessSnapshot> {
    return this.execution.reviewTask(request.origin, request)
  }
  @Remote('result')
  result(
    request: { origin: HarnessOrigin; sessionId: string; operationId?: string; wait?: boolean },
    signal: AbortSignal,
  ): Promise<HarnessSnapshot> {
    return this.execution.resultFor(request.origin, request, signal)
  }
  @Remote('cancel-task')
  cancelTask(request: { origin: HarnessOrigin; sessionId: string }): Promise<HarnessSnapshot> {
    return this.execution.cancelTask(request.origin, request.sessionId)
  }
  @Remote('cancel')
  cancel(request: SessionRequest): Promise<HarnessSnapshot> {
    return this.execution.cancel(request)
  }
  @Remote('answer')
  answer(request: {
    sessionId: string
    approvalId: string
    optionId?: string
  }): Promise<HarnessSnapshot> {
    return this.execution.answer(request)
  }
  @Remote('model-selection')
  modelSelection(request: SessionRequest): Promise<HarnessSelection> {
    return this.execution.modelSelection(request.sessionId)
  }
  @Remote('reasoning-preflight')
  reasoningPreflight(request: {
    sessionId: string
    combination: string
  }): Promise<HarnessReasoningPreflight> {
    return this.execution.reasoningPreflight(request)
  }
  @Remote('select-combination')
  selectCombination(request: {
    sessionId: string
    combination: string
  }): Promise<{ kind: string; sessionId: string }> {
    return this.execution.selectCombination(request)
  }
  @Remote('select-effort')
  async selectEffort(request: {
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  }): Promise<null> {
    await this.execution.invoke('select-effort', request)
    return null
  }
  @Remote('cooperation-settings')
  cooperationSettings(): CooperationSettings {
    return this.execution.cooperationSettings()
  }
  @Remote('save-cooperation-settings')
  saveCooperationSettings(request: CooperationSettings): Promise<CooperationSettings> {
    return this.execution.saveCooperationSettings(request)
  }
  @Remote('tasks')
  tasks(request: { origin: HarnessOrigin }): Promise<HarnessSnapshot[]> {
    return this.execution.tasksFor(request.origin)
  }
  @Remote('task-summaries')
  taskSummaries(request: { origin: HarnessOrigin }): Promise<HarnessTaskSummary[]> {
    return this.execution.taskSummaries(request.origin)
  }
  @Remote('retry-delivery')
  retryDelivery(request: SessionRequest): Promise<HarnessSnapshot> {
    return this.execution.retryDelivery(request.sessionId)
  }
  /** 入口可见性与可选消息边界；不支持时 supported 为 false，客户端据此隐藏入口。 */
  @Remote('stop-edit-state')
  stopEditState(request: StopEditStateRequest): Promise<StopEditState> {
    return this.execution.stopEditState(request)
  }
  /** 回退到所选消息之前并交回原文；本方法不会自行发送，下一次请求由用户触发。 */
  @Remote('stop-edit')
  stopEdit(request: StopEditRequest): Promise<StopEditResult> {
    return this.execution.stopEdit(request)
  }
  /** 客户端确认已把原文放回输入框，恢复后不再重复填入。 */
  @Remote('stop-edit-acknowledge')
  acknowledgeStopEditDraft(request: {
    sessionId: string
    clientRequestId: string
  }): Promise<{ acknowledged: boolean }> {
    return this.execution.acknowledgeStopEditDraft(request)
  }
}
