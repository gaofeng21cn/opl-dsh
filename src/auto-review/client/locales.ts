/**
 * zh/en dictionary of the Auto Review settings section. Every product string the
 * panel can render lives here, so no call site assembles prose; `zh` is the key
 * source of truth and `en` is typed to the same key set.
 *
 * The wording is deliberately explicit about the boundaries a user must not
 * misread: this is pre-execution review of native DSH tool calls (not the
 * collaboration feature's delivery wake-back); Auto runs approved actions with
 * full host access and is not a sandbox; a model review replaces human approval
 * but is neither the only pre-execution gate nor a bypass of other gates; and it
 * does not cover the tools running inside an external Harness CLI process.
 *
 * The state and failure copy also keeps what is effective apart from what is
 * only a draft, and never claims a transport-level save failure definitely did
 * not take effect.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

export const zh = {
  sectionLabel: 'Auto Review（工具审批）',
  title: 'Auto Review（工具执行前审查）',
  intro:
    '在 DSH 原生工具执行之前，用一次独立的模型请求裁决该次调用是否放行。审查请求不携带任何工具，只输出放行或拒绝。',
  distinction:
    '与“协作与自动化”中的交付后自动唤回验收无关：那是子任务结束后唤回发起对话验收，本功能在工具执行前裁决是否放行。',
  boundaryNative:
    'DSH 与 ZCode 默认使用 Codex Auto Review；Codex、Claude 使用各自官方审核。其他 Harness 未验证的 Auto 模式不能启动。',
  boundarySandbox:
    'Auto 以完整主机访问执行获准动作。它不是 sandbox，不提供文件隔离；模型审查替代人工审批，但并不绕过其他门禁或审批规则，也不是执行前的唯一闸门。',
  presetNotice:
    '开启不会自动切换任何会话的权限 preset。你仍须在该会话的权限选择器中显式选择 Auto，原生 DSH 工具才会在执行前送审。',
  enableTitle: '启用',
  enableLabel: '启用 Auto Review',
  enableAria: '启用工具执行前审查',
  effectiveLabel: '生效状态（Host）',
  effectiveOn: '已启用',
  effectiveOff: '已关闭',
  draftPending: '草稿尚未保存，生效状态仍以 Host 返回值为准。',
  statusTitle: 'Host 状态',
  stateLabel: '运行状态',
  'state.disabled': '已关闭',
  'state.ready': '可用',
  'state.unavailable': '不可用',
  'state.draining': '停用进行中',
  activeReviews: '在途审查',
  autoSessions: '处于 Auto 的会话',
  revision: 'revision',
  routeTitle: '审查模型路线',
  routeSourceNote:
    '可选路线来自 Host 注册的原生 LLM 路由。这里不从外部 Harness 的执行组合菜单拼装路线。',
  routeCurrent: 'Codex Auto Review（默认）',
  routeFixed: '使用独立 reviewer 路线',
  routesEmpty: '没有可用的审查路线，请检查账号与模型配置。',
  routeUnavailable:
    'Host 报告审查服务当前不可用。你仍可更换已广告的路线或请求关闭；Host 会再次校验，并可能拒绝不安全或仍有活跃会话的停用。',
  routeMissing: '当前记录的独立路线不在 Host 返回的列表中，无法在此编辑；请先重新读取。',
  provider: '提供方',
  model: '模型',
  effort: '推理强度',
  effortNone: '该路线未提供可选推理强度',
  noRanking: '不推荐未经评测的模型排名；这里只呈现 Host 已注册并可用的路线。',
  limitsTitle: '请求预算',
  timeoutMs: '超时（毫秒）',
  maxOutputTokens: '最大输出 token',
  limitsRange:
    '可保存范围：超时 {timeoutMin}–{timeoutMax} 毫秒，输出 {outputMin}–{outputMax} token。Host 会再次校验；超出范围或字段非法的组合会被拒绝。',
  invalidNumber: '超时与输出预算都必须是正数，当前草稿无法提交。',
  draftTitle: '草稿',
  draftDirty: '有未保存的修改。',
  draftClean: '当前显示与 Host 返回一致，没有未保存的修改。',
  save: '保存 Auto Review 设置',
  saveHint:
    '设置不会自动保存：开关、路线与预算都要按此按钮一次提交。保存成功后以 Host 返回的状态为准。',
  saving: '正在保存…',
  refresh: '重新读取 Host 状态',
  statusLoading: '正在读取 Host 状态…',
  statusReloading: '正在重新读取 Host 状态…',
  readFailed: '读取失败：未取得 Host 状态。',
  readFailedHint: '重试只重新读取，不修改任何设置，也不发送模型请求。',
  retry: '重试读取',
  saved: '已保存，界面已按 Host 返回的状态更新。',
  stale: 'Host 拒绝本次保存：草稿基于过期状态。请先重新读取，再保存。',
  conflict: '读取期间 Host 状态已变化；本地草稿已保留、未被覆盖，保存将以最新 revision 提交。',
  uncertainNotice:
    '本次保存结果未确认：可能已生效也可能未生效。不会自动重发；请先重新读取核对状态。',
  hostTruthNote:
    '被拒绝的修改不会先显示为已生效：生效状态以 Host 返回值为准，未保存的修改只作为草稿保留。',
  connectionLost: '连接代次未就绪或已丢失：读到的状态属于上一个 Host，不能当作当前状态。',
  failureTitle: '保存未生效',
  'failure.unavailable': '审查服务当前不可用，未保存。',
  'failure.invalid-settings': 'Host 拒绝这组设置（超出可保存范围或字段非法），未保存。',
  'failure.stale-settings': '状态已过期，未保存。请先重新读取。',
  'failure.sessions-active': '仍有全部项目中的活动在运行，未保存。请等待其结束。',
  'failure.auto-sessions-remain': '仍有会话处于 Auto 权限，停用未生效。请先在这些会话中切换权限。',
  'failure.save-failed':
    '保存请求的结果未确认：可能已生效，也可能未生效。不会自动重发；请先重新读取核对，再决定是否重试。',
  disabledReasonLoading: '正在读取 Host 状态，所有入口暂不可用。',
  disabledReasonRefreshing: '正在刷新 Host 状态，暂不可修改或保存。',
  disabledReasonReadFailed: '读取失败，所有入口暂不可用；请先重试读取。',
  disabledReasonDisconnected: '连接代次未就绪或已丢失，暂不可修改或保存。',
  disabledReasonDraining: '停用进行中，所有入口暂不可用。',
  disabledReasonBusy: '正在保存，暂不可重复提交。',
  disabledReasonUncertain: '上次保存结果未确认；请先重新读取核对，再修改或重试。',
  disabledReasonStale: '状态已过期，请先重新读取再保存。',
  serviceNotReady: '真实服务尚未就绪，所有入口不可用。',
}

/** Every dictionary key of this namespace. */
export type AutoReviewLocaleKey = keyof typeof zh

