import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import * as executionPlugin from '../../src/suite/execution-plugin.ts'
import { Config } from '../../src/execution/host/plugin-config.ts'
import { MINIMAX_CODE_PROVIDER } from '../../src/execution/host/adapters/minimax.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

it('reads back config and the real provider consistently only after the MiniMax changed path', async () => {
  const registry = new Context()
  await registry.plugin(LlmRuntime)
  cleanups.push(() => registry.fiber.dispose())
  let enabled = true
  const base = Config({})
  const config = {
    ...base,
    minimaxCodeEnabled: { get: () => enabled },
  } as Config
  const synchronize = vi.fn(async () => {})
  const listeners: Array<(paths: readonly (readonly string[])[]) => void> = []
  const harness = {
    configureMiniMaxCodeIntegration: vi.fn(),
    synchronizeMiniMaxCodeIntegration: synchronize,
  }
  const ctx = {
    llm: registry.llm,
    logger: { warn: vi.fn() },
    settings: { configure: vi.fn() },
    effect: vi.fn(),
    on: vi.fn((event: string, listener: (paths: readonly (readonly string[])[]) => void) => {
      if (event === 'loader/volatile-update') listeners.push(listener)
    }),
    plugin: vi.fn(async (_plugin: unknown, options?: { minimaxCodeEnabled?: boolean }) => {
      if (options?.minimaxCodeEnabled === undefined) return
      // The outer context intentionally has no oplHarness property. The package
      // must consume the child runtime instead of bypassing Cordis injection.
      return { ctx: { get: (name: string) => (name === 'oplHarness' ? harness : undefined) } }
    }),
  } as unknown as Context

  await executionPlugin.apply(ctx, config)
  expect(config.minimaxCodeEnabled.get()).toBe(true)
  expect(registry.llm.listProviders().map((item) => item.id)).toEqual([MINIMAX_CODE_PROVIDER])
  expect(synchronize).toHaveBeenCalledTimes(1)
  expect(listeners).toHaveLength(1)

  enabled = false
  listeners[0]!([['executionLimits'], ['toolAutoReview']])
  expect(registry.llm.listProviders().map((item) => item.id)).toEqual([MINIMAX_CODE_PROVIDER])
  expect(synchronize).toHaveBeenCalledTimes(1)
  listeners[0]!([['minimaxCodeEnabled']])
  expect(config.minimaxCodeEnabled.get()).toBe(false)
  expect(registry.llm.listProviders()).toEqual([])
  expect(synchronize).toHaveBeenCalledTimes(2)

  enabled = true
  listeners[0]!([['minimaxCodeEnabled']])
  expect(config.minimaxCodeEnabled.get()).toBe(true)
  expect(registry.llm.listProviders().map((item) => item.id)).toEqual([MINIMAX_CODE_PROVIDER])
  expect(synchronize).toHaveBeenCalledTimes(3)
})
