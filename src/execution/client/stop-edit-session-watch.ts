/** Refresh history on official Session lifecycle changes, without polling or stream-delta requests. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** @param session - Official Session read face. @param listener - Refresh when run or opening state changes. @returns Unsubscribe callback. */
export function watchStopEditSession(
  session: ObservableSnapshot<{ running: boolean; blank: boolean; openState: string }>,
  listener: () => void,
): () => void {
  const key = () => {
    const { running, blank, openState } = session.getSnapshot()
    return `${running}:${blank}:${openState}`
  }
  let previous = key()
  return session.subscribe(() => {
    const next = key()
    if (next === previous) return
    previous = next
    listener()
  })
}
