/** Classify only an owned OpenCode primary inference failure; never echo raw diagnostics. */
export function openCodeStreamFailure(line: string, sessionId: string): string | undefined {
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return
  if (
    !line.includes('level=ERROR ') ||
    !line.includes('message="stream error" ') ||
    !line.includes(`session.id=${sessionId} `) ||
    !line.includes('small=false ') ||
    !line.includes('agent=build mode=primary ')
  )
    return
  if (line.includes('AI_APICallError: Free usage limit reached.'))
    return 'OpenCode 免费使用额度已达上限，已停止本轮请求；原任务未自动重发。'
  if (line.includes('error.error="AI_APICallError:'))
    return 'OpenCode 已报告本轮模型接口请求失败，已停止；未取得可确认的 HTTP 状态，原任务未自动重发。'
}
