export const COLLABORATION_SETTINGS_NAMESPACE = 'settings.oplCollaboration'

export const collaborationZh = {
  title: '协作与自动化',
  inAppHeading: 'DSH 内协作',
  executionUnavailable: '项目执行服务暂不可用，外部接入设置仍可管理。',
  loadingCooperation: '正在读取项目协作设置…',
  cooperationReadFailed: '项目协作设置暂时无法读取',
  cooperationSaveFailed: '协作设置未保存，请重试',
  autoReviewTitle: '交付后自动唤回发起对话验收',
  autoReviewSwitch: '交付后自动验收',
  maxRevisionsLabel: '每个任务最多自动要求修改次数',
  roleDefaultsSummary: '角色默认组合',

  delegationHeading: 'Codex 任务委派',
  oneClickSetup: '一键配置',
  delegationIntro: '配置任务委派、完成通知和项目续作，并启动用于异常恢复的 Codex 本地后台服务。',
  allowExternalCodexTitle: '允许外部 Codex Skill 连接',
  allowExternalCodexSwitch: '允许外部 Codex 接入',
  readStatusFailed: '无法读取外部接入的安装信息。',
  actionSaved: '已保存。',
  actionFailed: '操作未完成，请检查安装状态。',
  setupFailed: '配置未完成，请重试。',

  skillSummary: '协作 Skill',
  statusUnknown: '状态未知',
  statusInstalled: '已安装',
  statusNotInstalled: '未安装',
  updateRepairSkill: '更新 / 修复 Skill',
  installSkill: '安装 Skill',
  autoStartDshLabel: 'Codex 派发任务时自动启动 DSH',

  notificationSummary: '任务完成通知',
  notifyConfigured: '已配置队列桥',
  notifyUnconfigured: '未开启，需主动查询结果',
  notifyIntro:
    '一键配置会自动查找支持任务完成通知的 Codex。使用自定义安装位置或 WSL 时，也可以在这里手动指定。',
  callbackTransportLabel: '回调方式',
  transportUnconnected: '不主动唤醒',
  transportCodexQueue: 'Codex 队列桥',
  executionEnvLabel: '运行环境',
  envNative: '本机',
  envWsl: 'WSL',
  bridgeExecutableLabel: '队列桥可执行文件',
  browseExecutable: '浏览可执行文件',
  wslDistroLabel: 'WSL 发行版',
  notifySavedNotice: '已保存，重新打开 OPL DSH 后生效。',
  saveNotifyButton: '保存通知设置',

  resumeSummary: '项目续作',

  roleDescription:
    '为官方角色预设选择执行组合。绑定用于新对话与新团队成员，已有会话保持原组合。OPL 智能体预设来自本机已安装且允许启动的 Package。这里选择新会话的交互组合，正式 StageRun 的执行器仍由 Package 合同决定。',
  roleEnableRequired: '启用 OPL 执行组合与跨引擎协作后，可配置角色绑定。',
  roleLoading: '正在读取官方角色与执行组合…',
  roleReadFailed: '角色绑定暂时无法读取',
  roleSaveFailed: '角色绑定未保存',
  roleFollowSession: '跟随会话设置',
  rolePreviousUnavailable: '原组合已不可用',
  roleUnavailableSuffix: '（不可用）',

  hookReadFailed: '暂时无法读取 Hook 状态。',
  hookSummaryUnknown: 'Hook 状态未知',
  hookSummaryChecking: '正在检查 Hook…',
  hookSummaryMissing: 'Hook 未安装',
  hookSummaryCheckConfig: 'Hook 配置待检查',
  hookSummaryTrustUnknown: 'Hook 信任状态未知',
  hookSummaryDisabled: 'Hook 已禁用 {count} 项',
  hookSummaryTrusted: 'Hook 已信任 {trusted}/{total}',
  hookPendingConfirmHint: '请到 Codex 设置 → 钩子，确认剩余 {remaining} 项。',
  hooksIntro: '仅用于已登记项目的续作。移除 Hook 不影响普通任务回执。',
  hooksRemove: '移除 Hook',
  hooksInstall: '安装 Hook',
  hooksRefresh: '刷新状态',
} as const

export type CollaborationLocaleKey = keyof typeof collaborationZh

