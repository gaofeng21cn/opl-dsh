/**
 * 停止后编辑的公开契约：普通侧栏对话内选择一条已发送的用户消息，等真正静止后回退到
 * 该条消息之前，把原内容放回普通输入框，由用户再次发送才启动一次模型请求。
 *
 * 契约只描述事实，不描述 UI：Host 负责精确定位与回退，Client 只按 `StopEditState`
 * 决定是否显示入口，并按 `StopEditResult` 把文本填回官方 composer。
 * 磁盘上的文件永远不在本流程内，保持原样。
 */
export const STOP_EDIT_VERSION = 1

/**
 * 首批支持停止后编辑的 Harness。只有原生 DSH 与 MiniMax 出现在这里；
 * 其他 Harness 不出现在 `StopEditState.harness` 中，Client 也就没有入口可显示。
 */
export type StopEditHarness = 'dsh' | 'minimax-code'

/**
 * 首批支持停止后编辑的 Harness 名单。
 *
 * 名单只有一个来源：Host 用它区分“这个 Harness 根本不在范围内”（客户端完全不渲染）
 * 和“在范围内但此刻还不具备能力”（必须给出可读解释，而不是无解释消失）。
 */
export const STOP_EDIT_HARNESSES: readonly StopEditHarness[] = ['dsh', 'minimax-code']

/** 一个 Harness ref 是否属于首批范围。不认识的 ref 一律返回 false，绝不乐观放行。 */
export function isStopEditHarness(ref: string | undefined): ref is StopEditHarness {
  return ref !== undefined && (STOP_EDIT_HARNESSES as readonly string[]).includes(ref)
}

/** 一条可回退的用户消息边界。`id` 只在当前会话历史版本内有效，Host 从不按文本回匹配。 */
export interface StopEditBoundary {
  /** 会话内不透明边界身份；只交给 Host 定位精确日志位置。 */
  id: string
  /** 原消息开头的短文本，仅供列表展示；Host 不据此回匹配。 */
  contentHead: string
  /** 原消息携带的附件数量。 */
  attachmentCount: number
  /** True 表示这是本会话第一条用户消息，回退后进入空分支。 */
  first: boolean
  /** Harness 提供的历史版本标识；用于拒绝已经过期的选择。 */
  historyVersion?: string
  /** 拥有这条消息的 OPL operation 身份；缺失表示旧会话没有精确映射。 */
  operationId?: string
  /** True 表示这条边界存在但没有精确映射，必须拒绝而不是猜配。 */
  blocked?: boolean
  /** `blocked` 的原因，直接展示给用户。 */
  blockedReason?: string
}

/** 普通侧栏会话是否支持停止后编辑，以及可选的边界列表。 */
export interface StopEditState {
  /** 客户端请求时的会话 id 原样回显。 */
  sessionId: string
  /**
   * 这个会话所属的首批 Harness。
   *
   * 只有 Host 判定“本次真的落入首批范围”时才设置：会话本身不可编辑、或落在范围外的
   * Harness 一律不设置。客户端据此区分两种 `supported: false`——不认识的 Harness 完全
   * 不渲染，认识但此刻不可用的必须给出 `reason`，而不是无解释消失。
   */
  harness?: StopEditHarness
  /**
   * 此刻能力可用，客户端可以列出边界。
   *
   * False 只表示“现在不能回退”，不表示“永远没有入口”：首批 Harness 的能力未就绪或会话
   * 被结果不确定的编辑阻断时同样为 false，此时客户端必须展示 `reason` 并提供恢复读取。
   */
  supported: boolean
  /**
   * 不可用原因；`supported` 为 true 时不设置。
   *
   * 只在 `harness` 有值时展示：它来自 Host 的真实判定（能力公告、阻断台账、历史读取），
   * 客户端不自行推断，也不把它细化成 Host 没有报告过的进度。
   */
  reason?: string
  /** 正在运行：必须先停止并等真正静止，不能在运行中回退。 */
  busy: boolean
  /**
   * 这个会话上仍有一次编辑请求没有落定：正在处理中，或结果不确定而阻断。
   *
   * 两种情况的共同点是“现在不能再发起一次回退”。客户端据此提供只读的重新读取入口，
   * 让用户可以核对真实历史，而不是凭本地状态再点一次。
   */
  pending: boolean
  boundaries: StopEditBoundary[]
  /**
   * 上一次回退留下的原文，等客户端放回普通输入框。
   * 分支会话不会自动出现在用户眼前，这条持久事实让恢复或换会话后仍能取回原文。
   */
  pendingDraft?: { text: string; clientRequestId: string }
  /** 已提交回退的分支入口；原会话重载后仍可打开尚无消息的分支。 */
  editBranch?: { sessionId: string; title: string }
  /** 恒为 false：本流程从不撤销或恢复磁盘文件。 */
  filesRestored: false
  version: number
}

