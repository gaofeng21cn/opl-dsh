import { useEffect, useState } from 'react'
import type { ExecutionCall } from '../../shared/client/remote-call.ts'
/** Show local writer admission without representing queue time as model inference. */
export function QueueStatus({ sessionId, call }: { sessionId: string; call: ExecutionCall }) {
  const [queued, setQueued] = useState(false)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setQueued(false)
    const refresh = async () => {
      try {
        const result = await call('queue-status', { sessionId })
        if (!stopped) setQueued(result.queued)
      } catch {
        if (!stopped) setQueued(false)
      } finally {
        if (!stopped) timer = setTimeout(refresh, 3000)
      }
    }
    void refresh()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [sessionId, call])
  return queued ? (
    <span role="status" title="同目录写任务按顺序执行；当前请求尚未发送给模型。">
      等待同目录任务结束
    </span>
  ) : null
}
