/**
 * zh/en dictionary of the read-only todo panel.
 *
 * `zh` is the key source of truth and `en` is typed to the same key set, so a
 * missing or extra key is a compile error. `{count}` is the only placeholder.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace owned by the read-only todo panel. */
export const TODO_STATUS_NAMESPACE = 'conversation.oplTodo'

export const zh = {
  title: '待办',
  progressDone: '已完成',
  progressActive: '进行中',
  progressPending: '待处理',
  statusCompleted: '已完成',
  statusPending: '待处理',
  statusInProgress: '进行中',
  statusUnfinished: '未完成',
  statusUnfinishedUnknown: '未完成',
  activityRunning: '会话运行中',
  activityStopped: '会话未运行',
  activityUnknown: '会话活动未知',
  stoppedNote: '会话当前未运行：未完成项按模型记录原样保留，不会被标记为已完成，也不表示正在执行。',
  childRunning: '有 {count} 个子会话正在运行',
  childIdle: '子会话均未在运行',
  childUnknown: '子会话状态未知',
  childUnavailable: '子会话状态不可读',
  childNote: '子会话活动独立于上面的记录状态；它不会把任何一项标记为已完成。',
}

/** Every dictionary key of this namespace. */
export type TodoLocaleKey = keyof typeof zh

export const en: Record<TodoLocaleKey, string> = {
  title: 'Todos',
  progressDone: 'Completed',
  progressActive: 'In progress',
  progressPending: 'Pending',
  statusCompleted: 'Completed',
  statusPending: 'Pending',
  statusInProgress: 'In progress',
  statusUnfinished: 'Unfinished',
  statusUnfinishedUnknown: 'Unfinished',
  activityRunning: 'Session running',
  activityStopped: 'Session not running',
  activityUnknown: 'Session activity unknown',
  stoppedNote:
    'This session is not running: unfinished items are kept exactly as the model recorded them. They are never marked completed and are not shown as executing.',
  childRunning: '{count} child session(s) running',
  childIdle: 'No child session is running',
  childUnknown: 'Child session status unknown',
  childUnavailable: 'Child session status unavailable',
  childNote:
    'Child activity is independent of the recorded states above; it never marks an item completed.',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'conversation.oplTodo': TodoLocaleKey
  }
}
