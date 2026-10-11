/**
 * Read face for the two official public Session projections this view needs.
 *
 * `modelSelection` is declared by `@deepseek-ai/dsh-api-session-controller/types`,
 * so it is read with the official host state (`lastUsed` / `pending`) and its own
 * validated vocabulary.
 *
 * `contextPressure` is declared by the official `@deepseek-ai/dsh-token-meter`
 * host plugin. That package is mounted by the official desktop application but
 * is NOT a dependency of this repository, and this read-only view may not add
 * one. The key is therefore declared here, matching the packaged rc.2 unit
 * exactly (verified in the shipped official runtime, not guessed):
 *
 *  - state (`contextPressureStateSchema`, stateVersion 5):
 *      { contextWindow?: positive int, pressureTokens?: non-negative int,
 *        surfaceTokens: non-negative int, sampledSurfaceTokens?: non-negative int,
 *        claim?: { start, end, tokens } }
 *  - wire view (`pressureSchema`):
 *      { contextWindow?: positive int, pressureTokens?: non-negative int,
 *        projectedTokens?: non-negative int }
 *
 * Only the wire view is read, so only {@link SessionProjectionMap} is extended;
 * if `dsh-token-meter` ever becomes a dependency, this declaration must be
 * reconciled with the package's own one.
 *
 * Nothing here writes, registers, subscribes, or triggers a measurement.
 */
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { ModelSelectionProjectionState } from '@deepseek-ai/dsh-api-session-controller/types'

/** Wire value of the official `contextPressure` projection. */
export interface ContextPressureProjection {
  /** Route-declared capacity recorded by the latest `request/context` event. */
  readonly contextWindow?: number
  /** Prompt-side pressure of the latest provider usage sample. */
  readonly pressureTokens?: number
  /** Pressure sample plus the surface's signed movement since it was taken. */
  readonly projectedTokens?: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    contextPressure: ContextPressureProjection
  }
}

/** Why one projection value is not present. */
export type ProjectionStatus = 'read' | 'absent' | 'failed'

/** One projection read that never throws and never returns an unvalidated value. */
export type ProjectionRead<T> =
  | { readonly status: 'read'; readonly value: T }
  | { readonly status: 'absent' }
  | { readonly status: 'failed' }

/** A positive token count, or undefined when the value is not one. */
function positiveTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** A non-negative token count, or undefined when the value is not one. */
function nonNegativeTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** A non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read the durable model-selection state for one live Session.
 * @param registry - live Session projection registry.
 * @param session - Session to read.
 * @returns the validated selection state, or why it is not present.
 */
export function readModelSelection(
  registry: SessionProjectionRegistry,
  session: Session,
): ProjectionRead<ModelSelectionProjectionState> {
  try {
    const state = registry.stateOf(session, 'modelSelection')
    if (state === undefined) return { status: 'absent' }
    return { status: 'read', value: state }
  } catch {
    return { status: 'failed' }
  }
}

/**
 * Read the validated `contextPressure` wire view for one live Session.
 * @param registry - live Session projection registry.
 * @param session - Session to read.
 * @returns the validated wire view, or why it is not present.
 */
export function readContextPressure(
  registry: SessionProjectionRegistry,
  session: Session,
): ProjectionRead<ContextPressureProjection> {
  try {
    const snapshot = registry.snapshot(session, ['contextPressure'])
    const raw = snapshot.values.contextPressure as ContextPressureProjection | undefined
    if (raw === undefined) return { status: 'absent' }
    const contextWindow = positiveTokens(raw.contextWindow)
    const pressureTokens = nonNegativeTokens(raw.pressureTokens)
    const projectedTokens = nonNegativeTokens(raw.projectedTokens)
    return {
      status: 'read',
      value: {
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(pressureTokens === undefined ? {} : { pressureTokens }),
        ...(projectedTokens === undefined ? {} : { projectedTokens }),
      },
    }
  } catch {
    return { status: 'failed' }
  }
}

/**
 * Read the latest durable `request/header` route facts, the header the next
 * request is compared against.
 * @param session - Session to read.
 * @returns the provider/model and persisted output limit, or null/undefined.
 */
export function readRequestHeader(session: Session): {
  provider?: string
  model?: string
  maxTokens?: number
} {
  const header = session.requestHeader()
  const config: { provider?: unknown; model?: unknown; maxTokens?: unknown } | undefined =
    header?.config
  const provider = text(config?.provider)
  const model = text(config?.model)
  const maxTokens = positiveTokens(config?.maxTokens)
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
}

/**
 * Read the latest durable `request/context` route metadata.
 * @param session - Session to read.
 * @returns the recorded route and capacity, when each is present.
 */
export function readRequestContext(session: Session): {
  provider?: string
  model?: string
  contextWindow?: number
} {
  const context = session.requestContext()
  const provider = text(context?.provider)
  const model = text(context?.model)
  const contextWindow = positiveTokens(context?.contextWindow)
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
}
