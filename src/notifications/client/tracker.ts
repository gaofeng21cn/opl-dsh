/** Live Agent transitions; catalog baselines and reconnects are not task endings. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export type TaskNotice = 'ended' | 'failed'

/** Observe each root run once, suppressing its ordinary ending after a failure. */
export class TaskNoticeTracker {
  private readonly runs = new Map<SessionId, { failed: boolean }>()

  /** @param id - Session receiving a live status. @param running - Actual Agent state. @returns One terminal notice, if observed. */
  status(id: SessionId, running: boolean): TaskNotice | undefined {
    if (running) {
      if (!this.runs.has(id)) this.runs.set(id, { failed: false })
      return
    }
    const run = this.runs.get(id)
    this.runs.delete(id)
    if (run && !run.failed) return 'ended'
  }

  /** @param id - Session with an Agent error. @returns A failure only for an observed active run. */
  failure(id: SessionId): TaskNotice | undefined {
    const run = this.runs.get(id)
    if (!run || run.failed) return
    run.failed = true
    return 'failed'
  }

  /** @param id - Removed Session whose run must not report later. */
  remove(id: SessionId): void {
    this.runs.delete(id)
  }

  /** Forget live transitions when their connection generation is lost. */
  reset(): void {
    this.runs.clear()
  }
}