export const en: Record<AutoReviewLocaleKey, string> = {
  sectionLabel: 'Auto Review (tool approval)',
  title: 'Auto Review (pre-execution tool review)',
  intro:
    'Before a native DSH tool runs, one independent model request decides whether that call is allowed. The review request carries no tools and returns only allow or deny.',
  distinction:
    'Unrelated to "Collaboration & automation" delivery wake-back review: that feature wakes the originating conversation after a subtask ends; this feature decides, before a tool runs, whether it is allowed.',
  boundaryNative:
    'DSH and ZCode default to Codex Auto Review. Codex and Claude use their official reviewers. Other Harnesses cannot start in an unverified Auto mode.',
  boundarySandbox:
    'Auto runs approved actions with full host access. It is not a sandbox and provides no file isolation; a model review replaces human approval, but it neither bypasses other gates or approval rules nor stands as the only pre-execution gate.',
  presetNotice:
    'Enabling does not switch any Session’s permission preset. You must still choose Auto explicitly in that Session’s permission selector before native DSH tools are sent for review.',
  enableTitle: 'Enable',
  enableLabel: 'Enable Auto Review',
  enableAria: 'Enable pre-execution tool review',
  effectiveLabel: 'Effective state (Host)',
  effectiveOn: 'Enabled',
  effectiveOff: 'Closed',
  draftPending: 'The draft is not saved; the effective state is still what the Host returned.',
  statusTitle: 'Host status',
  stateLabel: 'State',
  'state.disabled': 'Closed',
  'state.ready': 'Available',
  'state.unavailable': 'Unavailable',
  'state.draining': 'Disabling',
  activeReviews: 'Reviews in flight',
  autoSessions: 'Sessions on Auto',
  revision: 'revision',
  routeTitle: 'Reviewer route',
  routeSourceNote:
    'Selectable routes come from the native LLM routes the Host has registered. A route is never assembled from the external Harness execution combination menu.',
  routeCurrent: 'Codex Auto Review (default)',
  routeFixed: 'Use an independent reviewer route',
  routesEmpty: 'No reviewer route is available. Check the account and model configuration.',
  routeUnavailable:
    'The Host reports the review service unavailable. You may still switch to an advertised route or request disabling; the Host revalidates and may refuse a disable that is unsafe or still has active Sessions.',
  routeMissing:
    'The recorded independent route is not in the Host’s list and cannot be edited here; re-read first.',
  provider: 'Provider',
  model: 'Model',
  effort: 'Reasoning effort',
  effortNone: 'This route offers no selectable reasoning effort',
  noRanking:
    'No unevaluated model ranking is offered; only routes the Host has registered and marked available appear here.',
  limitsTitle: 'Request budget',
  timeoutMs: 'Timeout (ms)',
  maxOutputTokens: 'Max output tokens',
  limitsRange:
    'Saveable range: timeout {timeoutMin}–{timeoutMax} ms, output {outputMin}–{outputMax} tokens. The Host revalidates; an out-of-range or invalid combination is rejected.',
  invalidNumber:
    'Timeout and output budget must both be positive numbers; the current draft cannot be submitted.',
  draftTitle: 'Draft',
  draftDirty: 'There are unsaved changes.',
  draftClean: 'What is shown matches the Host’s answer; there are no unsaved changes.',
  save: 'Save Auto Review settings',
  saveHint:
    'Nothing is saved automatically: switch, route, and budget are submitted together only by this button. After a successful save the Host’s returned status is authoritative.',
  saving: 'Saving…',
  refresh: 'Re-read Host status',
  statusLoading: 'Reading Host status…',
  statusReloading: 'Re-reading Host status…',
  readFailed: 'Read failed: no Host status was obtained.',
  readFailedHint: 'Retrying only reads again; it changes no setting and sends no model request.',
  retry: 'Retry read',
  saved: 'Saved; the view now follows the Host’s returned status.',
  stale:
    'The Host rejected this save: the draft was based on stale state. Re-read first, then save.',
  conflict:
    'The Host status changed during the read; the local draft was kept and not overwritten, and the save submits under the latest revision.',
  uncertainNotice:
    'This save result is unconfirmed: it may or may not have taken effect. It is not resent automatically; re-read to verify the status first.',
  hostTruthNote:
    'A rejected change is never shown as applied first: the effective state is what the Host returned, and an unsaved change is kept only as a draft.',
  connectionLost:
    'The connection generation is not ready or was lost: the status read belongs to a previous Host and is not current.',
  failureTitle: 'Save did not take effect',
  'failure.unavailable': 'The review service is unavailable; nothing was saved.',
  'failure.invalid-settings':
    'The Host rejected these settings (out of the saveable range or an invalid field); nothing was saved.',
  'failure.stale-settings': 'The state is stale; nothing was saved. Re-read first.',
  'failure.sessions-active':
    'Activity across all projects is still running; nothing was saved. Wait for it to finish.',
  'failure.auto-sessions-remain':
    'Sessions are still on the Auto permission, so disabling did not take effect. Switch those Sessions’ permissions first.',
  'failure.save-failed':
    'The save request result is unconfirmed: it may or may not have taken effect. It is not resent automatically; re-read to verify, then decide whether to retry.',
  disabledReasonLoading: 'Host status is being read; every entry is disabled.',
  disabledReasonRefreshing: 'Host status is being refreshed; editing and saving are disabled.',
  disabledReasonReadFailed: 'The read failed; every entry is disabled. Retry the read first.',
  disabledReasonDisconnected:
    'The connection generation is not ready or was lost; editing and saving are disabled.',
  disabledReasonDraining: 'Disabling is in progress; every entry is disabled.',
  disabledReasonBusy: 'A save is in flight; a duplicate submit is disabled.',
  disabledReasonUncertain:
    'The last save result is unconfirmed; re-read to verify before editing or retrying.',
  disabledReasonStale: 'The state is stale; re-read before saving.',
  serviceNotReady: 'The real service is not ready, so every entry is unavailable.',
}

/** Dictionary namespace registered by this Client feature. */
export const AUTO_REVIEW_NAMESPACE = 'settings.oplAutoReview'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Auto Review settings section copy, state labels, route labels, and failure wording. */
    'settings.oplAutoReview': AutoReviewLocaleKey
  }
}