/** 回退后无法放回输入框的内容，必须显式告知，不静默丢弃。 */
export interface StopEditUnrestored {
  name?: string
  reason: string
}

/** 回退后必须显式复核的项目；旧值不会被静默沿用。 */
export interface StopEditReview {
  model: string
  effort?: string
  /** 官方内置权限状态。 */
  permissions: string
  cwd: string
  workspaceId: string
  /** 工作区解析出的项目目录。 */
  project?: string
  feedback: {
    /** 仍属于本会话的委派任务。 */
    taskId?: string
    /** 仍待回传的记录数量；被回退的轮次不会留下回传记录。 */
    pendingDeliveries: number
    /** 下一次发送必须使用的 operation 身份。 */
    operationId: string
  }
}

/** 一次成功回退的结果。失败一律抛出，不返回半个成功。 */
export interface StopEditResult {
  clientRequestId: string
  /** 回退后记录所指向的会话；原生 DSH 是新分支，MiniMax 是原会话。 */
  sessionId: string
  /** 回退前保留的会话身份，用户随时可以回去查看原记录。 */
  preservedSessionId: string
  /** 新分支的人类可读标题；会话列表里按它查找，不用 opaque id。 */
  branchTitle: string
  /** True 表示对话已经移到另一个会话，原会话仍然保留可浏览。 */
  moved: boolean
  /** 实际回退到的边界，原样回显供复核。 */
  boundary: StopEditBoundary
  /** 放回普通输入框的文本。 */
  draft: string
  /** 无法恢复的附件等，必须由用户自己重新处理。 */
  unrestored: StopEditUnrestored[]
  /** 被移除的投影尾部轮次数。 */
  removedTurns: number
  review: StopEditReview
  version: number
}

/** 客户端发起的回退请求。`clientRequestId` 是幂等身份，重复点击必须复用同一个值。 */
export interface StopEditRequest {
  /** 稳定幂等身份；同一个值重复提交只会回退一次。 */
  clientRequestId: string
  /** 普通侧栏对话的官方会话 id。 */
  sessionId: string
  /** 用户选择的边界 id。 */
  boundaryId: string
}

/** 客户端读取入口状态。 */
export interface StopEditStateRequest {
  sessionId: string
}

/** 一次编辑请求的持久阶段；跨进程恢复时靠它区分“未动”“已完成”“不确定”。 */
export type StopEditPhase = 'planned' | 'rewinding' | 'committed' | 'uncertain'

/**
 * 持久化的编辑意图。
 *
 * 候选 Runtime 的 operation 台账是进程内状态，不能跨进程去重；这份台账是 OPL 自己的事实，
 * 用来在重启后决定是幂等返回、先核对历史，还是阻断续发。
 */
export interface StopEditIntent {
  /** 客户端寻址的侧栏会话。 */
  sessionId: string
  clientRequestId: string
  boundaryId: string
  /** 回退前的会话身份，原记录保持可浏览。 */
  preservedSessionId: string
  /** 变更之后记录应指向的会话；只有 committed 之后才有意义。 */
  rewoundSessionId?: string
  /** 下一次发送必须使用的 operation 身份。 */
  pendingOperationId: string
  /** 回退后的原文，等客户端放回普通输入框后清除。 */
  pendingDraft: string
  phase: StopEditPhase
  /** uncertain 时的稳定原因；面向用户，不含 Runtime 原始信息。 */
  reason?: string
  /** 已完成时保存的返回值，供重复点击幂等返回。 */
  result?: StopEditResult
  at: string
  updatedAt: string
}

/** 明确拒绝的原因。客户端据此展示，绝不假装成功。 */
export type StopEditRejection =
  /** 该 Harness 不在首批范围内。 */
  | 'unsupported-harness'
  /** 运行时没有安装对应的会话历史扩展。 */
  | 'capability-missing'
  /** 会话不存在或不是普通侧栏对话。 */
  | 'not-bound'
  /** 选择的边界在当前历史中已经不存在。 */
  | 'stale-history'
  /** 上一次编辑请求仍在处理中。 */
  | 'in-flight'
  /** 停止被受理但会话没有在限定时间内真正静止。 */
  | 'busy-timeout'
  /** 旧会话缺少精确映射，拒绝按文本、时间或顺序猜配。 */
  | 'missing-mapping'
  /** 回退本身失败；变更可能已经发生，必须先核对历史。 */
  | 'rewind-failed'
  /** 同一个请求身份被用于两条不同的消息。 */
  | 'request-conflict'
  /** 上一次编辑结果不确定，必须先核对真实历史。 */
  | 'uncertain'
  /** 这条消息带着无法通过公开接口还原的附件，在改动会话之前就被拒绝。 */
  | 'attachments-unrestorable'

/** 拒绝时携带的稳定载荷。 */
export interface StopEditRejectionPayload {
  reason: StopEditRejection
  /** 直接展示给用户的中文说明。 */
  message: string
}
