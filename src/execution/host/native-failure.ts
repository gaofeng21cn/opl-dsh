/** Fixed diagnostics for native delegated turns; upstream text is never reflected. */
export function nativeFailureMessage(code: string | undefined): string {
  switch (code) {
    case 'INVALID_CREDENTIAL':
      return '所选模型渠道拒绝认证或访问权限，原任务未自动重发。'
    case 'RATE_LIMIT':
      return '所选模型渠道限流，原任务未自动重发。'
    case 'SERVER':
      return '所选模型渠道返回服务端错误，原任务未自动重发。'
    case 'TRANSPORT':
    case 'STREAM_CLOSED':
      return '所选模型渠道连接或响应流中断，原任务未自动重发。'
    default:
      return '原生 DSH 本轮执行失败，请查看该会话的错误记录；原任务未自动重发。'
  }
}
