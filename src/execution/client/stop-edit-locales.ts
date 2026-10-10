/**
 * 停止后编辑的全部面向用户文案。
 *
 * 文案与判断分开：`stop-edit.ts` 只决定“该显示哪一种事实”，这里只决定“这句话怎么写”。
 * 集中一处是为了让每条状态都能被测试按真实来源核对——等待、暂无消息、不可用、阻断、
 * 回退失败与待填原文各有各的事实来源，不能互相借用措辞，也不能把 Host 没有报告过的
 * 进度写成一句话。
 *
 * 这里不碰 React、不读 Host，只导出常量与纯格式化函数。
 */
import type { StopEditPhase } from './stop-edit.ts'

/** 入口按钮在各阶段显示的动作名。阶段只来自真实发出的请求，不来自推断。 */
export const STOP_EDIT_PHASE_LABEL: Record<StopEditPhase, string> = {
  idle: '编辑消息',
  loading: '读取中',
  choosing: '选择消息',
  stopping: '停止并等待静止',
  rewinding: '正在回退',
  done: '编辑消息',
  error: '编辑消息',
}

export const STOP_EDIT_COPY = {
  panelTitle: '选择要编辑的消息',
  panelHint: '回退后原文会回到输入框，由你再次发送才会开始。磁盘上的文件保持原样。',
  busyNote: '当前正在运行，将先停止并等待真正静止。',
  firstMessage: '首条消息',
  emptyMessage: '（空消息）',
  branchOpen: '打开编辑分支',
  /** 支持的首批 Harness，首轮还没有任何已发送消息。 */
  waitingEmpty: '暂无可编辑的消息；发送一条消息后即可停止后编辑。',
  /** 支持的首批 Harness，当前仍有轮次在运行。busy 来自 Host，不来自本地推断。 */
  waitingRunning: '当前正在运行；停止并静止后即可编辑这条会话的消息。',
  /** 只读的重新读取，供读取失败或结果不确定之后核对真实状态。 */
  recoveryRead: '重新读取会话历史',
  recoveryReadHint: '重新读取只读取 Host 已持久化的状态，不会改动会话，也不会重发回退。',
  /** 读取失败的固定诊断；不反射底层异常文本。 */
  readFailed: '无法读取会话历史，请稍后重试',
  /** 回退请求失败的固定诊断；不宣称会话没有被改动。 */
  rewindFailed: '回退未完成，请核对会话历史后再试',
  /** 已经把原文放回输入框，但清除持久草稿失败；原文不会因此丢失。 */
  acknowledgementFailed: '清除待填草稿失败，重启后可能再次出现该草稿',
  draftTitle: '待填原文',
  /** 输入框已有内容：原文没有被覆盖，仍留在待填原文里。 */
  draftKept: '输入框里已有你的草稿，原文没有覆盖它，也没有丢失。清空输入框后可以填回。',
  draftRefill: '填回输入框',
  draftRefillBlocked: '输入框里已有内容，先清空才能填回，避免覆盖你正在写的东西。',
  filePreserved: '磁盘上的文件保持原样，本操作不会撤销任何文件。',
} as const

/** 边界行右侧的附件说明；数量来自 Host 报告的边界事实。 */
export function attachmentNote(count: number): string {
  return `${count} 个附件（无法还原，不能编辑）`
}
