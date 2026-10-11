/** Browser-safe observations; missing values are never replaced with policy defaults. */
export type BudgetSource =
  | 'adapter-declaration'
  | 'request-header'
  | 'session-projection'
  | 'runtime'
  | 'unavailable'

/** Stable display keys for capacity, request and current pressure observations. */
export type BudgetMetricKey =
  | 'context-window'
  | 'request-output-limit'
  | 'declared-output-limit'
  | 'projected-input'
  | 'pressure'
  | 'compaction-threshold'
  | 'compaction-retain'

/** One token-count observation and its source; null denotes an unknown value. */
export interface BudgetMetric {
  key: BudgetMetricKey
  value: number | null
  source: BudgetSource
}

/** Read-only view of one Session; declarations do not certify server capacity. */
export interface ContextBudgetSnapshot {
  sessionId: string
  observedAt: string
  execution: 'native' | 'harness' | 'unknown'
  provider: string | null
  model: string | null
  metrics: BudgetMetric[]
  warnings: Array<'declaration-only' | 'harness-managed' | 'policy-unknown' | 'read-unavailable'>
}

/** The public Session whose budget observations are requested. */
export interface ContextBudgetRequest {
  sessionId: string
}
