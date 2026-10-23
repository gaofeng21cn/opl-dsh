/** Execution deadlines in milliseconds; each must be finite positive integers. */
import type { ExecutionLimits } from '../contracts/limits.ts'
export type ProgressWatchdogLimits = ExecutionLimits

/** Deadline that ended an execution. */
export type ProgressExpiryReason = 'first-progress' | 'idle-progress' | 'total'

/** Bounds execution time and gaps between caller-recognized useful progress. */
export class ProgressWatchdog {
  private readonly limits: ProgressWatchdogLimits
  private started = false
  private idlePaused = false
  private paused = false
  private progressReason: ProgressExpiryReason = 'first-progress'
  private progressRemaining = 0
  private totalRemaining = 0
  private armedAt = 0
  private disposed = false
  private progressTimer: ReturnType<typeof setTimeout> | undefined
  private totalTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    limits: ProgressWatchdogLimits,
    private readonly onExpire: (reason: ProgressExpiryReason) => void,
  ) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
        throw new RangeError(`${name} must be a positive integer timer duration`)
      }
    }
    this.limits = { ...limits }
  }

  /** Starts deadlines when execution actually begins. Repeated calls do nothing. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.totalRemaining = this.limits.totalMs
    this.progressRemaining = this.limits.firstProgressMs
    this.arm()
  }

  /** Records useful output or tool activity; callers exclude empty output and heartbeats. */
  progress(): void {
    if (!this.started || this.disposed || this.paused) return
    this.pause()
    this.progressRemaining = this.limits.idleProgressMs
    this.progressReason = 'idle-progress'
    this.resume()
  }

  /** Excludes an explicitly surfaced human wait from both execution budgets. */
  pause(): void {
    if (!this.started || this.disposed || this.paused) return
    const elapsed = Math.max(0, performance.now() - this.armedAt)
    this.totalRemaining = Math.max(0, this.totalRemaining - elapsed)
    if (!this.idlePaused) this.progressRemaining = Math.max(0, this.progressRemaining - elapsed)
    this.paused = true
    clearTimeout(this.progressTimer)
    clearTimeout(this.totalTimer)
  }

  /** Continues remaining budgets after the human wait ends. */
  resume(): void {
    if (!this.started || this.disposed || !this.paused) return
    this.paused = false
    this.arm()
  }

  /** Suspends progress-gap time during an active tool; total execution time still counts. */
  pauseIdle(): void {
    if (!this.started || this.disposed || this.idlePaused) return
    if (!this.paused) {
      const elapsed = Math.max(0, performance.now() - this.armedAt)
      this.totalRemaining = Math.max(0, this.totalRemaining - elapsed)
      this.progressRemaining = Math.max(0, this.progressRemaining - elapsed)
      clearTimeout(this.progressTimer)
      clearTimeout(this.totalTimer)
    }
    this.idlePaused = true
    if (!this.paused) this.arm()
  }

  /** Continues the remaining progress-gap budget when active tools finish. */
  resumeIdle(): void {
    if (!this.started || this.disposed || !this.idlePaused) return
    if (!this.paused) {
      this.totalRemaining = Math.max(
        0,
        this.totalRemaining - Math.max(0, performance.now() - this.armedAt),
      )
      clearTimeout(this.totalTimer)
    }
    this.idlePaused = false
    if (!this.paused) this.arm()
  }

  private arm(): void {
    this.armedAt = performance.now()
    this.totalTimer = setTimeout(() => this.expire('total'), this.totalRemaining)
    if (!this.idlePaused)
      this.progressTimer = setTimeout(
        () => this.expire(this.progressReason),
        this.progressRemaining,
      )
  }

  /** Cancels all deadlines and prevents future expiration callbacks. */
  dispose(): void {
    this.disposed = true
    clearTimeout(this.progressTimer)
    clearTimeout(this.totalTimer)
  }

  private expire(reason: ProgressExpiryReason): void {
    if (this.disposed) return
    this.dispose()
    this.onExpire(reason)
  }
}
