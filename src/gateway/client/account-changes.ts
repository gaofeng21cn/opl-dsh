/** Account views invalidate readers after receiving a new Host status. */
const listeners = new Set<() => void>()

/** Subscribe until the returned disposer is called. */
export function subscribeAccountChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Notify readers to fetch the current account; no account or credential is cached here. */
export function notifyAccountChanged(): void {
  for (const listener of listeners) listener()
}
