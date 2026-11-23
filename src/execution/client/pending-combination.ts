async function waitForSelection(pending: Promise<unknown>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const onAbort = () => cancelled.reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.race([pending, cancelled.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Coordinates a composer's send with the picker write for the same session. */
export class PendingCombination {
  private readonly writes = new Map<string, Promise<unknown>>()

  private readonly failed = new Set<string>()

  needsConfirmation(sessionId: string): boolean {
    return this.failed.has(sessionId)
  }

  async select<T>(sessionId: string, write: () => Promise<T>): Promise<T> {
    const pending = write()
    this.failed.delete(sessionId)
    this.writes.set(sessionId, pending)
    try {
      return await pending
    } catch (error) {
      if (this.writes.get(sessionId) === pending) this.failed.add(sessionId)
      throw error
    } finally {
      if (this.writes.get(sessionId) === pending) this.writes.delete(sessionId)
    }
  }

  async send<T>(
    sessionId: string,
    signal: AbortSignal | undefined,
    submit: () => Promise<T>,
  ): Promise<T> {
    const pending = this.writes.get(sessionId)
    if (this.failed.has(sessionId)) throw Error('模型切换失败，请重新选择后发送。')
    if (!pending) return submit()
    if (signal) await waitForSelection(pending, signal)
    else await pending
    signal?.throwIfAborted()
    if (this.writes.has(sessionId) || this.failed.has(sessionId))
      throw Error('模型选择已改变，请重新发送。')
    return submit()
  }
}
