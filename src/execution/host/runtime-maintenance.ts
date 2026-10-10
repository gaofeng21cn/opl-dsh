/** Excludes runtime changes from asynchronous admission and live work. */
export class RuntimeMaintenance {
  private changing = false
  private admissions = 0
  private closed = false
  private pendingChange: Promise<void> | undefined

  /** Reject model requests and CLI admissions during a runtime transaction. */
  assertAvailable(): void {
    if (this.closed) throw Error('组合服务已关闭')
    if (this.changing) throw Error('正在切换 Harness 运行时，请稍后重试')
  }

  /** Reserve admission before its first asynchronous operation. */
  async admit<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAvailable()
    this.admissions++
    try {
      return await operation()
    } finally {
      this.admissions--
    }
  }

  /** Hold exclusion until validation, publication or failure has settled. */
  async change<T>(busy: () => boolean, operation: () => Promise<T>): Promise<T> {
    this.assertAvailable()
    if (this.admissions || busy()) throw Error('仍有活动任务或启动请求，不能切换 Harness 运行时')
    this.changing = true
    let settled!: () => void
    this.pendingChange = new Promise<void>((resolve) => {
      settled = resolve
    })
    try {
      return await operation()
    } finally {
      this.changing = false
      this.pendingChange = undefined
      settled()
    }
  }
  /** Refuse new admissions and drain an already owned runtime transaction. */
  async close(): Promise<void> {
    this.closed = true
    await this.pendingChange
  }
}
