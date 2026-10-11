/**
 * zh/en dictionary of the context-budget view: one entry per metric key,
 * {@link BudgetSource}, and fixed warning, so no call site assembles free-form
 * prose. `zh` is the key source of truth and `en` is typed to the same key set.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

export const zh = {
  entry: '上下文预算',
  entryAria: '展开只读的上下文预算观测',
  panelTitle: '上下文预算',
  panelHint: '显示当前可读取的数值；悬停项目可查看来源。',
  enabled: '显示上下文预算',
  settingsIntro: '在对话输入栏查看模型容量和当前上下文占用。',
  settingsHelp:
    '默认关闭，偏好保存在本机。开启后仅显示有值的项目；悬停标题或数值可查看说明和来源。',
  savingFailure: '显示偏好未能保存，当前窗口内仍然生效。',
  statusLoading: '尚无当前观测，正在读取…',
  statusReloading: '正在重新读取当前观测…',
  statusEmpty: '本快照没有可显示的数值。',
  statusError: '读取失败。',
  statusErrorHint: '本次读取没有返回结果。重试只重新读取，不发送消息、不压缩、不改变设置。',
  retry: '重试读取',
  refresh: '刷新读取',
  observedAt: '观测时间',
  route: '当前路由',
  executionNative: '原生 DSH',
  executionHarness: '外部 Harness',
  executionUnknown: '未知执行方式',
  provider: '提供方',
  model: '模型',
  unknownValue: '未知',
  unitTokens: 'token',
  unitNote:
    '数值均为 token 绝对量，不做百分比换算。投影总占用是官方 projectedTokens 的总上下文估算；用量锚定占用由 provider 用量锚定，不是精确的即时压力；容量声明不代表服务端认证。',
  'metric.context-window': '上下文窗口',
  'metric.request-output-limit': '最近请求输出上限',
  'metric.declared-output-limit': '默认输出额度',
  'help.context-window': '适配器声明的容量，未认证服务端实际容量。',
  'help.request-output-limit': '已记录请求使用的输出上限。',
  'help.declared-output-limit': '适配器声明的默认输出额度。',
  'help.projected-input': '整个上下文的 token 估算。',
  'help.pressure': '由提供方用量锚定，不是即时精确值。',
  'help.compaction-threshold': '当前公开的生效压缩阈值。',
  'help.compaction-retain': '当前公开的生效保留额度。',
  'metric.projected-input': '投影总占用（估算）',
  'metric.pressure': '用量锚定占用',
  'metric.compaction-threshold': '压缩阈值',
  'metric.compaction-retain': '压缩保留尾部',
  sourceLabel: '来源',
  sourceAbsent: '未提供',
  'source.adapter-declaration': '适配器声明',
  'source.request-header': '请求头',
  'source.session-projection': '会话投影',
  'source.runtime': '运行时',
  'source.unavailable': '不可用',
  warningsTitle: '提示',
  'warning.declaration-only': '容量数值来自适配器声明，不代表服务端实际容量。',
  'warning.harness-managed': '该会话由外部 Harness 自主管理上下文预算，DSH 无法认证其占用。',
  'warning.policy-unknown': '有效压缩策略未公开，压缩阈值与保留尾部未知，本视图不做推断。',
  'warning.read-unavailable': '部分观测不可用，未提供的项目已隐藏。',
}

/** Every dictionary key of this namespace. */
export type BudgetLocaleKey = keyof typeof zh

export const en: Record<BudgetLocaleKey, string> = {
  entry: 'Context budget',
  entryAria: 'Expand the read-only context budget observations',
  panelTitle: 'Context budget',
  panelHint: 'Only available figures are shown. Hover over a row to see its source.',
  enabled: 'Show context budget',
  settingsIntro: 'View model capacity and context occupancy beside the composer.',
  settingsHelp:
    'Off by default, saved on this device. Only available figures are shown; hover over the title or a figure for notes and sources.',
  savingFailure: 'The display preference could not be saved. It still applies in this window.',
  statusLoading: 'No current observation yet, reading…',
  statusReloading: 'Re-reading the current observation…',
  statusEmpty: 'This snapshot carries no displayable figure.',
  statusError: 'Read failed.',
  statusErrorHint:
    'This read returned no result. Retrying only reads again; it sends no message, compacts nothing, and changes no setting.',
  retry: 'Retry read',
  refresh: 'Refresh read',
  observedAt: 'Observed at',
  route: 'Current route',
  executionNative: 'Native DSH',
  executionHarness: 'External Harness',
  executionUnknown: 'Unknown execution mode',
  provider: 'Provider',
  model: 'Model',
  unknownValue: 'Unknown',
  unitTokens: 'tokens',
  unitNote:
    'Every figure is an absolute token count and nothing is converted to a percentage. Projected total occupancy is the official projectedTokens total-context estimate; usage-anchored occupancy is anchored to provider usage and is not an exact instantaneous pressure; a capacity declaration is not server certification.',
  'metric.context-window': 'Context window',
  'metric.request-output-limit': 'Latest recorded request output limit',
  'metric.declared-output-limit': 'Default output allowance',
  'help.context-window': 'Adapter-declared capacity; actual server capacity is not certified.',
  'help.request-output-limit': 'Output limit used by the recorded request.',
  'help.declared-output-limit': 'Default output allowance declared by the adapter.',
  'help.projected-input': 'Estimated token count of the entire context.',
  'help.pressure': 'Anchored to provider usage, not an exact instantaneous reading.',
  'help.compaction-threshold': 'Published effective compaction threshold.',
  'help.compaction-retain': 'Published effective retained allowance.',
  'metric.projected-input': 'Projected total occupancy (estimate)',
  'metric.pressure': 'Usage-anchored occupancy',
  'metric.compaction-threshold': 'Compaction threshold',
  'metric.compaction-retain': 'Compaction retained tail',
  sourceLabel: 'Source',
  sourceAbsent: 'Not provided',
  'source.adapter-declaration': 'Adapter declaration',
  'source.request-header': 'Request header',
  'source.session-projection': 'Session projection',
  'source.runtime': 'Runtime',
  'source.unavailable': 'Unavailable',
  warningsTitle: 'Notes',
  'warning.declaration-only':
    'The capacity figure comes from an adapter declaration; it does not certify real server capacity.',
  'warning.harness-managed':
    'This Session is managed by an external Harness, which owns its context budget; DSH cannot certify its occupancy.',
  'warning.policy-unknown':
    'The effective compaction policy is not published. The compaction threshold and the retained tail are unknown, and this view infers neither.',
  'warning.read-unavailable': 'Some observations are unavailable; missing rows are hidden.',
}

/** Dictionary namespace registered by this Client feature. */
export const BUDGET_NAMESPACE = 'conversation.oplContextBudget'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Context-budget entry, panel, metric, source, and warning copy. */
    'conversation.oplContextBudget': BudgetLocaleKey
  }
}
