import { describe, expect, it } from 'vitest'
import { Config, executionLimitsSchema } from '../../src/suite/config.ts'

describe('execution progress limits', () => {
  it('supplies bounded defaults and preserves partial deployment overrides', () => {
    expect(Config({}).executionLimits).toEqual({
      firstProgressMs: 90_000,
      idleProgressMs: 90_000,
      totalMs: 1_800_000,
    })
    expect(Config({ executionLimits: { totalMs: 3_600_000 } }).executionLimits).toEqual({
      firstProgressMs: 90_000,
      idleProgressMs: 90_000,
      totalMs: 3_600_000,
    })
  })

  it('resolves shared defaults and accepts the timer limit', () => {
    expect(executionLimitsSchema({})).toEqual(Config({}).executionLimits)
    expect(executionLimitsSchema({ totalMs: 2_147_483_647 }).totalMs).toBe(2_147_483_647)
  })

  for (const field of ['firstProgressMs', 'idleProgressMs', 'totalMs']) {
    it.each([0, -1, 0.5, 2_147_483_648, NaN, Infinity, -Infinity, '90000'])(
      `rejects invalid ${field}: %s`,
      (value) => {
        expect(() => Config({ executionLimits: { [field]: value } })).toThrow()
      },
    )
  }
})
