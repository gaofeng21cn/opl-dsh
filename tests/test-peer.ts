import type { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'

const lifetime = new AbortController()

/** A structurally valid Peer for Host tests that use a minimal Context and fake Gateway. */
export const testPeer: PeerScope = {
  id: 'opl-test-owner' as PeerScope['id'],
  ctx: {} as Context,
  principal: { kind: 'owner' },
  signal: lifetime.signal,
  interactions: 'none',
  dispose: async () => {},
}

/** The official factory shape injected by the connection service. */
export const testPeerConnection = {
  createPeer: (): PeerScope => testPeer,
}
