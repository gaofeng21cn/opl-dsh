/**
 * Pure assembly of one read-only context-budget observation.
 *
 * Every value is either a real public observation or null (unknown). The module
 * never derives a policy default, never certifies a declaration as server
 * capacity, and never pairs a value read under one route with a later route.
 * When no coherent observation was reached — the records moved under the read,
 * or the selection fold could not be read — nothing about the current route is
 * claimed at all.
 *
 * Sources:
 *  - `adapter-declaration` — the registered adapter's declared metadata for the
 *    exact route the next request will use. It declares, it does not prove.
 *  - `request-header` — the persisted `request/header`, and only while it still
 *    describes the effective route.
 *  - `session-projection` — the official public `contextPressure` projection,
 *    and only while the durable `request/context` still attributes it to the
 *    effective route.
 *  - `unavailable` — unknown: absent, unreadable, moved, or withheld because it
 *    belongs to a superseded route.
 *
 * `execution` is always `unknown`: adapter metadata and its absence say nothing
 * about who executes a route, so no execution identity is claimed here.
 * `runtime` is unused: no public runtime budget source exists for this view.
 */
import type {
  BudgetMetric,
  BudgetMetricKey,
  BudgetSource,
  ContextBudgetSnapshot,
} from '../contracts/budget.ts'
import type { ProjectionStatus } from './projections.ts'

/** One provider/model route. */
export interface RouteRef {
  readonly provider: string
  readonly model: string
}

/** Durable model-selection fold: what the last request used and what is pending. */
export interface SelectionObservation {
  readonly lastUsed: RouteRef | null
  readonly pending: RouteRef | null
}

/** Latest durable `request/header` facts. */
export interface RequestHeaderObservation {
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
}

/** Latest durable `request/context` route metadata. */
export interface RequestContextObservation {
  readonly provider: string
  readonly model: string
  readonly contextWindow?: number
}

/** Validated `contextPressure` wire view. */
export interface PressureObservation {
  readonly contextWindow?: number
  readonly pressureTokens?: number
  readonly projectedTokens?: number
}

/** Exact-route metadata answered by the registered adapter, already detached. */
export interface AdapterObservation {
  readonly contextWindow?: number
  readonly defaultMaxTokens?: number
}

/** What the official LLM service answered about the effective route. */
export interface RouteResolution {
  /** Exact-model metadata; null when no answer was obtained. */
  readonly adapter: AdapterObservation | null
  /** An attempted public read failed, so the fact is unknown rather than absent. */
  readonly failed: boolean
}

/** Nothing was resolved because the Session records no route yet. */
export const UNRESOLVED_ROUTE: RouteResolution = { adapter: null, failed: false }

/** The fixed metric key order of every snapshot. */
const METRIC_KEYS: readonly BudgetMetricKey[] = [
  'context-window',
  'request-output-limit',
  'declared-output-limit',
  'projected-input',
  'pressure',
  'compaction-threshold',
  'compaction-retain',
]

/** One snapshot input; every field is a raw public observation. */
export interface BudgetSnapshotInput {
  readonly sessionId: string
  readonly observedAt: string
  readonly selection: SelectionObservation | null
  readonly requestHeader: RequestHeaderObservation | null
  readonly requestContext: RequestContextObservation | null
  readonly pressure: PressureObservation | null
  readonly pressureStatus: ProjectionStatus
  readonly route: RouteResolution
  /** Whether the selection fold answered; `failed` means the route is unknown. */
  readonly selectionStatus?: ProjectionStatus
  /** The public reads moved under the observation and no coherent cut was reached. */
  readonly drifted?: boolean
}

/** One metric. */
function metric(key: BudgetMetricKey, value: number | null, source: BudgetSource): BudgetMetric {
  return { key, value, source }
}

/** Whether two routes name the same provider and model. */
function sameRoute(left: RouteRef, right: RouteRef): boolean {
  return left.provider === right.provider && left.model === right.model
}

/** A snapshot that claims nothing about the Session's route or budget. */
function unknownSnapshot(input: BudgetSnapshotInput): ContextBudgetSnapshot {
  return {
    sessionId: input.sessionId,
    observedAt: input.observedAt,
    execution: 'unknown',
    provider: null,
    model: null,
    metrics: METRIC_KEYS.map((key) => metric(key, null, 'unavailable')),
    warnings: ['policy-unknown', 'read-unavailable'],
  }
}