export const collaborationEn: Record<CollaborationLocaleKey, string> = {
  title: 'Collaboration & automation',
  inAppHeading: 'In-app collaboration',
  executionUnavailable:
    'Execution service is unavailable; external delegation can still be managed.',
  loadingCooperation: 'Loading collaboration settings…',
  cooperationReadFailed: 'Could not read collaboration settings',
  cooperationSaveFailed: 'Could not save collaboration settings. Please retry.',
  autoReviewTitle: 'Automatically notify initiator to review after delivery',
  autoReviewSwitch: 'Auto-review after delivery',
  maxRevisionsLabel: 'Max automatic revision requests per task',
  roleDefaultsSummary: 'Role default combinations',

  delegationHeading: 'Codex task delegation',
  oneClickSetup: 'Quick setup',
  delegationIntro:
    'Configure task delegation, completion wake notifications, project resume hooks, and the local Codex recovery service.',
  allowExternalCodexTitle: 'Allow external Codex Skill connections',
  allowExternalCodexSwitch: 'Allow external Codex integration',
  readStatusFailed: 'Could not read external integration status.',
  actionSaved: 'Saved.',
  actionFailed: 'Action failed. Check installation status.',
  setupFailed: 'Setup did not complete. Please retry.',

  skillSummary: 'Collaboration Skill',
  statusUnknown: 'Unknown',
  statusInstalled: 'Installed',
  statusNotInstalled: 'Not installed',
  updateRepairSkill: 'Update / Repair Skill',
  installSkill: 'Install Skill',
  autoStartDshLabel: 'Launch DSH automatically when Codex delegates a task',

  notificationSummary: 'Completion notifications',
  notifyConfigured: 'Queue bridge configured',
  notifyUnconfigured: 'Off (poll manually)',
  notifyIntro:
    'Quick setup locates a Codex build with queue-bridge support. You can also specify a custom binary or WSL setup below.',
  callbackTransportLabel: 'Wake transport',
  transportUnconnected: 'None (manual check)',
  transportCodexQueue: 'Codex queue bridge',
  executionEnvLabel: 'Runtime environment',
  envNative: 'Native',
  envWsl: 'WSL',
  bridgeExecutableLabel: 'Queue bridge executable',
  browseExecutable: 'Browse executable',
  wslDistroLabel: 'WSL distribution',
  notifySavedNotice: 'Saved. Reopen OPL DSH to apply.',
  saveNotifyButton: 'Save notification settings',

  resumeSummary: 'Project resume',

  roleDescription:
    'Choose execution combinations for official role presets. Bindings apply to new chats and new team members; existing sessions keep their setup. StageRun executors remain governed by installed Package contracts.',
  roleEnableRequired: 'Enable OPL execution and collaboration to configure role bindings.',
  roleLoading: 'Loading role presets and combinations…',
  roleReadFailed: 'Could not read role bindings',
  roleSaveFailed: 'Could not save role bindings',
  roleFollowSession: 'Follow session default',
  rolePreviousUnavailable: 'Previous combination unavailable',
  roleUnavailableSuffix: ' (unavailable)',

  hookReadFailed: 'Could not read Hook status.',
  hookSummaryUnknown: 'Hook status unknown',
  hookSummaryChecking: 'Checking Hooks…',
  hookSummaryMissing: 'Hook not installed',
  hookSummaryCheckConfig: 'Hook config needs review',
  hookSummaryTrustUnknown: 'Hook trust unknown',
  hookSummaryDisabled: '{count} Hook(s) disabled',
  hookSummaryTrusted: '{trusted}/{total} Hooks trusted',
  hookPendingConfirmHint: 'Open Codex Settings → Hooks to approve the remaining {remaining}.',
  hooksIntro:
    'Used only for resuming registered projects. Removing Hooks keeps normal task callbacks working.',
  hooksRemove: 'Remove Hook',
  hooksInstall: 'Install Hook',
  hooksRefresh: 'Refresh status',
}

export type CollaborationT = (
  key: CollaborationLocaleKey,
  params?: Record<string, string | number>,
) => string

export const defaultCollaborationT: CollaborationT = (key, params) => {
  const template: string = collaborationZh[key]
  if (!params) return template
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.oplCollaboration': CollaborationLocaleKey
  }
}
