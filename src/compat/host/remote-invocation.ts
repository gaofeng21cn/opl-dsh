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
  return ctx.typertGateway.invoke(withHostPeer(ctx, request))
}

/** Open a Remote stream with the same official caller identity as ordinary calls.
 * @param ctx - Context owning the invocation and local Peer lifetime.
 * @param request - Exact streaming Remote method and arguments.
 * @returns the official Gateway stream.
 */
export function streamHostRemote(ctx: Context, request: Request): Promise<AsyncIterable<unknown>> {
  return ctx.typertGateway.stream(withHostPeer(ctx, request))
}

function withHostPeer(ctx: Context, request: Request): Request {
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
  return { ...request, ...(peer ? { peer } : {}) }
}
