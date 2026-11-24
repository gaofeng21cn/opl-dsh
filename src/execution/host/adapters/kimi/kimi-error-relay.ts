/** Observes bounded provider failures on the exact request sent by one Kimi process. */
import { request, type ClientRequest } from 'node:http'
import { createParser } from 'eventsource-parser'
import {
  assertLoopbackOrigin,
  readBoundedBody,
  startLoopbackServer,
  timingSafeTokenMatch,
} from '../loopback-relay.ts'

/** Fixed diagnostics only; provider text and account identifiers never leave the relay. */
export function kimiProviderFailure(status: number, payload: unknown): string | undefined {
  const row =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  const error =
    typeof row.error === 'object' && row.error !== null
      ? (row.error as Record<string, unknown>)
      : row
  const code = typeof error.code === 'string' ? error.code : ''
  const message = typeof error.message === 'string' ? error.message : ''
  if (!row.error && status < 400) return undefined
  if (status === 429 || code === 'RATE_LIMIT') return 'HARNESS_PROVIDER_RATE_LIMIT'
  if (/end of life|model.*retired|model.*no longer available/i.test(message))
    return 'HARNESS_PROVIDER_RETIRED'
  if (/function.*not found for account/i.test(message)) return 'HARNESS_PROVIDER_ROUTE'
  if (status === 401 || status === 403) return 'HARNESS_PROVIDER_AUTH'
  if (code === 'NO_PROGRESS' || code === 'TIMEOUT' || status === 408 || status === 504)
    return 'HARNESS_PROVIDER_TIMEOUT'
  if (status === 404 || code === 'MODEL_NOT_FOUND') return 'HARNESS_PROVIDER_MODEL'
  return 'HARNESS_PROVIDER'
}

interface Turn {
  failure?: string
  cancelled: boolean
  requests: Set<ClientRequest>
}
/** One CLI connection owns this relay. A new prompt starts a separate observation. */
export interface KimiErrorRelay {
  baseURL: string
  key: string
  begin(): void
  cancel(): void
  end(): string | undefined
  close(): Promise<void>
}

/**
 * Forward only the configured OFM Messages endpoint, without retries or changed model IDs.
 * @param target - Existing source route; credentials stay in memory.
 * @returns A private loopback endpoint and prompt-scoped failure observation.
 */
