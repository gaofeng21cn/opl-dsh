/** Carry the official Peer identity through in-process Remote calls. */
import type { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'

type Request = Parameters<Context['typertGateway']['invoke']>[0]
type PeerConnection = {
  createPeer?: (options: { principal: { kind: 'owner' } }) => PeerScope
}
const localPeers = new WeakMap<Context, PeerScope>()

/**
 * Preserve a forwarded caller or acquire a Context-owned official local Peer.
 * Older Desktop releases retain their implicit in-process operator identity.
 * @param ctx - Context owning the invocation and local Peer lifetime.
 * @param request - Exact Remote method and arguments.
 * @returns the official Gateway result.
 */
export function invokeHostRemote(ctx: Context, request: Request): Promise<unknown> {
  let peer = request.peer ?? ctx.get('invocation')?.peer
  if (!peer) {
    peer = localPeers.get(ctx)
    if (!peer) {
      const connection = ctx.get('connection') as PeerConnection | undefined
      if (connection?.createPeer) {
        peer = connection.createPeer({ principal: { kind: 'owner' } })
        localPeers.set(ctx, peer)
      }
    }
  }
  return ctx.typertGateway.invoke({ ...request, ...(peer ? { peer } : {}) })
}
