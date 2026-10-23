/** Execution deadlines used by native and external model turns. */
import z from '@deepseek-ai/schemastery'

export interface ExecutionLimits {
  firstProgressMs: number
  idleProgressMs: number
  totalMs: number
}

/** Validated execution deadlines within the Node timer range. */
export const executionLimitsSchema = z
  .object({
    firstProgressMs: z
      .number()
      .step(1)
      .min(1)
      .max(2_147_483_647)
      .default(90_000)
      .description('首次进展等待上限（毫秒）'),
    idleProgressMs: z
      .number()
      .step(1)
      .min(1)
      .max(2_147_483_647)
      .default(90_000)
      .description('连续无进展等待上限（毫秒）'),
    totalMs: z
      .number()
      .step(1)
      .min(1)
      .max(2_147_483_647)
      .default(1_800_000)
      .description('单轮执行总时长上限（毫秒）'),
  })
  .default({})
