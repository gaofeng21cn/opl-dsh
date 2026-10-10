import { describe, expect, it, vi } from 'vitest'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import { grokAdapter } from '../../src/execution/host/adapters/grok.ts'
import { modelDefaultEffort } from '../../src/shared/model-reasoning.ts'

const options = (value: string) => [
  {
    id: 'reasoning_effort',
    type: 'select',
    currentValue: value,
    options: ['low', 'medium', 'high', 'xhigh'].map((value) => ({ value, name: value })),
  },
]
const record = (effort?: string) =>
  ({ acpSessionId: 'grok-session', reasoningEffort: effort }) as HarnessSession

describe('Grok official ACP reasoning', () => {
  it.each(['low', 'medium', 'high', 'xhigh'])(
    'writes and reads back %s without sending a prompt',
    async (effort) => {
      const request = vi.fn(async () => ({ configOptions: options(effort) }))
      const result = await grokAdapter.configureSession!({ request }, record(effort), {
        agent: {},
        session: {},
        configOptions: options(effort === 'high' ? 'low' : 'high'),
      })
      expect(request).toHaveBeenCalledExactlyOnceWith('session/set_config_option', {
        sessionId: 'grok-session',
        configId: 'reasoning_effort',
        value: effort,
      })
      expect(result).toEqual({ configOptions: options(effort) })
    },
  )
  it('retains the concrete high default without writing an unchanged choice', async () => {
    const request = vi.fn()
    await grokAdapter.configureSession!({ request }, record(), {
      agent: {},
      session: {},
      configOptions: options('high'),
    })
    expect(request).not.toHaveBeenCalled()
  })
  it.each(['max', 'default', 'ultra', 'off'])(
    'rejects unsupported %s before ACP writes',
    async (effort) => {
      const request = vi.fn()
      await expect(
        grokAdapter.configureSession!({ request }, record(effort), {
          agent: {},
          session: {},
          configOptions: options('high'),
        }),
      ).rejects.toThrow('不支持')
      expect(request).not.toHaveBeenCalled()
    },
  )
  it('refuses a CLI that omits the requested option or returns another value', async () => {
    const request = vi.fn(async () => ({ configOptions: options('low') }))
    await expect(
      grokAdapter.configureSession!({ request }, record('xhigh'), {
        agent: {},
        session: {},
        configOptions: [],
      }),
    ).rejects.toThrow('未提供')
    expect(request).not.toHaveBeenCalled()
    await expect(
      grokAdapter.configureSession!({ request }, record('xhigh'), {
        agent: {},
        session: {},
        configOptions: options('high'),
      }),
    ).rejects.toThrow('回读不一致')
  })
})

describe('Flash defaults across channels', () => {
  it.each(['deepseek-flash', 'codex::deepseek-flash'])(
    'defaults %s to high while leaving other models unchanged',
    (model) => {
      const reasoning = { defaultEffort: 'max', efforts: [{ id: 'high' }, { id: 'max' }] }
      expect(modelDefaultEffort(model, reasoning)).toBe('high')
      expect(modelDefaultEffort('deepseek-v4-pro', reasoning)).toBe('max')
    },
  )
  it('does not invent high when thinking is disabled or the provider omits it', () => {
    expect(
      modelDefaultEffort('deepseek-flash', { defaultEffort: 'off', efforts: [{ id: 'off' }] }),
    ).toBe('off')
    expect(modelDefaultEffort('deepseek-flash', undefined)).toBeUndefined()
  })
  it.each(['gpt-6-astra', 'codex::gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'])(
    'defaults %s to medium when supported',
    (model) => {
      expect(
        modelDefaultEffort(model, {
          defaultEffort: 'low',
          efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'max' }],
        }),
      ).toBe('medium')
      expect(
        modelDefaultEffort(model, {
          defaultEffort: 'low',
          efforts: [{ id: 'low' }],
        }),
      ).toBe('low')
    },
  )
})
