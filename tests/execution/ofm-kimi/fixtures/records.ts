import type { HarnessSession } from '../../../../src/execution/contracts/sessions.ts'
import type { ModelRef } from '../../../../src/execution/contracts/catalog.ts'

/**
 * Build a fully typed `HarnessSession` for this harness.
 *
 * The adapter interface takes the real session contract, so the fixtures satisfy it in
 * full rather than passing a partial object and relying on a cast at every call site.
 */
export function kimiRecord(
  modelRef: ModelRef,
  overrides: Partial<HarnessSession> = {},
): HarnessSession {
  return {
    id: 'h1',
    combination: `kimi-code/${modelRef.model}`,
    harnessRef: 'kimi-code',
    modelRef,
    cwd: 'C:/work',
    acpSessionId: '',
    origin: { kind: 'harness', sessionId: 'official-session' },
    title: 'kimi fixture',
    sandbox: 'read-only',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    turns: [],
    ...overrides,
  }
}
