import { describe, expect, it } from 'vitest'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import {
  Config,
  DEFAULT_API_KEY_REF,
  DEFAULT_MODELS,
  toAdapterConfig,
} from '../../src/gateway/host/config.ts'

describe('gateway catalog', () => {
  it('advertises the one gateway model under its deployment name', () => {
    expect(DEFAULT_MODELS).toHaveLength(1)
    expect(DEFAULT_MODELS[0]).toMatchObject({
      id: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      systemPromptUpdate: 'in-history',
    })
  })
})

describe('gateway settings section', () => {
  it('starts on the gateway protocol, catalog, and credential reference', () => {
    const resolved = Config({})
    expect(resolved.apiKeyEnv).toBe(DEFAULT_API_KEY_REF)
    expect(resolved.models).toEqual(DEFAULT_MODELS)
    expect(resolved.reasoningEffort).toBe('max')
    // No endpoint is stored, so the account binding can supply the one this
    // key was issued against.
    expect(resolved.baseURL).toBeUndefined()
  })

  it('lets the account binding choose the endpoint until one is configured', () => {
    expect(toAdapterConfig({})).toMatchObject({ baseURL: 'https://gateway.medopl.com/v1' })
    expect(toAdapterConfig({}, 'https://bound.example/v1')).toMatchObject({
      baseURL: 'https://bound.example/v1',
    })
    expect(
      toAdapterConfig({ baseURL: ' https://typed.example/v1 ' }, 'https://bound.example/v1'),
    ).toMatchObject({ baseURL: 'https://typed.example/v1' })
  })

  it('carries only the fields the DeepSeek adapter accepts', () => {
    const adapter = toAdapterConfig({
      apiKeyEnv: ' CUSTOM_REF ',
      baseURL: ' https://example.test/v1 ',
    })
    expect(adapter).toMatchObject({
      apiKeyEnv: 'CUSTOM_REF',
      baseURL: 'https://example.test/v1',
    })
    // Unset settings must not shadow the adapter's own defaults.
    expect(adapter).not.toHaveProperty('models')
    expect(adapter).not.toHaveProperty('thinking')
    expect(adapter.retryPolicy?.mode).toBe('normal')
  })

  it('drops blank overrides instead of forwarding them', () => {
    const adapter = toAdapterConfig({ apiKeyEnv: '   ', baseURL: '' }, 'https://bound.example/v1')
    expect(adapter).not.toHaveProperty('apiKeyEnv')
    expect(adapter).toMatchObject({ baseURL: 'https://bound.example/v1' })
  })

  it('recovers truncated streams within the official normal retry limits', () => {
    const official = resolveRetryPolicy(undefined, 'test')
    const raw = resolveAdapterOptions(toAdapterConfig({}), new Map()).retryPolicy
    const settings = resolveAdapterOptions(toAdapterConfig(Config({})), new Map()).retryPolicy
    expect(raw).toEqual(settings)
    expect(raw.mode).toBe('normal')
    expect(official.mode).toBe('normal')
    if (raw.mode !== 'normal' || official.mode !== 'normal') throw Error('Expected normal retry')
    expect(raw.retryableCodes).toEqual([...official.retryableCodes, 'STREAM_CLOSED'])
    expect(raw.maxRetries).toBe(official.maxRetries)
    expect(raw.initialDelayMs).toBe(official.initialDelayMs)
    expect(raw.maxDelayMs).toBe(official.maxDelayMs)
    expect(raw.jitterRatio).toBe(official.jitterRatio)
    expect(raw.retryableCodes).not.toContain('INVALID_REQUEST')
    expect(raw.retryableCodes).not.toContain('ABORTED')
  })

  it('preserves explicit disabled, limited and always policies', () => {
    const policies: RetryPolicyConfig[] = [
      { mode: 'normal', maxRetries: 0, retryableCodes: ['TRANSPORT'] },
      { mode: 'normal', maxRetries: 2, retryableCodes: ['STREAM_CLOSED'] },
      { mode: 'always', backoff: { initialDelayMs: 100, maxDelayMs: 200, jitterRatio: 0 } },
    ]
    for (const policy of policies) {
      const configured = structuredClone(policy)
      expect(toAdapterConfig({ retryPolicy: configured }).retryPolicy).toBe(configured)
      expect(
        resolveAdapterOptions(toAdapterConfig({ retryPolicy: configured }), new Map()).retryPolicy,
      ).toEqual(resolveRetryPolicy(configured, 'test'))
    }
  })
})
