/**
 * The conservative guard that outlives one Auto Review Host instance.
 *
 * A plugin's `tools/pre-execute` listener belongs to its own fiber, so
 * unloading the Host necessarily removes it. That is fine only while the
 * Session's own durable approval policy is conservative; a Session that pinned
 * `auto` with `never` would otherwise regain an unreviewed, never-approved
 * pipeline the instant the Host went away — and a failed durable narrowing
 * cannot be compensated for by a `finally`.
 *
 * The guard therefore belongs to the **root** Context, whose lifetime is the
 * whole application, and the Host merely leases the review capability:
 *
 *  - while a live Host holds the lease the guard is passive and calls `next()`,
 *    so the Host's own gate is the only thing that decides anything;
 *  - a Host unload that proves the conservative state (every live `auto` session
 *    durably narrowed to the preset's own `ask`) releases the lease;
 *  - a Host unload that cannot prove it leaves the lease **conservative**, and
 *    the guard refuses every call from a Session that selects `auto` — or whose
 *    permission state cannot be read — instead of letting it run unreviewed.
 *
 * Nothing here changes a Session's permissions, and the guard is registered
 * once per root: a reload adopts the same lease instead of stacking a second
 * guard.
 */
import type { Context } from '@deepseek-ai/cordis'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import { RUN_CODE_NAME, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { durablePermissionKnobs } from './policy.ts'

/** One root's review capability lease. */
export interface ReviewLease {
  /** Whether a live Host currently owns the review capability. */
  live: boolean
  /**
   * Whether the last Host lifetime ended without proving a conservative state.
   * While true the root guard refuses `auto` traffic.
   */
  conservative: boolean
}

/** Durable error identity for a call refused because the reviewer cannot run. */
export const UNAVAILABLE_ERROR_NAME = 'AutoReviewUnavailableError'
export const UNAVAILABLE_CODE = 'AUTO_REVIEW_UNAVAILABLE'

/** One lease and one guard per root context. */
const leases = new WeakMap<object, ReviewLease>()

/** The fixed refusal the conservative guard returns. */
function conservativeDecision(exec: ToolExecution): PreToolDecision {
  return {
    kind: 'deny',
    reason: `Auto review is unavailable for tool "${exec.name}"; its body was not executed`,
    info: { name: UNAVAILABLE_ERROR_NAME, code: UNAVAILABLE_CODE },
  }
}

/**
 * Take (or join) the root's review lease, installing the guard on first use.
 *
 * The guard is registered on the root fiber, so unloading the Host that
 * installed it cannot remove the last refusal.
 * @param ctx - any context of the application; its root owns the lease.
 * @returns the shared lease for that root.
 */
export function acquireReviewLease(ctx: Context): ReviewLease {
  const root = ctx.root
  const existing = leases.get(root)
  if (existing !== undefined) return existing
  const lease: ReviewLease = { live: false, conservative: false }
  leases.set(root, lease)
  root.effect(() => {
    const off = root.on(
      'tools/pre-execute',
      async (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
        if (!lease.conservative) return await next()
        const agent = exec.agent
        if (agent === undefined) return await next()
        // The outer PTC transport has no action of its own; its started inner
        // calls re-enter this waterfall and are refused there.
        if (exec.parent === undefined && exec.name === RUN_CODE_NAME) return await next()
        // The durable identity is the authority here, not the live preset
        // resolution: once the Host's `auto` publication is gone, a Session
        // that durably selected `auto` derives as whichever configured preset
        // matches its knobs — normally `danger-full-access`/`never`.
        const knobs = durablePermissionKnobs(agent.session)
        if (knobs !== null && knobs.preset !== AUTO_PRESET) return await next()
        return conservativeDecision(exec)
      },
      { prepend: true },
    )
    return () => off()
  }, 'opl auto review conservative guard')
  return lease
}

/**
 * Read the lease already installed for one application, without installing one.
 * @param ctx - any context of the application.
 * @returns the existing lease, or undefined when no Host ever took one.
 */
export function reviewLeaseOf(ctx: Context): ReviewLease | undefined {
  return leases.get(ctx.root)
}