/**
 * Resolve the route the next request will use.
 *
 * The public model-selection fold wins: `pending` is a selection no request has
 * consumed yet, so it — not the last header — is the next route. Without the
 * fold, the latest `request/header` is the header the next request is compared
 * against.
 *
 * @param input - the three public route observations.
 * @returns the effective route (null when none is recorded).
 */
export function effectiveRoute(input: {
  selection: SelectionObservation | null
  requestHeader: RequestHeaderObservation | null
  requestContext: RequestContextObservation | null
}): { route: RouteRef | null } {
  const header = input.requestHeader
  const route =
    input.selection?.pending ??
    (header === null ? null : { provider: header.provider, model: header.model }) ??
    input.selection?.lastUsed ??
    (input.requestContext === null
      ? null
      : { provider: input.requestContext.provider, model: input.requestContext.model })
  return { route }
}

/**
 * Build the fixed-seven-key snapshot from public observations.
 * @param input - raw observations gathered by the service.
 * @returns the browser-safe snapshot; null always means unknown.
 */
export function buildBudgetSnapshot(input: BudgetSnapshotInput): ContextBudgetSnapshot {
  // A moved read, or an unreadable selection fold, means the current route is
  // not established: publish no route and no number, only the fixed diagnostic.
  if (input.drifted === true || input.selectionStatus === 'failed') return unknownSnapshot(input)

  const { route } = effectiveRoute(input)
  // Both durable records attribute their own numbers. A record that no longer
  // names the effective route makes its numbers unknown, never relabelled.
  const pressureRouteMatches =
    route !== null && input.requestContext !== null && sameRoute(route, input.requestContext)
  const headerMatchesRoute =
    route !== null && input.requestHeader !== null && sameRoute(route, input.requestHeader)
  const pressure = input.pressureStatus === 'read' && pressureRouteMatches ? input.pressure : null

  let contextWindow = metric('context-window', null, 'unavailable')
  if (pressure?.contextWindow !== undefined) {
    contextWindow = metric('context-window', pressure.contextWindow, 'session-projection')
  } else if (pressureRouteMatches && input.requestContext?.contextWindow !== undefined) {
    contextWindow = metric(
      'context-window',
      input.requestContext.contextWindow,
      'adapter-declaration',
    )
  } else if (input.route.adapter?.contextWindow !== undefined) {
    contextWindow = metric(
      'context-window',
      input.route.adapter.contextWindow,
      'adapter-declaration',
    )
  }

  const declaredOutputLimit =
    input.route.adapter?.defaultMaxTokens === undefined
      ? metric('declared-output-limit', null, 'unavailable')
      : metric('declared-output-limit', input.route.adapter.defaultMaxTokens, 'adapter-declaration')

  const requestOutputLimit = headerMatchesRoute
    ? metric('request-output-limit', input.requestHeader?.maxTokens ?? null, 'request-header')
    : metric('request-output-limit', null, 'unavailable')

  const projectedInput =
    pressure?.projectedTokens === undefined
      ? metric('projected-input', null, 'unavailable')
      : metric('projected-input', pressure.projectedTokens, 'session-projection')

  const pressureMetric =
    pressure?.pressureTokens === undefined
      ? metric('pressure', null, 'unavailable')
      : metric('pressure', pressure.pressureTokens, 'session-projection')

  // No public read exposes the effective compaction policy, and no source
  // default may be presented as the live one.
  const compactionThreshold = metric('compaction-threshold', null, 'unavailable')
  const compactionRetain = metric('compaction-retain', null, 'unavailable')

  const metrics: BudgetMetric[] = [
    contextWindow,
    requestOutputLimit,
    declaredOutputLimit,
    projectedInput,
    pressureMetric,
    compactionThreshold,
    compactionRetain,
  ]

  const declared = contextWindow.value !== null || declaredOutputLimit.value !== null
  const unattributed = route !== null && (!pressureRouteMatches || !headerMatchesRoute)

  const warnings: ContextBudgetSnapshot['warnings'] = []
  if (declared) warnings.push('declaration-only')
  warnings.push('policy-unknown')
  if (input.pressureStatus !== 'read' || input.route.failed || unattributed)
    warnings.push('read-unavailable')

  return {
    sessionId: input.sessionId,
    observedAt: input.observedAt,
    execution: 'unknown',
    provider: route?.provider ?? null,
    model: route?.model ?? null,
    metrics,
    warnings,
  }
}
