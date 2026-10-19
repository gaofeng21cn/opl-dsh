/** Compatibility for metadata-only Chat Completions tool-call deltas from OFM. */
import { createServer, request, type ClientRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Transform, pipeline } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

/** Join tool metadata with its function delta without generating names or arguments. */
export function normalizeToolDeltaLine(
  line: string,
  pendingCalls = new Map<string, Record<string, unknown>>(),
  started = new Set<string>(),
): string {
  const match = /^(data:\s*)(.*?)(\r?)$/.exec(line)
  if (!match) return line
  if (match[2] === '[DONE]') {
    if (pendingCalls.size) throw Error('Chat stream ended with incomplete tool metadata')
    return line
  }
  let payload: unknown
  try {
    payload = JSON.parse(match[2]!)
  } catch {
    return line
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { choices?: unknown }).choices)
  )
    return line
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
  return changed ? match[1] + JSON.stringify(payload) + match[3] : line
}

/** Transform complete SSE data lines while retaining split UTF-8 and unmodified non-JSON fields. */
export function toolDeltaStream(): Transform {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const pendingCalls = new Map<string, Record<string, unknown>>()
  const started = new Set<string>()
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        pending += decoder.write(chunk)
        let end: number
        while ((end = pending.indexOf('\n')) >= 0) {
          this.push(normalizeToolDeltaLine(pending.slice(0, end), pendingCalls, started) + '\n')
          pending = pending.slice(end + 1)
        }
        // Bound an unframed provider response; this is not a model token limit.
        if (pending.length > 16 * 1024 * 1024) done(Error('Chat stream frame exceeds relay limit'))
        else done()
      } catch (error) {
        done(error as Error)
      }
    },
    flush(done) {
      try {
        pending += decoder.end()
        if (pending) this.push(normalizeToolDeltaLine(pending, pendingCalls, started))
        if (pendingCalls.size) done(Error('Chat stream ended with incomplete tool metadata'))
        else done()
      } catch (error) {
        done(error as Error)
      }
    },
  })
}

/** Forward one published loopback OFM route, with a connection-local key and no retries. */
export async function startChatToolRelay(target: {
  baseURL: string
  apiKey: string
  model: string
}) {
  const upstream = new URL(target.baseURL)
  if (
    upstream.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(upstream.hostname) ||
    !upstream.port ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash
  )
    throw Error('Chat compatibility requires the published OFM loopback route')
  const prefix = upstream.pathname.replace(/\/$/, '')
  const key = randomBytes(32).toString('hex')
  const inflight = new Set<ClientRequest>()
  let closed = false
  const server = createServer((req, res) => {
    if (
      closed ||
      req.method !== 'POST' ||
      req.url !== prefix + '/chat/completions' ||
      req.headers.authorization !== 'Bearer ' + key
    ) {
      req.resume()
      res.writeHead(403).end()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= 16 * 1024 * 1024) chunks.push(chunk)
    })
    req.on('error', () => res.destroy())
    req.on('end', () => {
      if (closed) {
        res.writeHead(503).end()
        return
      }
      if (size > 16 * 1024 * 1024) {
        res.writeHead(413).end()
        return
      }
      const body = Buffer.concat(chunks)
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
          path: prefix + '/chat/completions',
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + target.apiKey,
            'content-type': 'application/json',
            'content-length': body.length,
            'accept-encoding': 'identity',
          },
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, {
            'content-type': response.headers['content-type'] ?? 'application/json',
            ...(response.headers['retry-after']
              ? { 'retry-after': response.headers['retry-after'] }
              : {}),
            ...(response.headers['x-should-retry']
              ? { 'x-should-retry': response.headers['x-should-retry'] }
              : {}),
          })
          const failed = (error: NodeJS.ErrnoException | null) => {
            if (error) res.destroy()
          }
          if (String(response.headers['content-type']).includes('text/event-stream'))
            pipeline(response, toolDeltaStream(), res, failed)
          else pipeline(response, res, failed)
        },
      )
      inflight.add(forward)
      forward.once('close', () => inflight.delete(forward))
      forward.once('error', () => {
        if (!res.headersSent) res.writeHead(502).end()
        else res.destroy()
      })
      res.once('close', () => forward.destroy())
      forward.end(body)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Chat relay address unavailable')
  let closing: Promise<void> | undefined
  return {
    baseURL: `http://127.0.0.1:${address.port}${prefix}`,
    key,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        closed = true
        for (const request of inflight) request.destroy()
        server.closeAllConnections()
        server.close(() => resolve())
      })),
  }
}
