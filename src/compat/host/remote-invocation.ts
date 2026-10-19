/** Carry the official Peer identity through in-process Remote calls. */
import type { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'

type Request = Parameters<Context['typertGateway']['invoke']>[0]
type RequestWithoutPeer = Omit<Request, 'peer'>
type PeerConnection = {
  createPeer?: (options: { principal: { kind: 'owner' } }) => PeerScope
}
const localPeers = new WeakMap<Context, PeerScope>()

/**
 * Preserve a forwarded caller or acquire a Context-owned official local Peer.
 * @param ctx - Context owning the invocation and local Peer lifetime.
 * @param request - Exact Remote method and arguments.
 * @returns the official Gateway result.
 */
export async function invokeHostRemote(
  ctx: Context,
  request: RequestWithoutPeer,
): Promise<unknown> {
  return ctx.typertGateway.invoke(withHostPeer(ctx, request))
}

/** Open a Remote stream with the same official caller identity as ordinary calls.
 * @param ctx - Context owning the invocation and local Peer lifetime.
 * @param request - Exact streaming Remote method and arguments.
 * @returns the official Gateway stream.
 */
export async function streamHostRemote(
  ctx: Context,
  request: RequestWithoutPeer,
): Promise<AsyncIterable<unknown>> {
  return ctx.typertGateway.stream(withHostPeer(ctx, request))
}

/**
 * Return the Peer this Host Context may speak as for an in-process Remote call.
 * @param ctx - Context owning the invocation and local Peer lifetime.
 * @returns a forwarded caller Peer, or the Context-owned owner Peer.
 */
export function hostPeer(ctx: Context): PeerScope {
  const read = (name: string): unknown =>
    typeof ctx.get === 'function' ? ctx.get(name) : undefined
  let peer = (read('invocation') as { peer?: PeerScope } | undefined)?.peer
  if (!peer) {
    peer = localPeers.get(ctx)
    if (!peer) {
      const connection = (read('connection') ??
        (ctx as Context & { connection?: PeerConnection }).connection) as PeerConnection | undefined
      if (connection?.createPeer) {
        peer = connection.createPeer({ principal: { kind: 'owner' } })
        localPeers.set(ctx, peer)
      }
    }
  }
  if (!peer) throw Error('官方 Remote Peer 尚未就绪')
  return peer
}

function withHostPeer(ctx: Context, request: RequestWithoutPeer): Request {
  return { ...request, peer: hostPeer(ctx) }
}
