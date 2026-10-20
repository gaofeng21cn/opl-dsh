import { describe, expect, it } from 'vitest'
import {
  coerceServiceConfig,
  configFromPreferences,
  normalizePreferences,
  preferencesFromConfig,
  revisionOf,
} from '../../src/auto-review/host/settings.ts'

describe('Auto Review decision-model settings', () => {
  it('migrates a previously selected StartLux route into the decision-model mode', () => {
    const config = coerceServiceConfig({
      reviewerProvider: 'bamboo-startlux',
      reviewerModel: 'startlux-decision-27b-autothink',
    })

    expect(preferencesFromConfig(config).reviewer).toEqual({
      mode: 'decision',
      route: {
        provider: 'bamboo-startlux',
        model: 'startlux-decision-27b-autothink',
      },
    })
  })

  it('round-trips and revisions decision-model selections independently', () => {
    const decision = normalizePreferences({
      enabled: false,
      reviewer: {
        mode: 'decision',
        route: {
          provider: 'bamboo-startlux',
          model: 'startlux-decision-27b-autothink',
        },
      },
      timeoutMs: 30000,
      maxOutputTokens: 4096,
    })
    const config = configFromPreferences(decision)

    expect(config.reviewerKind).toBe('decision')
    expect(preferencesFromConfig(config)).toEqual(decision)
    expect(revisionOf({ ...decision, reviewer: { mode: 'current' } })).not.toBe(
      revisionOf(decision),
    )
  })

  it('keeps legacy non-StartLux fixed routes in the reviewer category', () => {
    const config = coerceServiceConfig({
      reviewerProvider: 'deepseek',
      reviewerModel: 'deepseek-v4',
    })

    expect(preferencesFromConfig(config).reviewer.mode).toBe('fixed')
  })
})
