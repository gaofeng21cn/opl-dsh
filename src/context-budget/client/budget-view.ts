/**
 * Pure projection of a {@link ContextBudgetSnapshot} into display facts: total
 * functions only, so absent keys, null values, non-finite numbers, and
 * duplicated keys are decided in one place.
 *
 * Unit contract: every {@link BudgetMetricKey} is an absolute token count — the
 * official `contextPressure` fields (`projectedTokens`, `pressureTokens`,
 * `contextWindow`) are counts that the official composer meter later divides,
 * and the shared DTO documents {@link BudgetMetric} as a token-count
 * observation. This view therefore derives no ratio: nothing is shown as a
 * percentage.
 */
import type {
  BudgetMetric,
  BudgetMetricKey,
  BudgetSource,
  ContextBudgetSnapshot,
} from '../contracts/budget.ts'
import type { BudgetLocaleKey } from './locales.ts'

/** Display order of every observation key: capacities, then occupancy, then policy. */
export const METRIC_ORDER = [
  'context-window',
  'request-output-limit',
  'declared-output-limit',
  'projected-input',
  'pressure',
  'compaction-threshold',
  'compaction-retain',
] as const satisfies readonly BudgetMetricKey[]

/** Every source label the panel can render, in display order. */
export const SOURCE_ORDER = [
  'adapter-declaration',
  'request-header',
  'session-projection',
  'runtime',
  'unavailable',
] as const satisfies readonly BudgetSource[]

/** Fixed warning vocabulary, in display order. */
export const WARNING_ORDER = [
  'declaration-only',
  'harness-managed',
  'policy-unknown',
  'read-unavailable',
] as const satisfies readonly ContextBudgetSnapshot['warnings'][number][]

/** One dictionary key per observation. */
export const METRIC_LABEL_KEY: Record<BudgetMetricKey, BudgetLocaleKey> = {
  'context-window': 'metric.context-window',
  'request-output-limit': 'metric.request-output-limit',
  'declared-output-limit': 'metric.declared-output-limit',
  'projected-input': 'metric.projected-input',
  pressure: 'metric.pressure',
  'compaction-threshold': 'metric.compaction-threshold',
  'compaction-retain': 'metric.compaction-retain',
}

/** One dictionary key per source label. */
export const SOURCE_LABEL_KEY: Record<BudgetSource, BudgetLocaleKey> = {
  'adapter-declaration': 'source.adapter-declaration',
  'request-header': 'source.request-header',
  'session-projection': 'source.session-projection',
  runtime: 'source.runtime',
  unavailable: 'source.unavailable',
}

/** One dictionary key per fixed warning; the panel never invents a warning absent from the snapshot. */
export const WARNING_LABEL_KEY: Record<ContextBudgetSnapshot['warnings'][number], BudgetLocaleKey> =
  {
    'declaration-only': 'warning.declaration-only',
    'harness-managed': 'warning.harness-managed',
    'policy-unknown': 'warning.policy-unknown',
    'read-unavailable': 'warning.read-unavailable',
  }

/**
 * Format one absolute token count.
 *
 * `null`, `undefined`, and non-finite numbers have no renderable value and
 * yield `undefined` (the caller shows the unknown wording). An integer is
 * grouped with thousands separators; a fractional value keeps one decimal
 * place; a negative value keeps its sign.
 * @param value - raw observation.
 * @returns grouped token text, or undefined when nothing renderable exists.
 */
export function formatTokenCount(value: number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  if (!Number.isFinite(value)) return undefined
  if (!Number.isInteger(value)) return String(Math.round(value * 10) / 10)
  const text = String(value)
  const negative = text.startsWith('-')
  const digits = negative ? text.slice(1) : text
  return (negative ? '-' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
}

/**
 * Index a snapshot's metrics by key.
 *
 * A malformed payload (missing or non-array `metrics`) reads as "nothing
 * provided" instead of throwing inside render, and the first occurrence of a
 * duplicated key wins so one snapshot always projects to one stable row set.
 * @param snapshot - Host-computed snapshot.
 * @returns provided metrics by key.
 */
export function metricsByKey(
  snapshot: ContextBudgetSnapshot,
): ReadonlyMap<BudgetMetricKey, BudgetMetric> {
  const index = new Map<BudgetMetricKey, BudgetMetric>()
  const metrics = (snapshot as { metrics?: unknown }).metrics
  if (!Array.isArray(metrics)) return index
  for (const metric of metrics as readonly BudgetMetric[]) {
    if (metric === null || typeof metric !== 'object') continue
    if (!METRIC_ORDER.includes(metric.key)) continue
    if (index.has(metric.key)) continue
    index.set(metric.key, metric)
  }
  return index
}

/**
 * Whether a snapshot carries at least one renderable number, which separates
 * "answered, but this snapshot shows no figure" from "answered with data".
 * @param snapshot - Host-computed snapshot.
 * @returns whether any metric has a renderable value.
 */
export function hasObservation(snapshot: ContextBudgetSnapshot | undefined): boolean {
  if (!snapshot) return false
  for (const metric of metricsByKey(snapshot).values()) {
    if (formatTokenCount(metric.value) !== undefined) return true
  }
  return false
}

/**
 * Select the locale key of the execution mode wording.
 * @param execution - snapshot execution mode.
 * @returns dictionary key for the mode.
 */
export function executionLabelKey(execution: ContextBudgetSnapshot['execution']): BudgetLocaleKey {
  if (execution === 'native') return 'executionNative'
  if (execution === 'harness') return 'executionHarness'
  return 'executionUnknown'
}

/** One row of the source table: the warning key plus its label key. */
export interface BudgetWarningRow {
  key: ContextBudgetSnapshot['warnings'][number]
  labelKey: BudgetLocaleKey
}

/**
 * Map the snapshot's warnings onto the fixed vocabulary, in display order.
 *
 * Values outside the declared vocabulary are dropped: the panel renders fixed
 * sentences only, so an unexpected string can never reach the UI as prose.
 * @param snapshot - Host-computed snapshot.
 * @returns mapped warning rows.
 */
export function warningRows(snapshot: ContextBudgetSnapshot): readonly BudgetWarningRow[] {
  const warned = (snapshot as { warnings?: unknown }).warnings
  if (!Array.isArray(warned)) return []
  const present = new Set(warned as readonly string[])
  return WARNING_ORDER.filter((key) => present.has(key)).map((key) => ({
    key,
    labelKey: WARNING_LABEL_KEY[key],
  }))
}
