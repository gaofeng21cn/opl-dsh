/** Claude Code vendor history driver for the shared same-conversation edit transaction. */
import type { ExternalEditContext, ExternalMessageEditDriver } from './message-edit-driver.ts'
import {
  ExternalEditError,
  OPL_EDIT_READ,
  OPL_EDIT_REWIND,
  parseExternalHistory,
  parseExternalResult,
  requireBridgeCapability,
} from './message-edit-codex.ts'

function target(context: ExternalEditContext): string {
  const id = context.record.acpSessionId
  if (typeof id !== 'string' || !id)
    throw new ExternalEditError('history-unreadable', '当前 Claude 会话没有可编辑的 vendor 身份')
  return id
}

function aborted(context: ExternalEditContext): void {
  if (context.signal.aborted) throw new ExternalEditError('aborted', '消息编辑已取消')
}

/** Claude driver: fork at the last retained chain entry; first user gets a fresh identity. */
export function createClaudeMessageEditDriver(): ExternalMessageEditDriver {
  return {
    async read(context) {
      aborted(context)
      requireBridgeCapability(context, OPL_EDIT_READ)
      try {
        const value = await context
          .transport()
          .request(OPL_EDIT_READ, { sessionId: target(context) }, 30_000)
        return parseExternalHistory(value)
      } catch (error) {
        if (error instanceof ExternalEditError) throw error
        throw new ExternalEditError('history-unreadable', 'Claude 历史读取失败，未做任何改动')
      }
    },
    async rewind(context, input) {
      aborted(context)
      requireBridgeCapability(context, OPL_EDIT_REWIND)
      if (input.expected.sessionId !== target(context))
        throw new ExternalEditError('history-changed', 'Claude 会话身份在读取后发生变化')
      try {
        const value = await context.transport().request(
          OPL_EDIT_REWIND,
          {
            sessionId: target(context),
            operationId: input.operationId,
            targetId: input.targetId,
            expectedToken: input.expected.token,
          },
          60_000,
        )
        const result = parseExternalResult(value)
        if (context.signal.aborted)
          throw new ExternalEditError('aborted', '消息编辑已取消，vendor 结果不确定')
        return result
      } catch (error) {
        if (error instanceof ExternalEditError) throw error
        throw new ExternalEditError('rewind-failed', 'Claude 分支未完成，结果不确定')
      }
    },
  }
}

export const claudeMessageEditDriver: ExternalMessageEditDriver = createClaudeMessageEditDriver()
