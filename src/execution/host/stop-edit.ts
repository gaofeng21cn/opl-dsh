/**
 * 停止后编辑的核心服务：目标解析、精确边界、真正静止、幂等与不确定状态。
 *
 * 这里不认识官方会话控制器、Harness 进程或 UI，只依赖注入的接入面，因此可以按边界逐条
 * 验证。核心不猜测：边界只来自运行时回报或官方会话日志，缺精确映射一律拒绝；顺序只
 * 来自官方日志 seq 或 Runtime 实际删除的标识。
 */
import type { HarnessSession, HarnessTurn } from '../contracts/sessions.ts'
import {
  isStopEditHarness,
  STOP_EDIT_VERSION,
  type StopEditBoundary,
  type StopEditHarness,
  type StopEditIntent,
  type StopEditRejection,
  type StopEditRequest,
  type StopEditResult,
  type StopEditState,
  type StopEditStateRequest,
  type StopEditUnrestored,
} from '../contracts/stop-edit.ts'

/** 带稳定拒绝原因的失败。失败一律抛出，不返回半个成功。 */
export class StopEditError extends Error {
  constructor(
    readonly reason: StopEditRejection,
    message: string,
  ) {
    super(message)
    this.name = 'StopEditError'
  }
}

/**
 * 轮次相对所选边界的位置。
 *
 * `unknown` 表示没有精确映射。这不是“可能是前也可能是后”，而是拒绝的依据：只要尾部
 * 之前还有一个说不清位置的轮次，就不能证明截断是完整的。
 */
export type StopEditTail = 'before' | 'after' | 'unknown'

/** 一次真实回退的执行结果，由各 Harness 运行时提供。 */
export interface StopEditRewindOutcome {
  /** 回退后记录应指向的会话；原生 DSH 是新分支，MiniMax 是原会话。 */
  sessionId: string
  /** 回退前的会话身份，原记录保持可浏览。 */
  preservedSessionId: string
  classify: (turn: HarnessTurn) => StopEditTail
  /** 放回普通输入框的文本；必须是原文，不是摘要。 */
  draft: string
  /** 无法放回输入框的内容。会被拒绝的情况不会走到这里。 */
  unrestored: StopEditUnrestored[]
  /** 回退后必须显式复核的项目。 */
  review: StopEditReviewFacts
}

export interface StopEditReviewFacts {
  model: string
  effort?: string
  permissions: string
  cwd: string
  workspaceId: string
  project?: string
  /** 新分支的人类可读标题；会话列表里按它查找。 */
  title: string
}

/** 变更之前完成的只读校验；任何拒绝都发生在会话被改动之前。 */
export interface StopEditPlan {
  /** 必须放回输入框的原文。 */
  draft: string
  /** 变更前就已知无法恢复的内容（当前所有路径都在此拒绝）。 */
  unrestored: StopEditUnrestored[]
}

/** 一次编辑请求交给运行时的全部事实。 */
export interface StopEditRewindRequest {
  /** 委派记录；普通原生 DSH 对话没有记录时为 undefined。 */
  record: HarnessSession | undefined
  sessionId: string
  boundary: StopEditBoundary
  clientRequestId: string
  /** 为下一次发送预留的 operation 身份；被回退轮次的旧身份不再复用。 */
  operationId: string
}

/** 各 Harness 提供的真实回退能力。 */
export interface StopEditRuntime {
  readonly harness: StopEditHarness
  /** 实时能力判定；不支持时必须给出原因，绝不假装可用。 */
  capability(): { ready: boolean; reason?: string }
  /** 读取当前会话的可回退边界；没有委派记录时按普通官方会话处理。 */
  boundaries(record: HarnessSession | undefined, sessionId: string): Promise<StopEditBoundary[]>
  /** 只读校验：确认这次编辑可以安全执行，且已经拿到原文。 */
  plan(request: StopEditRewindRequest): Promise<StopEditPlan>
  /** 执行真正回退；发出之后若失败，一律视为结果不确定。 */
  rewind(request: StopEditRewindRequest): Promise<StopEditRewindOutcome>
}

/**
 * 一个可编辑的侧栏会话。
 *
 * `record` 可以缺席：普通原生 DSH 对话没有委派记录也必须能编辑，此时不裁剪任何投影。
 */
export interface StopEditTarget {
  sessionId: string
  harness: StopEditHarness
  record?: HarnessSession
}

