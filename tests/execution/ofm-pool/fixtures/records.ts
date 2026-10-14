import { vi } from 'vitest'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { ExternalModelSources } from '../../../../src/execution/host/model-sources.ts'
import {
  POOL_LAGUNA_S,
  POOL_LAGUNA_XS,
  POOL_HARNESS,
  POOL_PROVIDER,
} from '../../../../src/execution/host/adapters/pool/index.ts'
import type { ExternalModelRoute } from '../../../../src/execution/host/model-sources.ts'
import type { HarnessSession } from '../../../../src/execution/contracts/sessions.ts'
import type { ModelRef } from '../../../../src/execution/contracts/catalog.ts'

/** An effect scope that keeps the registration alive for the whole test. */
export const owner = { effect: (effect: () => () => void) => effect() } as unknown as Context

export const ctx = { credentials: { resolve: vi.fn() }, get: () => undefined } as unknown as Context

export const poolRef = (model: string): ModelRef => ({ provider: POOL_PROVIDER, model })

/** A resolved route as the shared registry validates it. */
export const route = (over: Partial<ExternalModelRoute> = {}): ExternalModelRoute => ({
  baseURL: 'https://ofm.example.test/v1',
  model: POOL_LAGUNA_S,
  apiKey: 'probe-key',
  protocol: 'chat',
  ...over,
})

/** A source that supports exactly the Poolside pairs and answers with `value`. */
export function poolSource(value: ExternalModelRoute = route()) {
  return {
    provider: POOL_PROVIDER,
    supports: (harness: string, ref: ModelRef) =>
      harness === POOL_HARNESS && ref.provider === POOL_PROVIDER && ref.model === value.model,
    resolve: async () => value,
  }
}

/** Registered sources, the way the execution engine hands them to an adapter. */
export function poolSources(...registered: ReturnType<typeof poolSource>[]): ExternalModelSources {
  const sources = new ExternalModelSources(ctx)
  for (const source of registered) sources.register(owner, source)
  return sources
}

export function poolRecord(over: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id: 'session-1',
    combination: `${POOL_PROVIDER}/${POOL_LAGUNA_S}`,
    harnessRef: POOL_HARNESS,
    modelRef: poolRef(POOL_LAGUNA_S),
    cwd: 'C:/work',
    acpSessionId: 'acp-1',
    origin: { kind: 'harness', sessionId: 'acp-1' },
    title: 'pool',
    sandbox: 'full-access',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    turns: [],
    ...over,
  } as HarnessSession
}

export { POOL_LAGUNA_S, POOL_LAGUNA_XS }

/**
 * Scratch root for adapter tests. Defaults to the host temp directory like the
 * rest of this suite's tests, and can be redirected with `OPL_POOL_TEST_TMP` so
 * an isolated run keeps every temporary file inside its own directory.
 */
export const scratchRoot = (): string => process.env.OPL_POOL_TEST_TMP ?? tmpdir()
