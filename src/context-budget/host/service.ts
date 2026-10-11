/**
 * Read-only context-budget observability for one caller-named official Session.
 *
 * The service reads only official public seams: the Session store and log folds,
 * the Session projection registry, and the LLM adapter registry. It creates no
 * Session, makes no model call, measures nothing, writes no Session event,
 * registers no projection, subscribes to nothing, and reads no private
 * configuration. Its whole lifecycle is the Cordis service itself, so it is
 * installed and torn down with the owning fiber.
 *
 * Every number is a token count. Null always means unknown.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { ContextBudgetRequest, ContextBudgetSnapshot } from '../contracts/budget.ts'
import {
  UNRESOLVED_ROUTE,
  buildBudgetSnapshot,
  effectiveRoute,
  type AdapterObservation,
  type RequestContextObservation,
  type RequestHeaderObservation,
  type RouteResolution,
  type SelectionObservation,
} from './observe.ts'
import {
  readContextPressure,
  readModelSelection,
  readRequestContext,
  readRequestHeader,
  type ProjectionRead,
  type ProjectionStatus,
} from './projections.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oplContextBudget: ContextBudgetService
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No live Session has the requested id. */
    'context-budget/session-not-found': {}
    /** The observation failed; the diagnostic is fixed and carries no input. */
    'context-budget/read-failed': {}
  }
}

/** Stable name of this Remote namespace; the constructor repeats it as a literal
 * because the RPC generator requires a string literal service key. */
export const CONTEXT_BUDGET_SERVICE = 'oplContextBudget'

/** Fixed diagnostics: never the original error text, request content, or a key. */
const NO_SESSION = 'No live session has the requested id.'
const READ_FAILED = 'The context budget could not be read.'
const NO_REQUEST = 'A session id is required.'

/** At most one bounded re-read before an incoherent cut is published as unknown. */
const MAX_ATTEMPTS = 2

/** One self-consistent read of the public seams. */
interface Observation {
  /** `failed` keeps the failure fact: the route is then unknown, never the old header. */
  readonly selectionStatus: ProjectionStatus
  readonly selection: SelectionObservation | null
  readonly requestHeader: RequestHeaderObservation | null
  readonly requestContext: RequestContextObservation | null
  readonly pressure: ProjectionRead<{
    readonly contextWindow?: number
    readonly pressureTokens?: number
    readonly projectedTokens?: number
  }>
}

/** Read one Session's declared and actual context budget, with sources and unknowns. */
export class ContextBudgetService extends TypertRemoteService {
  static inject = ['sessions', 'llm', 'sessionProjections']

  constructor(ctx: Context) {
    super(ctx, 'oplContextBudget')
  }

