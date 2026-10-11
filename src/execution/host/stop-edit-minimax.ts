/**
 * MiniMax 的停止后编辑：真正调用 Runtime 的 `rewindSession`，并同步持久投影。
 *
 * 这些方法属于计划新增的 ACP v1 扩展，官方 0.6.3 Runtime 目前并不支持。初始化结果里
 * 必须由 Runtime 自己公告 `_meta['opl/session-history']`；没有这份明确公告时，能力一律
 * 判为不可用并给出原因，绝不按相似文本、时间或顺序猜配出一个假的可用状态。
 *
 * 协议形状以 `scripts/mcode-candidate/patches/mcode-opl-session-history.patch` 为准：
 * list 返回 `{version, sessionId, entries:[{userMessageId, contentHead?, timestamp,
 * fileChangeCount, assistantMessageId?}]}`，没有完整原文、没有 turnId 承诺；rewind 返回
 * `{version, rewound:true, sessionId, userMessageId, clientRequestId, deletedMessageIds,
 * displayRevision?, historyRevision?}`。原文一律取自精确映射命中的 `HarnessTurn.prompt`。
 */
import type { HarnessSession, HarnessTurn } from '../contracts/sessions.ts'
import type { StopEditBoundary } from '../contracts/stop-edit.ts'
import {
  StopEditError,
  contentHead,
  type StopEditPlan,
  type StopEditRuntime,
  type StopEditTail,
} from './stop-edit.ts'
import { nativeProjectionAnchor, type NativeSessionSource } from './stop-edit-native.ts'
import { turnRequestIds } from './stop-edit-native.ts'

/** 计划新增的扩展方法与通知名。候选只提供这两个方法，没有 promote。 */
export const HISTORY_LIST = 'opl/session/history/list'
export const HISTORY_REWIND = 'opl/session/history/rewind'
export const HISTORY_BOUNDARY = 'opl/session/history/boundary'
export const HISTORY_META = 'opl/session-history'

export interface MinimaxHistoryCapability {
  ready: boolean
  reason?: string
}

/**
 * 只承认 Runtime 自己公告的完整能力集合。
 *
 * 任何一项缺失、版本不符或形状不认识，都判为不可用：漏报能力比误报能力安全得多。
 */
export function readMinimaxCapability(initializeResult: unknown): MinimaxHistoryCapability {
  const meta = initializeResult as Record<string, any> | undefined
  const announced = meta?._meta?.[HISTORY_META]
  if (announced === undefined || announced === null)
    return { ready: false, reason: '当前 MiniMax Runtime 未安装会话历史扩展，已拒绝开放停止后编辑' }
  if (announced.version !== 1)
    return { ready: false, reason: 'MiniMax 会话历史扩展版本不受支持，已拒绝开放停止后编辑' }
  const methods = Array.isArray(announced.methods) ? announced.methods : []
  const notifications = Array.isArray(announced.notifications) ? announced.notifications : []
  for (const method of [HISTORY_LIST, HISTORY_REWIND])
    if (!methods.includes(method))
      return { ready: false, reason: `MiniMax Runtime 未公告 ${method}，已拒绝开放停止后编辑` }
  if (!notifications.includes(HISTORY_BOUNDARY))
    return {
      ready: false,
      reason: 'MiniMax Runtime 未公告会话边界通知，无法建立精确映射，已拒绝开放停止后编辑',
    }
  return { ready: true }
}

/** 候选 list 响应里的一条记录；只承认候选真的给出的字段。 */
interface MinimaxEntry {
  userMessageId: string
  contentHead?: string
  fileChangeCount?: number
}

/** 从候选 list 响应里取出记录；形状不认识就当作没有记录，绝不构造假边界。 */
export function readMinimaxEntries(value: unknown): MinimaxEntry[] {
  const body = value as { version?: unknown; entries?: unknown } | null | undefined
  if (!body || body.version !== 1 || !Array.isArray(body.entries)) return []
  return body.entries.filter(
    (item): item is MinimaxEntry =>
      Boolean(item) &&
      typeof (item as MinimaxEntry).userMessageId === 'string' &&
      (item as MinimaxEntry).userMessageId.length > 0,
  )
}

