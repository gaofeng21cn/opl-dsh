/** Shared loopback HTTP relay lifecycle and WHATWG SSE streaming primitives. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { Transform } from 'node:stream'
import { createParser, type EventSourceMessage, type ParseError } from 'eventsource-parser'

/** Validated loopback upstream origin and normalized path prefix. */
export interface LoopbackOrigin {
  readonly url: URL
  readonly hostname: string
  readonly port: number
  readonly prefix: string
}

/** Validate a pinned loopback `http://127.0.0.1:<port>` or `localhost` upstream origin. */
export function assertLoopbackOrigin(baseURL: string, errorMessage: string): LoopbackOrigin {
  const url = new URL(baseURL)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw Error(errorMessage)
  }
  return {
    url,
    hostname: url.hostname,
    port: Number(url.port),
    prefix: url.pathname.replace(/\/+$/, ''),
  }
}

/** Constant-time string token comparison. */
export function timingSafeTokenMatch(presented: string | undefined, expected: string): boolean {
  if (typeof presented !== 'string') return false
  const left = Buffer.from(presented)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Result of reading a bounded HTTP request body. */
export type BoundedBodyResult =
  | { readonly ok: true; readonly body: Buffer }
  | { readonly ok: false; readonly reason: 'too-large' | 'aborted' }

/** Read an HTTP request body up to `maxBytes` without buffering unbounded input. */
export function readBoundedBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  return new Promise<BoundedBodyResult>((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    let overflow = false
    const finish = (result: BoundedBodyResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        overflow = true
        chunks.length = 0
        return
      }
      if (!overflow) chunks.push(chunk)
    })
    req.once('end', () => {
      if (overflow) finish({ ok: false, reason: 'too-large' })
      else finish({ ok: true, body: Buffer.concat(chunks) })
    })
    req.once('aborted', () => finish({ ok: false, reason: 'aborted' }))
    req.once('error', () => finish({ ok: false, reason: 'aborted' }))
  })
}

/** Bound ephemeral loopback HTTP server handle with tracked sockets and secret token. */
export interface LoopbackServerHandle {
  readonly server: Server
  readonly host: string
  readonly port: number
  readonly token: string
  baseURL(prefix?: string): string
  close(beforeClose?: () => void): Promise<void>
  closeSync(beforeClose?: () => void): void
}

/** Bind an ephemeral loopback HTTP server and generate a per-launch random token. */
export async function startLoopbackServer(
  handler: (token: string) => RequestListener,
  options: {
    host?: string
    tokenBytes?: number
    requestTimeout?: number
    unavailableMessage?: string
  } = {},
): Promise<LoopbackServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const token = randomBytes(options.tokenBytes ?? 32).toString('hex')
  const sockets = new Set<Socket>()
  const server = createServer(handler(token))
  if (options.requestTimeout !== undefined) server.requestTimeout = options.requestTimeout
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(0, host, () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string' || !address.port) {
    server.close()
    throw Error(options.unavailableMessage ?? 'Loopback relay address unavailable')
  }
  const port = address.port
  let closing: Promise<void> | undefined
  return {
    server,
    host,
    port,
    token,
    baseURL(prefix = ''): string {
      return `http://${host}:${port}${prefix}`
    },
    close(beforeClose?: () => void): Promise<void> {
      return (closing ??= new Promise<void>((resolve) => {
        beforeClose?.()
        for (const socket of sockets) socket.destroy()
        sockets.clear()
        server.closeAllConnections()
        server.close(() => resolve())
      }))
    },
    closeSync(beforeClose?: () => void): void {
      beforeClose?.()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.closeAllConnections()
      server.close()
    },
  }
}

/** Options for creating an `eventsource-parser` backed Node Transform stream. */
export interface SseTransformOptions {
  readonly maxBufferSize?: number
  readonly onEvent: (event: EventSourceMessage, push: (chunk: string) => void) => void
  readonly onComment?: (comment: string, push: (chunk: string) => void) => void
  readonly onRetry?: (retry: number, push: (chunk: string) => void) => void
  readonly onError?: (error: ParseError) => void
  readonly onIncompleteTrailingEvent?: () => Error
  readonly onFlush?: (push: (chunk: string) => void) => void
}

/** Build a Node `Transform` stream driven by `eventsource-parser` with strict UTF-8 & BOM handling. */
export function createSseEventTransform(options: SseTransformOptions): Transform {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: false })
  let stream!: Transform
  let flushing = false
  let pendingError: Error | undefined

  const push = (chunk: string): void => {
    stream.push(chunk)
  }

  const parser = createParser({
    ...(options.maxBufferSize === undefined ? {} : { maxBufferSize: options.maxBufferSize }),
    onEvent(event) {
      if (flushing && options.onIncompleteTrailingEvent) {
        pendingError ??= options.onIncompleteTrailingEvent()
        return
      }
      try {
        options.onEvent(event, push)
      } catch (error) {
        pendingError ??= error instanceof Error ? error : Error(String(error))
      }
    },
    ...(options.onComment
      ? {
          onComment(comment: string) {
            try {
              options.onComment?.(comment, push)
            } catch (error) {
              pendingError ??= error instanceof Error ? error : Error(String(error))
            }
          },
        }
      : {}),
    ...(options.onRetry
      ? {
          onRetry(retry: number) {
            try {
              options.onRetry?.(retry, push)
            } catch (error) {
              pendingError ??= error instanceof Error ? error : Error(String(error))
            }
          },
        }
      : {}),
    onError(error) {
      if (flushing && options.onIncompleteTrailingEvent) {
        pendingError ??= options.onIncompleteTrailingEvent()
        return
      }
      if (options.onError) {
        try {
          options.onError(error)
        } catch (thrown) {
          pendingError ??= thrown instanceof Error ? thrown : Error(String(thrown))
        }
      }
    },
  })

  const takeError = (): Error | undefined => {
    const error = pendingError
    pendingError = undefined
    return error
  }

  stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        parser.feed(decoder.decode(chunk, { stream: true }))
        const error = takeError()
        if (error) done(error)
        else done()
      } catch (error) {
        done(error instanceof Error ? error : Error(String(error)))
      }
    },
    flush(done) {
      try {
        const tail = decoder.decode()
        if (tail) parser.feed(tail)
        const errorBeforeFlush = takeError()
        if (errorBeforeFlush) {
          done(errorBeforeFlush)
          return
        }
        if (options.onIncompleteTrailingEvent) {
          flushing = true
          // Feeding two LFs forces any buffered non-comment field/data line to dispatch or error.
          parser.feed('\n\n')
          flushing = false
          const trailingError = takeError()
          if (trailingError) {
            done(trailingError)
            return
          }
        }
        options.onFlush?.(push)
        done()
      } catch (error) {
        done(error instanceof Error ? error : Error(String(error)))
      }
    },
  })

  return stream
}
