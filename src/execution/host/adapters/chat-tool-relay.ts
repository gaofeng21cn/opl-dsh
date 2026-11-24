/** Compatibility for metadata-only Chat Completions tool-call deltas from OFM. */
import { request, type ClientRequest } from 'node:http'
import { type Transform, pipeline } from 'node:stream'
import {
  assertLoopbackOrigin,
  createSseEventTransform,
  readBoundedBody,
  startLoopbackServer,
  timingSafeTokenMatch,
} from './loopback-relay.ts'

function normalizeToolDeltaData(
  rawData: string,
  pendingCalls: Map<string, Record<string, unknown>>,
  started: Set<string>,
): string {
  if (rawData === '[DONE]') {
    if (pendingCalls.size) throw Error('Chat stream ended with incomplete tool metadata')
    return rawData
  }
  let payload: unknown
  try {
    payload = JSON.parse(rawData)
  } catch {
    return rawData
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { choices?: unknown }).choices)
  )
    return rawData
  let changed = false
  for (const choice of (payload as { choices: unknown[] }).choices) {
    if (!choice || typeof choice !== 'object') continue
    const delta = (choice as { delta?: { tool_calls?: unknown } }).delta
    if (!delta || !Array.isArray(delta.tool_calls)) {
      if ((choice as { finish_reason?: unknown }).finish_reason && pendingCalls.size)
        throw Error('Chat stream ended with incomplete tool metadata')
      continue
    }
    const calls = []
    for (const call of delta.tool_calls) {
      if (
        call &&
        typeof call === 'object' &&
        !Array.isArray(call) &&
        Number.isInteger(call.index) &&
        call.index >= 0 &&
        (call.type === undefined || call.type === 'function') &&
        !Object.hasOwn(call, 'function')
      ) {
        const key = `${(choice as { index?: number }).index ?? 0}:${call.index}`
        if (started.has(key)) {
          calls.push({ ...call, function: {} })
          changed = true
          continue
        }
        const previous = pendingCalls.get(key)
        if (previous)
          for (const field of Object.keys(call)) {
            if (Object.hasOwn(previous, field) && previous[field] !== call[field])
              throw Error('Conflicting tool delta metadata')
          }
        pendingCalls.set(key, { ...previous, ...call })
        changed = true
        continue
      }
      if (call && typeof call === 'object' && Number.isInteger(call.index)) {
        const key = `${(choice as { index?: number }).index ?? 0}:${call.index}`
        started.add(key)
        const held = pendingCalls.get(key)
        if (held) {
          for (const field of Object.keys(held)) {
            if (Object.hasOwn(call, field) && call[field] !== held[field])
              throw Error('Conflicting tool delta metadata')
          }
          calls.push({ ...held, ...call })
          pendingCalls.delete(key)
          changed = true
          continue
        }
      }
      calls.push(call)
    }
    delta.tool_calls = calls
    if ((choice as { finish_reason?: unknown }).finish_reason && pendingCalls.size)
      throw Error('Chat stream ended with incomplete tool metadata')
  }
  return changed ? JSON.stringify(payload) : rawData
}

/** Join tool metadata with its function delta without generating names or arguments. */
export function normalizeToolDeltaLine(
  line: string,
  pendingCalls = new Map<string, Record<string, unknown>>(),
  started = new Set<string>(),
): string {
  const match = /^(data:\s*)(.*?)(\r?)$/.exec(line)
  if (!match) return line
  const normalized = normalizeToolDeltaData(match[2]!, pendingCalls, started)
  return normalized === match[2] ? line : match[1] + normalized + match[3]
}