  /** Observe the Session named by the request; unknown values stay null.
   * @param request - the official Session id whose budget is requested.
   * @returns the fixed-seven-key snapshot for that Session.
   * @throws RemoteError with a fixed diagnostic when the request is invalid, the
   * Session is missing, or the observation fails.
   */
  @Remote('read')
  async read(request: ContextBudgetRequest): Promise<ContextBudgetSnapshot> {
    const sessionId = (request as { sessionId?: unknown } | undefined)?.sessionId
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new RemoteError('gateway/bad-request', NO_REQUEST, {})
    }
    let session: Session | undefined
    try {
      session = this.ctx.sessions.get(SessionId(sessionId))
    } catch {
      throw new RemoteError('context-budget/read-failed', READ_FAILED, {})
    }
    if (session === undefined) {
      throw new RemoteError('context-budget/session-not-found', NO_SESSION, {})
    }
    try {
      return await this.observe(sessionId, session)
    } catch {
      // Every observation failure becomes one fixed diagnostic: no original
      // message, no cause, and no request content enters the failure or a log.
      throw new RemoteError('context-budget/read-failed', READ_FAILED, {})
    }
  }

  /**
   * Gather the public observations for one live Session.
   *
   * Exact-model resolution is asynchronous, so the public records can move while
   * it is in flight: a model may be selected, or a request recorded. The reads
   * are therefore repeated and compared, at most {@link MAX_ATTEMPTS} times. A
   * cut that still moves is published as unknown rather than as a stale pairing.
   */
  private async observe(sessionId: string, session: Session): Promise<ContextBudgetSnapshot> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const before = this.gather(session)
      const { route } = effectiveRoute(before)
      const routeResolution = route === null ? UNRESOLVED_ROUTE : await this.resolveRoute(route)
      const observedAt = new Date().toISOString()
      const after = this.gather(session)
      if (fingerprint(before) === fingerprint(after)) {
        return this.publish(sessionId, observedAt, after, routeResolution)
      }
      if (attempt === MAX_ATTEMPTS - 1) {
        // The reads moved twice: publish no route and no number.
        return this.publish(sessionId, observedAt, after, UNRESOLVED_ROUTE, true)
      }
    }
    /* v8 ignore next -- the loop always returns */
    throw new Error('unreachable')
  }

  /** Assemble one snapshot from a self-consistent read. */
  private publish(
    sessionId: string,
    observedAt: string,
    observation: Observation,
    routeResolution: RouteResolution,
    drifted = false,
  ): ContextBudgetSnapshot {
    return buildBudgetSnapshot({
      sessionId,
      observedAt,
      selection: observation.selection,
      requestHeader: observation.requestHeader,
      requestContext: observation.requestContext,
      pressure: observation.pressure.status === 'read' ? observation.pressure.value : null,
      pressureStatus: observation.pressure.status,
      selectionStatus: observation.selectionStatus,
      route: routeResolution,
      ...(drifted ? { drifted: true } : {}),
    })
  }

  /** Read every public observation for one Session. */
  private gather(session: Session): Observation {
    const selectionRead = readModelSelection(this.ctx.sessionProjections, session)
    const headerFacts = readRequestHeader(session)
    const contextFacts = readRequestContext(session)
    const requestHeader: RequestHeaderObservation | null =
      headerFacts.provider === undefined || headerFacts.model === undefined
        ? null
        : {
            provider: headerFacts.provider,
            model: headerFacts.model,
            ...(headerFacts.maxTokens === undefined ? {} : { maxTokens: headerFacts.maxTokens }),
          }
    const requestContext: RequestContextObservation | null =
      contextFacts.provider === undefined || contextFacts.model === undefined
        ? null
        : {
            provider: contextFacts.provider,
            model: contextFacts.model,
            ...(contextFacts.contextWindow === undefined
              ? {}
              : { contextWindow: contextFacts.contextWindow }),
          }
    return {
      selectionStatus: selectionRead.status,
      // A failed read stays a failure: it never degrades into "no selection",
      // which would wrongly promote the last request header to the current route.
      selection: selectionRead.status === 'read' ? selectionRead.value : null,
      requestHeader,
      requestContext,
      pressure: readContextPressure(this.ctx.sessionProjections, session),
    }
  }

  /** Ask the official LLM service who owns the effective route and what it declares. */
  private async resolveRoute(route: { provider: string; model: string }): Promise<RouteResolution> {
    let providerRegistered = false
    try {
      providerRegistered = this.ctx.llm.listProviders().some((entry) => entry.id === route.provider)
    } catch {
      return { adapter: null, failed: true }
    }
    if (!providerRegistered) return { adapter: null, failed: false }

    try {
      const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model)
      const adapter: AdapterObservation = {
        ...(info.context === undefined ? {} : { contextWindow: info.context.contextWindow }),
        ...(info.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: info.defaultMaxTokens }),
      }
      return { adapter, failed: false }
    } catch {
      return { adapter: null, failed: true }
    }
  }
}

/** A stable comparison key for one read; the values are small plain JSON. */
function fingerprint(observation: Observation): string {
  return JSON.stringify([
    observation.selectionStatus,
    observation.selection,
    observation.requestHeader,
    observation.requestContext,
    observation.pressure,
  ])
}

export default ContextBudgetService
