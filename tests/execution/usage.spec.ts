import { describe, expect, it } from 'vitest'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import { latestHarnessContext } from '../../src/execution/host/usage.ts'

function record(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id: 'external-a',
    combination: 'pi/model-a',
    harnessRef: 'pi',
    modelRef: { provider: 'ofm', model: 'model-a' },
    cwd: 'C:/work',
    acpSessionId: 'acp-a',
    nativeSessionId: 'session-a',
    origin: { kind: 'dsh', sessionId: 'session-a' },
    title: 'Test',
    sandbox: 'full-access',
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:01.000Z',
    turns: [
      {
        operationId: 'turn-a',
        fingerprint: 'fingerprint',
        prompt: 'prompt',
        text: 'answer',
        state: 'completed',
        tools: [],
        contextUsage: { used: 900, size: 1000, estimated: true },
      },
    ],
    ...overrides,
  }
}

describe('latest external context observation', () => {
  it('returns a completed exact route and keeps context separate from token usage', () => {
    expect(latestHarnessContext([record()], 'session-a', 'pi/model-a')).toMatchObject({
      harness: 'pi',
      provider: 'ofm',
      model: 'model-a',
      operationId: 'turn-a',
      contextUsage: { used: 900, size: 1000, estimated: true },
    })
  })

  it('hides a reading after a route switch, during a live turn, or when combinations are ambiguous', () => {
    expect(latestHarnessContext([record()], 'session-a', 'kimi/model-b')).toBeNull()
    expect(
      latestHarnessContext(
        [record({ turns: [{ ...record().turns[0]!, state: 'running' }] })],
        'session-a',
        'pi/model-a',
      ),
    ).toBeNull()
    expect(
      latestHarnessContext([record(), record({ id: 'external-b' })], 'session-a', undefined),
    ).toBeNull()
  })

  it('preserves a context-only Harness without inventing billing counters', () => {
    const reading = latestHarnessContext([record()], 'session-a', 'pi/model-a')
    expect(reading?.usage).toBeUndefined()
    expect(reading?.contextUsage.used).toBe(900)
  })
})
