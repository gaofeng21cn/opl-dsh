/**
 * Settings store of the Auto Review section.
 *
 * Contract:
 *  - `load` publishes the reading state and accepts only the newest attempt of
 *    the current Host generation; a late answer from a superseded attempt is
 *    dropped, never filled back into the screen.
 *  - reads and writes are mutually exclusive: a save is refused while a read is
 *    in flight (so it cannot submit an old revision), and a read is refused
 *    while a save is in flight.
 *  - a read never silently replaces a dirty draft. The Host status is refreshed
 *    and a revision change is reported as a conflict, while the draft survives;
 *    a draft that now equals the Host value simply stops being dirty.
 *  - `save` is a single compare-and-swap over the revision read last. A rejected
 *    save keeps the still-valid draft, keeps the rejected intent off the screen,
 *    and exposes only the DTO's fixed failure label. A transport-level failure is
 *    *uncertain*: it blocks further writes until a fresh read confirms the state.
 *  - `mount` binds the current api and Host connection generation. A replaced api
 *    or a new generation invalidates in-flight work and drops the previous Host's
 *    status; an absent or lost generation keeps the last read as context but
 *    disables editing and writes until a generation is ready again.
 *  - `unmount` invalidates in-flight work while staying remountable (a StrictMode
 *    mount/unmount/mount cycle keeps working); `detach` is permanent.
 */
import type {
  AutoReviewClientApi,
  AutoReviewFailure,
  AutoReviewPreferences,
  AutoReviewSaveResult,
  AutoReviewStatus,
} from '../contracts/settings.ts'
import { budgetIsSubmittable, samePreferences } from './preferences.ts'

/** Independent read presentation states: an unresolved read is not a failed one. */
export type AutoReviewReadState = 'loading' | 'ready' | 'error'

/** The single immutable value the component renders. */
export interface AutoReviewView {
  /** State of the most recent read attempt. */
  readonly readState: AutoReviewReadState
  /** Whether a read is in flight. */
  readonly reading: boolean
  /** Whether a save is in flight. */
  readonly saving: boolean
  /** Whether the draft differs from the last accepted Host preferences. */
  readonly dirty: boolean
  /** Host rejected the last save as stale: a fresh read is required before saving again. */
  readonly stale: boolean
  /** A read refreshed the Host status while a dirty draft existed and the revision changed. */
  readonly conflict: boolean
  /** The last save was accepted. */
  readonly saved: boolean
  /** The last save's result is unconfirmed; only a fresh read may clear it. */
  readonly uncertain: boolean
  /** Whether a Host connection generation is available (no source means single-generation). */
  readonly connected: boolean
  /** Fixed failure label of the last rejected save; absent when none applies. */
  readonly failure?: AutoReviewFailure
  /** Last accepted Host status; absent before the first successful read of this generation. */
  readonly status?: AutoReviewStatus
  /** Edited preferences; absent while the screen follows the Host status. */
  readonly draft?: AutoReviewPreferences
}

/** The preferences the form currently operates on. */
export function effectivePreferences(view: AutoReviewView): AutoReviewPreferences | undefined {
  return view.draft ?? view.status?.preferences
}

/** Injected dependency of the store. */
export interface AutoReviewStoreOptions {
  /** The two DTO operations, injected by the plugin wiring. */
  api: AutoReviewClientApi
}

/** Read/save store of one Auto Review settings section. */
export class AutoReviewSettingsStore {
  private view: AutoReviewView
  private api: AutoReviewClientApi
  private hasSource = false
  private connection: number | undefined
  private mounted = true
  private detached = false
  private generation = 0
  private readState: AutoReviewReadState = 'loading'
  private reading = false
  private saving = false
  private status: AutoReviewStatus | undefined
  private draft: AutoReviewPreferences | undefined
  private dirty = false
  private stale = false
  private conflict = false
  private saved = false
  private uncertain = false
  private failure: AutoReviewFailure | undefined
  private readonly listeners = new Set<() => void>()

  /** @param options - the injected read/save dependency. */
  constructor(options: AutoReviewStoreOptions) {
    this.api = options.api
    this.view = this.build()
  }

  getSnapshot = (): AutoReviewView => this.view

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Whether writes and edits are allowed for the current connection generation. */
  isConnected(): boolean {
    return !this.hasSource || this.connection !== undefined
  }

  /**
   * Bind the current api and Host connection generation.
   *
   * A replaced api or a new generation is a different Host: in-flight work is
   * invalidated and the previous read is dropped. A missing or lost generation
   * keeps the last read as context but invalidates in-flight work; edits and
   * writes stay disabled until a generation is ready.
   * @param api - the read/save seam for this mount.
   * @param hasSource - whether a connection source is wired at all.
   * @param connection - the current generation id, or undefined when not ready.
   */
  mount(api: AutoReviewClientApi, hasSource: boolean, connection: number | undefined): void {
    if (this.detached) return
    const apiChanged = this.api !== api
    const generationChanged = this.hasSource !== hasSource || this.connection !== connection
    this.mounted = true
    this.api = api
    this.hasSource = hasSource
    this.connection = connection
    if (!apiChanged && !generationChanged) return
    if (hasSource && connection === undefined) {
      this.invalidateFlight()
      return
    }
    this.invalidateAll()
  }

  /** Invalidate in-flight work but stay remountable (a StrictMode mount cycle). */
  unmount(): void {
    this.mounted = false
    this.generation += 1
  }

