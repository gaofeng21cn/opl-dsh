/** A one-way intent channel for opening Updates settings on either app or engine updates. */
export type UpdateNavigationTarget = 'suite' | 'engines'

export interface UpdateNavigation {
  /** Record one request to focus the Updates section or its external engines block. */
  request(target?: UpdateNavigationTarget): void
  /** Read the most recently requested focus target within the Updates section. */
  getTarget(): UpdateNavigationTarget
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
  let currentTarget: UpdateNavigationTarget = 'suite'
  let disposed = false
  const listeners = new Set<() => void>()

  return {
    request(target: UpdateNavigationTarget = 'suite') {
      if (disposed) return
      currentTarget = target
      revision += 1
      for (const listener of [...listeners]) listener()
    },
    getTarget() {
      return currentTarget
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