/** 宿主需要为核心服务提供的持久与运行时事实。 */
export interface StopEditHost {
  resolve(sessionId: string): StopEditTarget | undefined
  /** 记录当前正在寻址的官方会话；回退后它会变化。 */
  addressedSession(target: StopEditTarget): string
  runtime(target: StopEditTarget): StopEditRuntime | undefined
  /** 是否仍有轮次在运行。 */
  busy(target: StopEditTarget): boolean
  /** 受理停止并等待真正静止。 */
  stopAndWait(target: StopEditTarget): Promise<void>
  /** 为下一次发送预留 operation 身份。 */
  nextOperationId(target: StopEditTarget): string
  /** 该会话上一次编辑意图；没有则 undefined。 */
  intent(sessionId: string): StopEditIntent | undefined
  /** 在任何变更之前落盘编辑意图。 */
  plan(input: {
    target: StopEditTarget
    clientRequestId: string
    boundaryId: string
    pendingOperationId: string
    pendingDraft: string
    preservedSessionId: string
  }): Promise<void>
  /** 已经发起变更、结果未知；必须在真正改动之前调用。 */
  markRewinding(sessionId: string): Promise<void>
  /** 变更确实完成；提交负责把待填草稿落到新的目标会话上。 */
  commit(input: {
    target: StopEditTarget
    boundary: StopEditBoundary
    clientRequestId: string
    operationId: string
    keep: number
    outcome: StopEditRewindOutcome
  }): Promise<StopEditResult>
  /**
   * 该会话是否被一次结果不确定的编辑卡住。
   *
   * 普通发模型入口必须据此拒绝：上下文是否已经回退无法确定时继续发送，只会把编辑
   * 之前的任务当成最新状态执行。
   */
  blocked(sessionId: string): string | undefined
  /** 结果不确定：保留证据并阻断错误上下文续发。 */
  markUncertain(sessionId: string, reason: string): Promise<void>
  /** 客户端已把原文放回输入框，清除待填草稿但保留已完成状态。 */
  acknowledgeDraft(sessionId: string, clientRequestId: string): Promise<void>
}

/**
 * 计算投影尾部应保留的轮次数量。
 *
 * 只有当尾部之前不存在位置不明的轮次时才截断；否则宁可一条不动并让调用方拒绝，也不
 * 裁掉一段说不清归属的历史。
 */
export function planProjectionCut(
  turns: readonly HarnessTurn[],
  classify: (turn: HarnessTurn) => StopEditTail,
): number | undefined {
  let keep = turns.length
  let firstAfter = -1
  for (const [index, turn] of turns.entries()) {
    const tail = classify(turn)
    if (tail === 'after') {
      firstAfter = index
      break
    }
  }
  if (firstAfter === -1) return keep
  for (let index = 0; index < firstAfter; index += 1) {
    if (classify(turns[index]!) === 'unknown') return undefined
  }
  keep = firstAfter
  // 边界之后位置不明的轮次同样无法证明属于尾部之外，因此一并保留、整体拒绝。
  for (let index = firstAfter; index < turns.length; index += 1) {
    if (classify(turns[index]!) === 'unknown') return undefined
  }
  return keep
}