  /**
   * Read the Host status.
   *
   * A dirty draft is never overwritten: when the Host revision changed, the
   * conflict is reported and the draft is left untouched.
   * @returns completion of this attempt; failures are published, not thrown.
   */
  async load(): Promise<void> {
    if (this.detached || !this.mounted || this.saving || !this.isConnected()) return
    const generation = (this.generation += 1)
    this.reading = true
    this.publish()
    let next: AutoReviewStatus
    try {
      next = await this.api.read()
    } catch {
      // A transport error may carry environment detail; the view shows a fixed
      // diagnostic instead of echoing it.
      if (!this.accepts(generation)) return
      this.reading = false
      this.readState = 'error'
      this.publish()
      return
    }
    if (!this.accepts(generation)) return
    this.reading = false
    if (!next || typeof next !== 'object') {
      this.readState = 'error'
      this.publish()
      return
    }
    const changed = this.status === undefined || this.status.revision !== next.revision
    this.status = next
    this.stale = false
    // A successful read is the only thing that confirms an uncertain outcome.
    this.uncertain = false
    this.readState = 'ready'
    if (this.draft !== undefined) {
      this.dirty = !samePreferences(this.draft, next.preferences)
      if (!this.dirty) this.draft = undefined
      this.conflict = changed && this.draft !== undefined
    } else {
      this.conflict = false
      this.failure = undefined
    }
    this.publish()
  }

  /**
   * Replace the draft with an edited preference value.
   *
   * The difference to the last accepted Host preferences decides `dirty`; the
   * view falls back to the Host value when the edit matches it.
   * @param next - edited preferences.
   */
  edit(next: AutoReviewPreferences): void {
    if (
      this.detached ||
      !this.mounted ||
      this.saving ||
      this.reading ||
      this.uncertain ||
      !this.isConnected() ||
      this.status === undefined
    )
      return
    const dirty = !samePreferences(next, this.status.preferences)
    this.draft = dirty ? next : undefined
    this.dirty = dirty
    this.saved = false
    this.failure = undefined
    this.publish()
  }

  /**
   * Submit the draft as a compare-and-swap against the revision read last.
   *
   * Refused while a read, an earlier save, a stale draft, or an unconfirmed
   * save is outstanding.
   * @returns completion of this attempt.
   */
  async save(): Promise<void> {
    const status = this.status
    const draft = this.draft
    if (this.detached || !this.mounted || this.saving || this.reading) return
    if (this.stale || this.uncertain || !this.isConnected()) return
    if (status === undefined || draft === undefined) return
    if (!budgetIsSubmittable(draft)) return
    const generation = this.generation
    this.saving = true
    this.saved = false
    this.failure = undefined
    this.publish()
    let result: AutoReviewSaveResult
    try {
      result = await this.api.save({ expectedRevision: status.revision, preferences: draft })
    } catch {
      // The write's outcome is unknown: the server may or may not have applied
      // it. It is not resent; only a fresh read may clear this.
      if (!this.accepts(generation)) return
      this.saving = false
      this.failure = 'save-failed'
      this.uncertain = true
      this.publish()
      return
    }
    if (!this.accepts(generation)) return
    this.saving = false
    if (result.ok) {
      this.status = result.status
      this.draft = undefined
      this.dirty = false
      this.stale = false
      this.conflict = false
      this.uncertain = false
      this.saved = true
      this.publish()
      return
    }
    // The Host answered with its authoritative status. The rejected intent never
    // reaches the screen as if it had taken effect: the enabled switch is rebased
    // onto the Host value while every other edit in the draft survives.
    this.status = result.status
    this.failure = result.failure
    this.stale = result.failure === 'stale-settings'
    this.uncertain = result.failure === 'save-failed'
    const rebased: AutoReviewPreferences = {
      ...draft,
      enabled: result.status.preferences.enabled,
    }
    this.dirty = !samePreferences(rebased, result.status.preferences)
    this.draft = this.dirty ? rebased : undefined
    this.publish()
  }

  /**
   * Invalidate in-flight work and drop the observation (a replaced Host).
   *
   * A dirty draft is kept: the next successful read re-evaluates it against the
   * new Host value, so it is never silently discarded.
   */
  reset(): void {
    if (this.detached) return
    this.invalidateAll()
  }

  /** Make the store permanently silent (a finished lifecycle, not a remount). */
  detach(): void {
    this.detached = true
    this.generation += 1
    this.listeners.clear()
  }

  private accepts(generation: number): boolean {
    return !this.detached && this.mounted && generation === this.generation
  }

  /**
   * A same-generation connection loss: nothing in flight may land, but the last
   * read stays on screen as context, clearly labelled as not current.
   */
  private invalidateFlight(): void {
    this.generation += 1
    this.reading = false
    this.saving = false
    this.saved = false
    this.failure = undefined
    this.stale = false
    this.conflict = false
    this.uncertain = false
    this.readState = this.status === undefined ? 'loading' : 'ready'
    this.publish()
  }

  /**
   * A different Host generation: no status read before it is current. The draft
   * survives and is re-evaluated by the next read.
   */
  private invalidateAll(): void {
    this.generation += 1
    this.status = undefined
    this.saved = false
    this.failure = undefined
    this.stale = false
    this.conflict = false
    this.uncertain = false
    this.saving = false
    this.reading = false
    this.readState = 'loading'
    this.dirty = this.draft !== undefined
    this.publish()
  }

  private build(): AutoReviewView {
    return {
      readState: this.readState,
      reading: this.reading,
      saving: this.saving,
      dirty: this.dirty,
      stale: this.stale,
      conflict: this.conflict,
      saved: this.saved,
      uncertain: this.uncertain,
      connected: this.isConnected(),
      ...(this.failure === undefined ? {} : { failure: this.failure }),
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.draft === undefined ? {} : { draft: this.draft }),
    }
  }

  private publish(): void {
    if (this.detached || !this.mounted) return
    this.view = this.build()
    for (const listener of [...this.listeners]) listener()
  }
}
