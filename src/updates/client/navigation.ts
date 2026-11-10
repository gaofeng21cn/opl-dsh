/** A one-way intent channel for opening General settings on the Updates section. */
export interface UpdateNavigation {
  /** Record one request to focus the Updates section. */
  request(): void
  /** Subscribe to new focus requests and return the detach function. */
  subscribe(listener: () => void): () => void
  /** Return the monotonically increasing request revision. */
  getSnapshot(): number
  /** Mark pending requests as handled and return how many were waiting. */
  consume(): number
  /** Stop notifications and release subscribers when the update plugin unloads. */
  dispose(): void
}

/** Create navigation state owned by one mounted updates plugin instance. */
export function createUpdateNavigation(): UpdateNavigation {
  let revision = 0
  let consumedRevision = 0
  let disposed = false
  const listeners = new Set<() => void>()

  return {
    request() {
      if (disposed) return
      revision += 1
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot() {
      return revision
    },
    consume() {
      const pending = revision - consumedRevision
      consumedRevision = revision
      return pending
    },
    dispose() {
      disposed = true
      listeners.clear()
    },
  }
}
