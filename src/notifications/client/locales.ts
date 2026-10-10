/** Notification settings and OS text use the selected Client locale. */
export const zh = {
  nav: '系统通知',
  intro: 'DSH 窗口在后台时，任务结束或失败会发送系统通知。',
  enabled: '任务系统通知',
  help: '支持原生 DSH 与已接入的外部 Harness。手动停止也属于运行结束；内部子 Agent 不单独通知。DSH 完全退出或连接中断期间不补发通知。',
  privacy:
    '通知只显示对话标题和结束状态，不包含模型回答、工具输出或错误详情。点击通知可请求唤回 DSH。',
  test: '发送测试通知',
  ended: '任务已结束',
  failed: '任务失败',
  testTitle: 'OPL DSH 通知测试',
  testBody: '系统通知已启用。',
  ready: '系统通知可用。若未看到弹窗，请检查 Windows 的通知设置和勿扰模式。',
  permission: '需要允许通知；点击测试按钮可申请权限。',
  denied: '系统通知被禁用，请在系统或浏览器的通知设置中允许 DSH。',
  unsupported: '当前环境不支持系统通知。',
  sent: '系统已接收通知。弹窗是否显示受系统通知设置控制。',
  failure: '通知发送失败，请检查系统通知设置后重试。',
  savingFailure: '通知开关未能保存，当前选择仅在本次运行有效。',
  sending: '正在发送…',
}
export type NoticeLocaleKey = keyof typeof zh
export const en: Record<NoticeLocaleKey, string> = {
  nav: 'System notifications',
  intro: 'Send system notifications when a task ends or fails while DSH is in the background.',
  enabled: 'Task system notifications',
  help: 'Supports native DSH and connected external harnesses. Stopping a run also ends it; internal subagents are silent. No notifications are replayed after DSH exits or loses its connection.',
  privacy:
    'Only the conversation title and ending status are shown, without responses, tool output, or error details. Clicking a notification requests DSH focus.',
  test: 'Send test notification',
  ended: 'Task ended',
  failed: 'Task failed',
  testTitle: 'OPL DSH notification test',
  testBody: 'System notifications are enabled.',
  ready:
    'System notifications are available. Check system notification settings and Do Not Disturb if no popup appears.',
  permission: 'Notification permission is required. Use the test button to request it.',
  denied: 'Notifications are disabled. Allow DSH in system or browser notification settings.',
  unsupported: 'System notifications are unavailable in this environment.',
  sent: 'The system received the notification. Popup visibility depends on system settings.',
  failure: 'The notification failed. Check system notification settings and try again.',
  savingFailure: 'The notification preference could not be saved. It applies only to this run.',
  sending: 'Sending…',
}
