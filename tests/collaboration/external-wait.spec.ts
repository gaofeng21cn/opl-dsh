import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { HarnessService } from '../../src/execution/host/harness.ts'
const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  wait: vi.fn(async () => ({ turn: 1, outcome: { kind: 'completed' } })),
}))
vi.mock('../../src/shared/host/control-bridge.ts', () => ({ startControlBridge: mocks.start }))
vi.mock('../../src/execution/host/session-wait.ts', () => ({ waitForSession: mocks.wait }))
import { installExternalCodex } from '../../src/collaboration/host/external-codex.ts'

it('accepts both official helper and legacy control CLI wait arguments without forwarding to a missing Remote', async () => {
  const gateway = { invoke: vi.fn(), stream: vi.fn() }
  const ctx = { typertGateway: gateway, effect: (action: () => unknown) => action() }
  const harness = { cooperationSettings: () => ({ externalCodex: true }) }
  installExternalCodex(ctx as unknown as Context, harness as unknown as HarnessService)
  const bridge = mocks.start.mock.calls.at(-1)![0] as Pick<TypertGateway, 'invoke'>
  for (const args of [{ sessionId: 's1', turn: 1 }, { request: { sessionId: 's1', turn: 1 } }]) {
    expect(await bridge.invoke({ namespace: 'session', method: 'wait', args })).toEqual({
      turn: 1,
      outcome: { kind: 'completed' },
    })
  }
  expect(mocks.wait).toHaveBeenCalledTimes(2)
  expect(mocks.wait).toHaveBeenLastCalledWith(
    ctx,
    { sessionId: 's1', turn: 1 },
    expect.any(AbortSignal),
  )
  for (const args of [{ request: {} }, { request: { sessionId: 's1', turn: -1 } }]) {
    await expect(bridge.invoke({ namespace: 'session', method: 'wait', args })).rejects.toThrow(
      'session.wait requires',
    )
  }
  expect(gateway.invoke).not.toHaveBeenCalled()
})
