import { describe, expect, it } from 'vitest'
import { remoteCall } from '../../src/shared/client/remote-call.ts'

describe('client Remote calls', () => {
  it('keeps the Remote method bound to its namespace', async () => {
    const namespace = {
      signal: new AbortController().signal,
      refresh(this: { signal: AbortSignal }) {
        return Promise.resolve({ ok: true as const, value: this.signal.aborted })
      },
    }

    expect(await remoteCall(namespace)('refresh')).toBe(false)
  })
})
