import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { invokeHostRemote } from '../../src/compat/host/remote-invocation.ts'

describe('official in-process Remote Peer', () => {
  const request = { namespace: 'session', method: 'create', args: { request: {} } }
  function fixture(connection: object | undefined, invocation?: object) {
    const invoke = vi.fn(async (request) => request)
    const ctx = {
      get: (name: string) => (name === 'invocation' ? invocation : connection),
      typertGateway: { invoke },
    } as unknown as Context
    return { ctx, invoke }
  }
  it('reuses a Context-owned official Peer for background calls', async () => {
    const peer = { id: 'owned' }
    const createPeer = vi.fn(() => peer)
    const { ctx, invoke } = fixture({ createPeer })
    await invokeHostRemote(ctx, request)
    await invokeHostRemote(ctx, request)
    expect(createPeer).toHaveBeenCalledOnce()
    expect(createPeer).toHaveBeenCalledWith({ principal: { kind: 'owner' } })
    expect(invoke).toHaveBeenLastCalledWith({ ...request, peer })
  })
  it('forwards an admitted caller without replacing its identity', async () => {
    const peer = { id: 'restricted', principal: { kind: 'restricted' } }
    const createPeer = vi.fn()
    const { ctx, invoke } = fixture({ createPeer }, { peer })
    await invokeHostRemote(ctx, request)
    expect(createPeer).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith({ ...request, peer })
  })
  it('keeps the legacy implicit operator call on older Desktop', async () => {
    const { ctx, invoke } = fixture({})
    await invokeHostRemote(ctx, request)
    expect(invoke).toHaveBeenCalledWith(request)
  })
})
