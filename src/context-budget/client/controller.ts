/**
 * Read store of one composer entry.
 *
 * Contract: `load` claims an attempt generation and publishes `loading` with no
 * snapshot, so a pending read never presents the previous route's figures as
 * current; only the newest attempt of the Session the store still targets may
 * publish. `reset` (new Host generation) invalidates in-flight reads, `detach`
 * (unmount) makes the store permanently silent. The only side effect is calling
 * the injected `read`.
 */
import type { ContextBudgetSnapshot } from '../contracts/budget.ts'

/** Independent presentation states: an unresolved read is not a failed one. */
export type BudgetStatus = 'loading' | 'ready' | 'error'

/** The single immutable value the component renders. */
export interface BudgetView {
  /** State of the most recent read attempt. */
  readonly status: BudgetStatus
  /** Session this view currently belongs to. */
  readonly sessionId: string
  /** Accepted observation of the current route; absent while loading and after a failure. */
  readonly snapshot?: ContextBudgetSnapshot
  /** Whether this loading state replaced an accepted observation of the same Session. */
  readonly reloading: boolean
}

/** Injected read dependency of the store. */
export interface BudgetReadOptions {
  /** @param sessionId - Session to read. @returns the Host-computed snapshot. */
  read(sessionId: string): Promise<ContextBudgetSnapshot>
}

/** Read-only store of one composer entry's budget observations. */
export class ContextBudgetReadStore {
  private value: BudgetView = { status: 'loading', sessionId: '', reloading: false }
  private generation = 0
  private sessionId = ''
  private detached = false
  /** Sessions with an accepted observation; drives the reload wording. */
  private readonly observed = new Set<string>()
  private readonly listeners = new Set<() => void>()

  /** @param options - the injected read dependency. */
  constructor(private readonly options: BudgetReadOptions) {}

  getSnapshot = (): BudgetView => this.value

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Bind the store to the Session the entry renders right now.
   *
   * React commits a re-render before the passive effect that issues the new
   * read, so the binding must move at render time: the identity comparison, not
   * a later `load`, rejects an answer for the Session that just left the screen.
   * Silent by design (no notification, no generation) — it runs during render.
   * @param sessionId - Session the entry currently renders.
   */
  target(sessionId: string): void {
    if (this.detached || this.sessionId === sessionId) return
    this.sessionId = sessionId
    this.value = this.loading(sessionId)
  }

  /**
   * Read one Session.
   * @param sessionId - Session to read.
   * @returns completion of this attempt; failures are published, not thrown.
   */
  async load(sessionId: string): Promise<void> {
    if (this.detached) return
    const generation = (this.generation += 1)
    this.sessionId = sessionId
    // The previous route's figures leave the screen with the new attempt.
    this.publish(this.loading(sessionId))
    let snapshot: ContextBudgetSnapshot
    try {
      snapshot = await this.options.read(sessionId)
    } catch {
      // A transport or provider error may carry environment detail; the view
      // shows a fixed diagnostic instead of echoing it.
      if (!this.accepts(generation, sessionId)) return
      this.publish({ status: 'error', sessionId, reloading: false })
      return
    }
    if (!this.accepts(generation, sessionId)) return
    // A snapshot naming another Session would put foreign figures on screen.
    if (!snapshot || snapshot.sessionId !== sessionId) {
      this.publish({ status: 'error', sessionId, reloading: false })
      return
    }
    this.observed.add(sessionId)
    this.publish({ status: 'ready', sessionId, reloading: false, snapshot })
  }

  /**
   * Invalidate in-flight reads and forget every observation.
   *
   * Called when the connected Host generation is replaced: nothing read before
   * the reconnect may land afterwards, and nothing about it is still known.
   */
  reset(): void {
    if (this.detached) return
    this.generation += 1
    this.sessionId = ''
    this.observed.clear()
    this.publish({ status: 'loading', sessionId: '', reloading: false })
  }

  /**
   * Make the store permanently silent.
   *
   * A response arriving after unmount must not publish and must not touch the
   * composer that replaced this entry.
   */
  detach(): void {
    this.detached = true
    this.generation += 1
    this.listeners.clear()
  }

  private loading(sessionId: string): BudgetView {
    return { status: 'loading', sessionId, reloading: this.observed.has(sessionId) }
  }

  /**
   * Whether one attempt's answer may still be published.
   *
   * Both clauses are load-bearing and each is pinned by its own test:
   * `generation` rejects an answer that a newer attempt (a refresh, a
   * reconnect) has already superseded, and `sessionId` rejects an answer for
   * the Session the entry left — including in the window after a re-render but
   * before the effect that would start the new attempt.
   * @param generation - attempt generation claimed by the read.
   * @param sessionId - Session that attempt promised to read.
   * @returns whether the answer is still current.
   */
  private accepts(generation: number, sessionId: string): boolean {
    return !this.detached && generation === this.generation && this.sessionId === sessionId
  }

  private publish(next: BudgetView): void {
    if (this.detached) return
    this.value = next
    for (const listener of [...this.listeners]) listener()
  }
}
