import type { HarnessSession } from '../../../../src/execution/contracts/sessions.ts'
import type { ModelRef } from '../../../../src/execution/contracts/catalog.ts'

/**
 * Build a fully typed `HarnessSession` for the StepCode harness.
 *
 * The adapter interface takes the real session contract, so the fixture satisfies it in
 * full rather than passing a partial object and casting at every call site.
 */
export function stepRecord(
  modelRef: ModelRef,
  overrides: Partial<HarnessSession> = {},
): HarnessSession {
  return {
    id: 's1',
    combination: `step-code/${modelRef.model}`,
    harnessRef: 'step-code',
    modelRef,
    cwd: 'C:/work',
    acpSessionId: '',
    origin: { kind: 'harness', sessionId: 'official-session' },
    title: 'step fixture',
    sandbox: 'full-access',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    turns: [],
    ...overrides,
  }
}

/**
 * A model-source registry stand-in that records what it was asked.
 *
 * The shared `ExternalModelSources` is exercised directly in the source spec; this fake
 * exists for the adapter spec, whose job is to prove the adapter pins the *protocol* it
 * declares and refuses a route that disagrees — not to re-test the shared registry.
 */
export interface FakeSources {
  resolve(
    harness: string,
    ref: ModelRef,
    protocol: string,
  ): Promise<{
    baseURL: string
    model: string
    apiKey: string
    protocol: string
  }>
  lease(harness: string, ref: ModelRef): { assertCurrent(): void }
  /** Every protocol the adapter asked about, in order. */
  readonly asked: string[]
  /** Replace the answer the next call returns. */
  answer(next: Partial<{ baseURL: string; model: string; apiKey: string; protocol: string }>): void
}

export function fakeSources(initial: {
  baseURL?: string
  model: string
  apiKey?: string
  protocol?: string
}): FakeSources {
  const asked: string[] = []
  let answer = {
    baseURL: initial.baseURL ?? 'https://models.example.test/v1',
    model: initial.model,
    apiKey: initial.apiKey ?? 'source-owned-key',
    protocol: initial.protocol ?? 'chat',
  }
  let live = true
  return {
    asked,
    answer(next) {
      answer = { ...answer, ...next }
    },
    lease() {
      return {
        assertCurrent() {
          // Mirrors the real registry: a lease stops being current once the owner is
          // revoked, and a re-registration invalidates the previous lease too.
          if (!live) throw Error('模型来源已变更，请重新选择')
        },
      }
    },
    /** Revoke the owner, as unloading its effect scope would. */
    revoke() {
      live = false
    },
    async resolve(_harness, _ref, protocol) {
      asked.push(protocol)
      return { ...answer }
    },
  }
}
