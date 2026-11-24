/** Loopback credential relay for the Our Free Model route.
 *
 * Deliberately not a proxy. It binds `127.0.0.1` on an ephemeral port, accepts the
 * per-session ticket the official CLI carries in a provider-config header, and
 * forwards only to the one upstream origin the model-source owner published for this
 * launch. The OFM key is obtained through `getApiKey`, held in memory, and written
 * onto the wire in place of a fixed non-secret placeholder; it is never placed in a
 * file, an argument vector, an environment variable or a log.
 *
 * What this relay does *not* do is decide anything about the upstream. It does not
 * invent a path, a model or an endpoint: the owner publishes `baseUrl`, this relay
 * preserves that base URL's path prefix verbatim, and the official CLI appends its
 * own request path. Guessing a route shape here would be the failure this suite
 * forbids, so the path is passed through instead of assumed.
 *
 * @module zcode-ofm/zcode-ofm-relay
 */

import { Agent, request as httpRequest } from 'node:http'
import {
  assertLoopbackOrigin,
  readBoundedBody,
  startLoopbackServer,
  timingSafeTokenMatch,
} from '../loopback-relay.ts'
import {
  OFM_RELAY_HOST,
  OFM_RELAY_MAX_BODY_BYTES,
  OFM_RELAY_TICKET_HEADER,
} from './zcode-ofm-models.ts'

/** What the bridge needs from the relay once it is listening. */
export interface OfmRelay {
  /** Base URL the official CLI should call, including the owner's path prefix. */
  readonly baseUrl: string
  /** Non-secret, per-session. Guards the relay against open forwarding. */
  readonly ticket: string
  close(): void
}

/** The upstream this relay is pinned to for one launch. */
export interface OfmRelayTarget {
  /** The owner's published endpoint. Loopback http on a concrete port. */
  readonly baseURL: string
}

/**
 * Map an incoming request path onto the upstream path.
 *
 * The relay's own base URL already carries the owner's path prefix, so the path that
 * arrives here *is* the upstream path. It is forwarded verbatim, and only after being
 * checked that it really sits under the prefix this relay was pinned to — an absolute
 * request target or a traversal attempt is refused rather than normalized into
 * something the owner never published.
 */
const upstreamPath = (prefix: string, requestUrl: string | undefined): string | undefined => {
  const path = (requestUrl ?? '/').split('?')[0]
  if (!path.startsWith('/') || path.includes('..')) return undefined
  if (prefix && !(path === prefix || path.startsWith(`${prefix}/`))) return undefined
  return path
}

/**
 * Start the loopback relay for one launch.
 *
 * @param getApiKey - resolves the real credential on demand; may return undefined,
 *   in which case the relay refuses closed instead of sending a placeholder.
 * @param target - the owner's published loopback endpoint for this launch.
 * @returns the loopback base URL, the per-session ticket and a close function.
 */
export async function startOfmRelay(
  getApiKey: () => Promise<string | undefined>,
  target: OfmRelayTarget,
): Promise<OfmRelay> {
  const upstream = assertLoopbackOrigin(target.baseURL, 'Our Free Model 转发通道地址无效')
  // `http.request` ignores proxy environment variables, so a loopback lane is
  // reached directly and a corporate proxy cannot swallow or reroute it.
  const agent = new Agent({ keepAlive: true })
  let relay
  try {
    relay = await startLoopbackServer(
      (ticket) => (req, res) => {
        // Refusals never reveal whether a credential exists.
        const refuse = (status: number) => res.writeHead(status).end()
        // The body is consumed before any decision. Answering while a request body is
        // still arriving tears the socket down under the client, which surfaces as an
        // intermittent hang rather than as the status the caller needs.
        const bodyPromise = readBoundedBody(req, OFM_RELAY_MAX_BODY_BYTES)
        void (async () => {
          // Only the completion POST is forwarded; any other verb is refused outright.
          if (req.method !== 'POST') return refuse(405)
          const read = await bodyPromise
          if (!read.ok) {
            if (read.reason === 'too-large') return refuse(413)
            return
          }
          const payload = read.body
          const presented = req.headers[OFM_RELAY_TICKET_HEADER]
          const value = Array.isArray(presented) ? presented[0] : presented
          if (!timingSafeTokenMatch(value, ticket)) return refuse(403)
          const apiKey = await getApiKey()
          if (!apiKey) return refuse(503)
          // A request that is not the pinned lane's own path is refused before a socket is
          // opened, so the relay cannot be turned into a forwarder for another target.
          const path = upstreamPath(upstream.prefix, req.url)
          if (path === undefined) return refuse(404)
          const forwarded = httpRequest(
            {
              host: '127.0.0.1',
              port: upstream.port,
              method: req.method,
              path,
              agent,
              headers: {
                // The placeholder never leaves this process; the real key goes on the wire.
                authorization: `Bearer ${apiKey}`,
                'content-type': String(req.headers['content-type'] ?? 'application/json'),
                'content-length': String(payload.length),
                accept: String(req.headers.accept ?? 'text/event-stream'),
              },
            },
            (upstreamRes) => {
              // An upstream error body can echo request headers, which would carry the
              // real key back into a response the CLI may log. Preserve the status only.
              if ((upstreamRes.statusCode ?? 502) >= 400) {
                upstreamRes.resume()
                res.writeHead(upstreamRes.statusCode ?? 502, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ error: { message: 'Our Free Model request failed' } }))
                return
              }
              res.writeHead(upstreamRes.statusCode ?? 502, {
                'content-type': String(upstreamRes.headers['content-type'] ?? 'application/json'),
                'cache-control': 'no-cache',
              })
              // Streamed through untouched so server-sent events keep arriving incrementally.
              upstreamRes.pipe(res)
            },
          )
          // A cancelled or torn-down turn must not leave an upstream request running.
          req.on('aborted', () => forwarded.destroy())
          res.on('close', () => forwarded.destroy())
          forwarded.on('error', () => {
            if (!res.headersSent) res.writeHead(502).end()
            else res.end()
          })
          forwarded.setTimeout(180000, () => forwarded.destroy())
          forwarded.end(payload)
        })().catch(() => {
          if (!res.headersSent) res.writeHead(500).end()
        })
      },
      { host: OFM_RELAY_HOST, tokenBytes: 24, unavailableMessage: '未能启动本地鉴权转发' },
    )
  } catch (error) {
    agent.destroy()
    throw error
  }
  return {
    baseUrl: relay.baseURL(upstream.prefix),
    ticket: relay.token,
    close: () => {
      relay.closeSync(() => agent.destroy())
    },
  }
}