/** Transform complete SSE events via `eventsource-parser` while retaining split UTF-8 and comments. */
export function toolDeltaStream(): Transform {
  const pendingCalls = new Map<string, Record<string, unknown>>()
  const started = new Set<string>()
  return createSseEventTransform({
    maxBufferSize: 16 * 1024 * 1024,
    onError(error) {
      if (error.type === 'max-buffer-size-exceeded')
        throw Error('Chat stream frame exceeds relay limit')
    },
    onComment(comment, push) {
      push(`: ${comment}\n\n`)
    },
    onRetry(retry, push) {
      push(`retry: ${retry}\n\n`)
    },
    onEvent(event, push) {
      const normalized = normalizeToolDeltaData(event.data, pendingCalls, started)
      const header =
        (event.event ? `event: ${event.event}\n` : '') +
        (event.id !== undefined ? `id: ${event.id}\n` : '')
      push(`${header}data: ${normalized}\n\n`)
    },
    onFlush() {
      if (pendingCalls.size) throw Error('Chat stream ended with incomplete tool metadata')
    },
  })
}

/** Forward one published loopback OFM route, with a connection-local key and no retries. */
export async function startChatToolRelay(target: {
  baseURL: string
  apiKey: string
  model: string
  /** Report a provider response that the ACP bridge can map to a terminal error. */
  onUpstreamFailure?: (status?: number) => void
}) {
  const upstream = assertLoopbackOrigin(
    target.baseURL,
    'Chat compatibility requires the published OFM loopback route',
  )
  const inflight = new Set<ClientRequest>()
  let closed = false
  let failureReported = false
  const reportFailure = (status?: number) => {
    if (closed || failureReported) return
    failureReported = true
    target.onUpstreamFailure?.(status)
  }

  const relay = await startLoopbackServer(
    (key) => (req, res) => {
      const bearer = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice('Bearer '.length)
        : undefined
      if (
        closed ||
        req.method !== 'POST' ||
        req.url !== upstream.prefix + '/chat/completions' ||
        !timingSafeTokenMatch(bearer, key)
      ) {
        req.resume()
        res.writeHead(403).end()
        return
      }
      void readBoundedBody(req, 16 * 1024 * 1024).then((read) => {
        if (!read.ok) {
          if (read.reason === 'too-large') res.writeHead(413).end()
          else res.destroy()
          return
        }
        if (closed) {
          res.writeHead(503).end()
          return
        }
        const body = read.body
        try {
          if (JSON.parse(body.toString()).model !== target.model) {
            res.writeHead(400).end()
            return
          }
        } catch {
          res.writeHead(400).end()
          return
        }
        const forward = request(
          {
            hostname: upstream.hostname,
            port: upstream.port,
            path: upstream.prefix + '/chat/completions',
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + target.apiKey,
              'content-type': 'application/json',
              'content-length': body.length,
              'accept-encoding': 'identity',
            },
          },
          (response) => {
            const status = response.statusCode ?? 502
            if (status < 200 || status >= 300) reportFailure(status)
            res.writeHead(status, {
              'content-type': response.headers['content-type'] ?? 'application/json',
              ...(response.headers['retry-after']
                ? { 'retry-after': response.headers['retry-after'] }
                : {}),
              ...(response.headers['x-should-retry']
                ? { 'x-should-retry': response.headers['x-should-retry'] }
                : {}),
            })
            const failed = (error: NodeJS.ErrnoException | null) => {
              if (error) {
                reportFailure()
                res.destroy()
              }
            }
            if (String(response.headers['content-type']).includes('text/event-stream'))
              pipeline(response, toolDeltaStream(), res, failed)
            else pipeline(response, res, failed)
          },
        )
        inflight.add(forward)
        forward.once('close', () => inflight.delete(forward))
        forward.once('error', () => {
          reportFailure()
          if (!res.headersSent) {
            res.writeHead(502).end()
          } else res.destroy()
        })
        res.once('close', () => forward.destroy())
        forward.end(body)
      })
    },
    { unavailableMessage: 'Chat relay address unavailable' },
  )

  return {
    baseURL: relay.baseURL(upstream.prefix),
    key: relay.token,
    close: () =>
      relay.close(() => {
        closed = true
        for (const item of inflight) item.destroy()
        inflight.clear()
      }),
  }
}