/** 一个 OPL 记录内，operation 与原生用户消息的精确映射；缺失就是缺失，不做推断。 */
export function operationByUserMessage(record: HarnessSession): Map<string, HarnessTurn> {
  const mapping = new Map<string, HarnessTurn>()
  for (const turn of record.turns) {
    const userMessageId = turn.native?.userMessageId
    if (userMessageId) mapping.set(userMessageId, turn)
  }
  return mapping
}

export interface MinimaxReview {
  model: string
  effort?: string
  permissions: string
  cwd: string
  workspaceId: string
  project?: string
  title: string
}

/** 与 Runtime 会话历史对话所需的最小接入面。 */
export interface MinimaxHistorySource {
  /** 运行时自己公告的能力；未安装扩展时必须返回 ready:false。 */
  capability(): MinimaxHistoryCapability
  /** `opl/session/history/list` */
  list(sessionId: string): Promise<unknown>
  /** `opl/session/history/rewind`，必须以 `rewindTurnDiff: false` 调用。 */
  rewind(sessionId: string, userMessageId: string, clientRequestId: string): Promise<unknown>
  /** 从 rewind 结果里取出 Runtime 真实删除的消息身份。 */
  deletedMessageIds(value: unknown): string[]
  /** 回退后必须显式复核的会话事实。 */
  review(sessionId: string): MinimaxReview
}