export async function startKimiErrorRelay(target: {
  baseURL: string
  apiKey: string
  model: string
}): Promise<KimiErrorRelay> {
  const upstream = assertLoopbackOrigin(
    target.baseURL,
    'Kimi OFM relay requires its published loopback endpoint',
  )
  let current: Turn | undefined
  let closed = false

  const relay = await startLoopbackServer(
    (key) => (req, res) => {
      const turn = current
      const path = req.url
      const presented =
        typeof req.headers['x-api-key'] === 'string'
          ? req.headers['x-api-key']
          : req.headers.authorization?.startsWith('Bearer ')
            ? req.headers.authorization.slice('Bearer '.length)
            : undefined
      if (
        closed ||
        !turn ||
        turn.cancelled ||
        req.method !== 'POST' ||
        !timingSafeTokenMatch(presented, key) ||
        !['/messages', '/messages/count_tokens', '/v1/messages', '/v1/messages/count_tokens']
          .map((value) => upstream.prefix + value)
          .includes(path?.split('?')[0] ?? '')
      ) {
        req.resume()
        res.writeHead(403).end()
        return
      }
      void readBoundedBody(req, 16 * 1024 * 1024).then((read) => {
        if (!read.ok) {
          if (read.reason === 'too-large') {
            turn.failure = 'HARNESS_PROVIDER'
            res.writeHead(413).end()
          } else {
            res.destroy()
          }
          return
        }
        if (closed || current !== turn || turn.cancelled) {
          res.writeHead(409).end()
          return
        }
        const body = read.body
        try {
          if (JSON.parse(body.toString()).model !== target.model) {
            res.writeHead(400).end()
            turn.failure = 'HARNESS_PROVIDER_MODEL'
            return
          }
        } catch {
          res.writeHead(400).end()
          turn.failure = 'HARNESS_PROVIDER'
          return
        }
        const forward = request(
          {
            hostname: upstream.hostname,
            port: upstream.port,
            path,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': body.length,
              'x-api-key': target.apiKey,
              'anthropic-version':
                typeof req.headers['anthropic-version'] === 'string'
                  ? req.headers['anthropic-version']
                  : '2023-06-01',
              ...(typeof req.headers['anthropic-beta'] === 'string'
                ? { 'anthropic-beta': req.headers['anthropic-beta'] }
                : {}),
              'accept-encoding': 'identity',
            },
          },
          (response) => {
            const status = response.statusCode ?? 502
            const stream = String(response.headers['content-type']).includes('text/event-stream')
            let pending = ''
            const decoder = new TextDecoder('utf-8', { ignoreBOM: false })
            const observe = (text: string) => {
              try {
                const code = kimiProviderFailure(status, JSON.parse(text))
                if (code && current === turn && !turn.cancelled) turn.failure = code
              } catch {
                /* Non-JSON SSE fields and malformed provider diagnostics carry no trusted detail. */
              }
            }
            const sseParser = stream
              ? createParser({
                  maxBufferSize: 65536,
                  onEvent(event) {
                    if (event.event === 'error' && current === turn && !turn.cancelled) {
                      turn.failure = 'HARNESS_PROVIDER'
                    }
                    observe(event.data)
                  },
                  onError(error) {
                    if (error.type === 'max-buffer-size-exceeded') {
                      sseParser?.reset()
                    }
                  },
                })
              : undefined
            // A successful model retry replaces the preceding failure in this prompt.
            if (
              current === turn &&
              !turn.cancelled &&
              !path?.split('?')[0].endsWith('/count_tokens')
            ) {
              if (status >= 400)
                turn.failure = kimiProviderFailure(status, {}) ?? 'HARNESS_PROVIDER'
              else delete turn.failure
            }
            res.writeHead(status, {
              'content-type': response.headers['content-type'] ?? 'application/json',
              ...(response.headers['retry-after']
                ? { 'retry-after': response.headers['retry-after'] }
                : {}),
              ...(response.headers['retry-after-ms']
                ? { 'retry-after-ms': response.headers['retry-after-ms'] }
                : {}),
              ...(response.headers['x-should-retry']
                ? { 'x-should-retry': response.headers['x-should-retry'] }
                : {}),
            })
            response.on('data', (chunk: Buffer) => {
              const text = decoder.decode(chunk, { stream: true })
              if (sseParser) {
                try {
                  sseParser.feed(text)
                } catch {
                  sseParser.reset()
                }
              } else if (pending.length < 65536) pending += text.slice(0, 65536 - pending.length)
              if (!res.write(chunk)) response.pause()
            })
            res.on('drain', () => response.resume())
            response.on('end', () => {
              const tail = decoder.decode()
              if (sseParser) {
                if (tail) {
                  try {
                    sseParser.feed(tail)
                  } catch {
                    sseParser.reset()
                  }
                }
                sseParser.reset({ consume: true })
              } else {
                observe(pending + tail)
              }
              turn.requests.delete(forward)
              res.end()
            })
            response.on('error', () => {
              if (current === turn && !turn.cancelled) turn.failure ??= 'HARNESS_PROVIDER_NETWORK'
              res.destroy()
            })
          },
        )
        turn.requests.add(forward)
        forward.on('error', () => {
          turn.requests.delete(forward)
          if (current === turn && !turn.cancelled) turn.failure ??= 'HARNESS_PROVIDER_NETWORK'
          if (!res.headersSent) res.writeHead(502)
          res.end()
        })
        res.on('close', () => {
          if (!res.writableFinished) forward.destroy()
        })
        forward.end(body)
      })
    },
    { requestTimeout: 30000, unavailableMessage: 'Kimi relay did not bind' },
  )

  const end = () => {
    const turn = current
    current = undefined
    for (const req of turn?.requests ?? []) req.destroy()
    return turn?.cancelled ? undefined : turn?.failure
  }
  return {
    baseURL: relay.baseURL(upstream.prefix),
    key: relay.token,
    begin() {
      if (closed || current) throw Error('Kimi prompt already active')
      current = { cancelled: false, requests: new Set() }
    },
    cancel() {
      if (current) {
        current.cancelled = true
        for (const req of current.requests) req.destroy()
      }
    },
    end,
    async close() {
      if (closed) return
      closed = true
      await relay.close(() => {
        end()
      })
    },
  }
}
