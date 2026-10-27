import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** Latest context observation from the selected external Harness. Missing fields stay unknown. */
export interface HarnessContextUsage {
  used?: number
  size?: number
  /** The Harness estimates occupancy rather than reporting an exact provider count. */
  estimated?: boolean
}

/** Turn billing and context occupancy are independent observations. */
export interface HarnessStatistics {
  usage?: TokenUsage
  contextUsage?: HarnessContextUsage
}

/** Small completed-context read for one ordinary DSH Session. */
export interface HarnessContextReading {
  harness: string
  provider: string
  model: string
  operationId: string
  usage?: TokenUsage
  contextUsage: HarnessContextUsage
}