/** MiniMax 运行时。能力不来自本套件自己的判断，而来自 Runtime 的公告。 */
export function minimaxStopEditRuntime(
  source: MinimaxHistorySource,
  /** 官方投影会话的接入面；缺失时只回退 Runtime，官方会话仍保留旧尾部。 */
  projection?: NativeSessionSource,
): StopEditRuntime {
  /** 解析一次待编辑的目标：精确映射命中的轮次才带原文，摘要永远不进草稿。 */
  const resolve = async (record: HarnessSession | undefined, boundaryId: string) => {
    if (record === undefined)
      throw new StopEditError('not-bound', '该会话没有组合记录，无法建立精确映射')
    const entries = readMinimaxEntries(await source.list(record.acpSessionId))
    const entry = entries.find((item) => item.userMessageId === boundaryId)
    if (entry === undefined)
      throw new StopEditError('stale-history', '要编辑的消息已不在当前历史中，请重新选择')
    const turn = operationByUserMessage(record).get(entry.userMessageId)
    if (turn === undefined)
      throw new StopEditError(
        'missing-mapping',
        '这条消息没有对应的 operation 精确映射，已拒绝按相似内容回退',
      )
    return { record, entries, entry, turn }
  }
  return {
    harness: 'minimax-code',
    capability: () => source.capability(),
    boundaries: async (record) => {
      if (record === undefined) return []
      const entries = readMinimaxEntries(await source.list(record.acpSessionId))
      const operations = operationByUserMessage(record)
      return entries.map((item): StopEditBoundary => {
        const turn = operations.get(item.userMessageId)
        const anchor =
          turn?.native?.officialSeq !== undefined && record.nativeSessionId && projection
            ? nativeProjectionAnchor(
                projection,
                record.nativeSessionId,
                [],
                turn.native.officialSeq,
              )
            : undefined
        return {
          id: item.userMessageId,
          contentHead: anchor ? contentHead(anchor.text) : (item.contentHead ?? ''),
          attachmentCount: anchor?.attachments.length ?? 0,
          // 候选没有承诺 entries 的排序，因此不猜哪一条是首条。
          first: anchor?.index === 0,
          ...(anchor?.attachments.length
            ? { blocked: true, blockedReason: '这条消息带有无法回填的附件，不能编辑' }
            : {}),
          ...(turn
            ? { operationId: turn.operationId }
            : {
                blocked: true,
                blockedReason: '这条消息没有对应的 operation 精确映射，已拒绝按相似内容回退',
              }),
        }
      })
    },
    plan: async ({ record, boundary }) => {
      const { turn } = await resolve(record, boundary.id)
      if (record === undefined) throw new StopEditError('not-bound', '该会话没有组合记录')
      // 投影锚点在变更 Runtime 之前确认：没有锚点就先拒绝，绝不先改再留旧投影。
      if (record.nativeSessionId && projection) {
        projection.validateBranch?.(record.nativeSessionId)
        const anchor = nativeProjectionAnchor(
          projection,
          record.nativeSessionId,
          turnRequestIds(record, turn),
          turn.native?.officialSeq,
        )
        if (anchor === undefined)
          throw new StopEditError(
            'missing-mapping',
            '官方投影里找不到这条消息的精确落点，已在改动 Runtime 之前拒绝',
          )
        if (anchor.attachments.length)
          throw new StopEditError(
            'attachments-unrestorable',
            '这条消息带有无法回填的附件，已在改动会话之前拒绝',
          )
        if (turn.native?.officialSeq !== undefined) return { draft: anchor.text, unrestored: [] }
      }
      // 原文来自 OPL 自己的持久轮次，不来自 Runtime 的摘要。
      const planned: StopEditPlan = { draft: turn.prompt, unrestored: [] }
      return planned
    },
    rewind: async ({ record, boundary, clientRequestId }) => {
      if (record === undefined)
        throw new StopEditError('not-bound', '该会话没有组合记录，无法建立精确映射')
      const { entry, turn } = await resolve(record, boundary.id)
      // 先取回原会话身份：Runtime 不提前改写记录，绑定一律由提交阶段统一完成。
      const preservedSessionId = record.nativeSessionId
      const anchor =
        preservedSessionId && projection
          ? nativeProjectionAnchor(
              projection,
              preservedSessionId,
              turnRequestIds(record, turn),
              turn.native?.officialSeq,
            )
          : undefined
      const result = (await source.rewind(
        record.acpSessionId,
        entry.userMessageId,
        clientRequestId,
      )) as { rewound?: unknown }
      if (result?.rewound !== true)
        throw new StopEditError('rewind-failed', 'Runtime 未确认回退成功，会话未被改动')
      const deleted = new Set(source.deletedMessageIds(result))
      // 归属完全依据 Runtime 实际删除的标识，不依赖 entries 的返回顺序。
      const classify = (candidate: HarnessTurn): StopEditTail => {
        const userMessageId = candidate.native?.userMessageId
        if (userMessageId === undefined) return 'unknown'
        return deleted.has(userMessageId) ? 'after' : 'before'
      }
      // 投影同步：Runtime 已经原地回退，官方侧栏必须显示同一段前缀。
      if (preservedSessionId && projection && anchor) {
        const cwd = projection.cwd(preservedSessionId) ?? record.cwd
        const projected =
          anchor.index === 0
            ? await projection.create(preservedSessionId, cwd)
            : await projection.fork(preservedSessionId, anchor.prevSeq!)
        const facts = await projection.rebind(
          projected,
          preservedSessionId,
          contentHead(turn.native?.officialSeq !== undefined ? anchor.text : turn.prompt, 20),
        )
        return {
          sessionId: projected,
          preservedSessionId,
          classify,
          draft: turn.native?.officialSeq !== undefined ? anchor.text : turn.prompt,
          // 被移除的历史尾部是用户自己的选择，不是无法恢复的内容。
          unrestored: [],
          review: {
            ...facts,
            model: record.modelRef.model,
            ...(record.reasoningEffort ? { effort: record.reasoningEffort } : {}),
          },
        }
      }
      return {
        sessionId: record.acpSessionId,
        preservedSessionId: record.acpSessionId,
        classify,
        draft: turn.prompt,
        unrestored: [],
        review: { ...source.review(record.acpSessionId), model: record.modelRef.model },
      }
    },
  }
}