/** 只展示用的原消息开头。保留换行语义，限长且不吞掉空白内容。 */
export function contentHead(text: string, limit = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * 把无法回填的附件边界在展示阶段就标成禁用。
 *
 * 官方没有公开的附件回填接口，运行时在 `plan` 阶段同样会以 `attachments-unrestorable`
 * 拒绝。这里只是把已经成立的事实提前写进边界，让用户在点击之前就看到禁用原因，而不是
 * 点完才被拒绝；不带附件、或运行时已经给出阻断原因的边界原样返回。
 */
function blockUnrestorableAttachments(boundaries: readonly StopEditBoundary[]): StopEditBoundary[] {
  return boundaries.map((boundary) =>
    boundary.attachmentCount > 0 && boundary.blocked !== true
      ? { ...boundary, blocked: true, blockedReason: '这条消息带有无法回填的附件，不能编辑' }
      : boundary,
  )
}

export class StopEditService {
  /**
   * 每个侧栏会话至多一个在途编辑请求；重复点击必须被拒绝而不是排队重复回退。
   *
   * 两张表都按客户端寻址的会话 id 建键，而不是按记录：一次回退会把记录切到新会话，
   * 若按记录建键，同一个请求的第二次到达就会先撞上“会话已改变”而不是拿回第一次的结果。
   */
  private readonly running = new Map<string, string>()
  private readonly committed = new Map<
    string,
    { clientRequestId: string; result: StopEditResult }
  >()

  constructor(private readonly host: StopEditHost) {}

  /** 记录当前正在寻址的官方会话；回退成功后它会变化。 */
  addressedSession(target: StopEditTarget): string {
    return this.host.addressedSession(target)
  }

  /** 正在编辑的会话，供普通 prompt 入口共享同一把互斥锁。 */
  editing(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  /** 入口可见性与可选边界。不支持时客户端据此隐藏入口。 */
  async state(request: StopEditStateRequest): Promise<StopEditState> {
    const intent = this.host.intent(request.sessionId)
    const editBranch =
      intent?.phase === 'committed' &&
      intent.result?.moved &&
      intent.result.preservedSessionId === request.sessionId
        ? { sessionId: intent.result.sessionId, title: intent.result.branchTitle }
        : undefined
    const branch = editBranch ? { editBranch } : {}
    const denied = (reason: string, extra: Partial<StopEditState> = {}): StopEditState => ({
      sessionId: request.sessionId,
      supported: false,
      reason,
      busy: false,
      pending: false,
      boundaries: [],
      filesRestored: false,
      version: STOP_EDIT_VERSION,
      ...branch,
      ...extra,
    })
    const target = this.host.resolve(request.sessionId)
    if (target === undefined) return denied('该会话不是可编辑的侧栏对话')
    /**
     * 本次是否真的落入首批范围。
     *
     * 只有这里返回的 Harness 才会出现在 `StopEditState.harness` 中。范围外的 Harness 仍然
     * 一个字段都不设置，客户端因此完全不渲染——「不在范围内」与「在范围内但此刻不可用」
     * 是两件事，不能共用一句“尚未提供”糊过去。
     */
    const harness: StopEditHarness | undefined = target.record
      ? isStopEditHarness(target.record.harnessRef)
        ? target.record.harnessRef
        : undefined
      : target.harness
    const scope = harness === undefined ? {} : { harness }
    // 结果不确定或改动进行中时不允许继续编辑：真实历史必须先核对。
    const blocked = this.host.blocked(request.sessionId)
    if (blocked !== undefined) return denied(blocked, { ...scope, pending: true })
    const runtime = this.host.runtime(target)
    // 没有运行时：范围外的 Harness 不渲染；范围内的 Harness 只是还没就绪，必须说清楚。
    if (runtime === undefined)
      return harness === undefined
        ? denied('该 Harness 尚未提供停止后编辑')
        : denied('会话所属 Harness 尚未就绪，暂时不能读取会话历史', scope)
    const capability = runtime.capability()
    if (!capability.ready)
      return denied(capability.reason ?? '会话历史扩展未安装，已拒绝假装可用', scope)
    if (this.host.addressedSession(target) !== request.sessionId)
      return denied('会话已改变，请重新打开', scope)
    let boundaries: StopEditBoundary[]
    try {
      boundaries = blockUnrestorableAttachments(
        await runtime.boundaries(target.record, request.sessionId),
      )
    } catch {
      // 原始异常可能带路径或凭据，绝不反射到界面。
      return denied('无法读取会话历史，请稍后重试', scope)
    }
    const pendingDraft =
      intent?.phase === 'committed' && intent.pendingDraft
        ? { text: intent.pendingDraft, clientRequestId: intent.clientRequestId }
        : undefined
    return {
      sessionId: request.sessionId,
      harness: runtime.harness,
      supported: true,
      busy: this.host.busy(target),
      pending: this.running.has(request.sessionId),
      boundaries,
      ...branch,
      ...(pendingDraft === undefined ? {} : { pendingDraft }),
      filesRestored: false,
      version: STOP_EDIT_VERSION,
    }
  }

  /** 回退成功后确认草稿已放回输入框，避免恢复后重复填入同一条。 */
  async acknowledge(request: { sessionId: string; clientRequestId: string }): Promise<boolean> {
    const intent = this.host.intent(request.sessionId)
    if (intent?.phase !== 'committed' || intent.clientRequestId !== request.clientRequestId)
      return false
    await this.host.acknowledgeDraft(request.sessionId, request.clientRequestId)
    return true
  }

  /**
   * 回退到所选消息之前，并把原文本交给客户端放回普通输入框。
   *
   * 顺序是刻意的：请求身份 → 不确定状态 → 目标解析 → 能力 → 新鲜度 → 互斥 → 真正静止 →
   * 重新定位精确边界 → 只读校验 → 落盘意图 → 真实回退 → 提交。任何一步失败都不会返回
   * 成功；变更之后失败一律落到不确定状态，而不是谎称会话没被改过。
   */
  async rewind(request: StopEditRequest): Promise<StopEditResult> {
    const clientRequestId = request.clientRequestId.trim()
    const boundaryId = request.boundaryId.trim()
    if (!clientRequestId || !boundaryId)
      throw new StopEditError('stale-history', '停止后编辑请求缺少身份或边界')
    // 同一个请求身份换一条边界意味着两个不同的意图，必须拒绝而不是猜用户想改哪条。
    const prior = this.host.intent(request.sessionId)
    if (prior?.clientRequestId === clientRequestId && prior.boundaryId !== boundaryId)
      throw new StopEditError('request-conflict', '同一个编辑请求不能对应两条不同的消息')
    // 不确定与“正在改”都算阻断：两者都无法证明上下文仍是编辑前的状态。
    const blocked = this.host.blocked(request.sessionId)
    if (blocked !== undefined) throw new StopEditError('uncertain', blocked)
    const replay = this.committed.get(request.sessionId)
    if (replay?.clientRequestId === clientRequestId) return replay.result
    // 回复丢失或进程重启之后，同一身份必须拿回落盘的结果，而不是把这次编辑重新回退一遍。
    if (prior?.phase === 'committed' && prior.clientRequestId === clientRequestId && prior.result)
      return prior.result
    const target = this.host.resolve(request.sessionId)
    if (target === undefined) throw new StopEditError('not-bound', '该会话不是可编辑的侧栏对话')
    // 会话在用户挑选期间被换掉时，旧选择必须作废。
    const sessionId = this.host.addressedSession(target)
    if (sessionId !== request.sessionId)
      throw new StopEditError('stale-history', '会话已改变，请重新选择要编辑的消息')
    const runtime = this.host.runtime(target)
    if (runtime === undefined)
      throw new StopEditError('unsupported-harness', '该 Harness 尚未提供停止后编辑')
    const capability = runtime.capability()
    if (!capability.ready)
      throw new StopEditError('capability-missing', capability.reason ?? '会话历史扩展未安装')
    const inflight = this.running.get(request.sessionId)
    if (inflight !== undefined)
      throw new StopEditError(
        'in-flight',
        inflight === clientRequestId ? '这次停止后编辑正在处理中' : '上一次停止后编辑仍在处理中',
      )
    this.running.set(request.sessionId, clientRequestId)
    try {
      if (this.host.busy(target)) {
        await this.host.stopAndWait(target)
        if (this.host.busy(target))
          throw new StopEditError('busy-timeout', '会话尚未真正静止，请稍后重试')
      }
      // 停止被受理后日志可能又追加了事件，因此必须在静止之后重新定位精确边界。
      let boundaries: StopEditBoundary[]
      try {
        boundaries = await runtime.boundaries(target.record, sessionId)
      } catch (error) {
        // 运行时的稳定原因原样上抛；其余一律换成固定诊断，不反射底层异常文本。
        if (error instanceof StopEditError) throw error
        throw new StopEditError('stale-history', '无法读取会话历史，请稍后重试')
      }
      const boundary = boundaries.find((item) => item.id === boundaryId)
      if (boundary === undefined)
        throw new StopEditError('stale-history', '要编辑的消息已不在当前历史中，请重新选择')
      if (boundary.blocked)
        throw new StopEditError(
          'missing-mapping',
          boundary.blockedReason ?? '这条消息缺少精确映射，已拒绝按相似内容回退',
        )
      const operationId = this.host.nextOperationId(target)
      const rewindRequest: StopEditRewindRequest = {
        record: target.record,
        sessionId,
        boundary,
        clientRequestId,
        operationId,
      }
      // 只读校验先跑完：附件、投影锚点或原文缺一不可，绝不在变更之后才告诉用户。
      const planned = await runtime.plan(rewindRequest)
      if (!planned.draft)
        throw new StopEditError('missing-mapping', '这条消息没有可还原的原文，已放弃回退')
      await this.host.plan({
        target,
        clientRequestId,
        boundaryId,
        pendingOperationId: operationId,
        pendingDraft: planned.draft,
        preservedSessionId: sessionId,
      })
      // 先落“正在改”：只有先写下它，进程被杀之后才知道这次不能当作没发生过。
      await this.host.markRewinding(sessionId)
      let outcome: StopEditRewindOutcome
      try {
        outcome = await runtime.rewind(rewindRequest)
      } catch {
        // 已经可能改动了 Runtime 或官方会话：保留证据，不谎称“会话没被改动”。
        await this.host.markUncertain(sessionId, 'Runtime 回退结果不确定，请先核对会话历史')
        throw new StopEditError('rewind-failed', '回退结果不确定，请先核对会话历史后再试')
      }
      // 没有委派记录就没有投影可裁剪；有记录时必须能确定切口才敢动历史。
      let result: StopEditResult
      try {
        let keep = 0
        if (target.record !== undefined) {
          const cut = planProjectionCut(target.record.turns, outcome.classify)
          if (cut === undefined)
            throw new StopEditError('missing-mapping', '部分轮次缺少精确映射，无法提交回退结果')
          keep = cut
        }
        result = await this.host.commit({
          target,
          boundary,
          clientRequestId,
          operationId,
          keep,
          outcome,
        })
      } catch {
        // Runtime 已经改成功，投影或落盘失败同样是不确定：不能让会话带着半个状态续发。
        await this.host.markUncertain(sessionId, '投影或结果落盘失败，请先核对会话历史')
        throw new StopEditError('rewind-failed', '回退已发生但未能完成记录，请先核对会话历史')
      }
      this.committed.set(sessionId, { clientRequestId, result })
      return result
    } finally {
      this.running.delete(request.sessionId)
    }
  }
}
