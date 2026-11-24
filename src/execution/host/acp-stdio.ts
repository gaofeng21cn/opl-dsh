/** Shared ACP JSON-RPC 2.0 and strict LF-only NDJSON framing built on `@agentclientprotocol/sdk`. */
import type { Readable, Writable } from 'node:stream'
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  DEFAULT_MAX_MESSAGE_BYTES,
  RequestError,
  ndJsonStream,
  type AnyMessage,
  type JsonRpcId,
} from '@agentclientprotocol/sdk'

export { AGENT_METHODS, CLIENT_METHODS, DEFAULT_MAX_MESSAGE_BYTES, RequestError, ndJsonStream }

/** Handle returned by {@link attachLfLineReader} to stop listening on a readable stream. */
export interface LineReaderHandle {
  close(): void
}

/**
 * Split a Node `Readable` strictly on LF (`0x0a`, stripping optional trailing CR `0x0d`).
 *
 * Unlike `node:readline`, this never splits JSON payloads on U+2028 or U+2029 line/paragraph
 * separators and never corrupts multibyte UTF-8 characters split across pipe chunks.
 */
export function attachLfLineReader(
  readable: Readable,
  onLine: (line: string) => void,
  options: {
    maxLineBytes?: number
    onEnd?: () => void
    onError?: (error: Error) => void
  } = {},
): LineReaderHandle {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_MESSAGE_BYTES
  const decoder = new TextDecoder('utf-8')
  const parts: Uint8Array[] = []
  let bufferedBytes = 0
  let closed = false

  const emitBytes = (lineBytes: Uint8Array): void => {
    const trimmedBytes =
      lineBytes.byteLength > 0 && lineBytes[lineBytes.byteLength - 1] === 0x0d
        ? lineBytes.subarray(0, lineBytes.byteLength - 1)
        : lineBytes
    const text = decoder.decode(trimmedBytes)
    if (text.trim().length > 0) onLine(text)
  }

  const takeLine = (tail: Uint8Array): Uint8Array => {
    if (parts.length === 0) return tail
    const total = bufferedBytes + tail.byteLength
    const merged = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      merged.set(part, offset)
      offset += part.byteLength
    }
    merged.set(tail, offset)
    parts.length = 0
    bufferedBytes = 0
    return merged
  }

  const onData = (rawChunk: Buffer | string): void => {
    if (closed) return
    const chunk = typeof rawChunk === 'string' ? Buffer.from(rawChunk, 'utf8') : rawChunk
    let start = 0
    let newlineIndex = chunk.indexOf(0x0a, start)
    while (newlineIndex !== -1) {
      const tail = chunk.subarray(start, newlineIndex)
      if (bufferedBytes + tail.byteLength > maxLineBytes) {
        parts.length = 0
        bufferedBytes = 0
        options.onError?.(Error(`Line exceeds ${maxLineBytes} byte limit`))
        return
      }
      emitBytes(takeLine(tail))
      if (closed) return
      start = newlineIndex + 1
      newlineIndex = chunk.indexOf(0x0a, start)
    }
    if (start < chunk.byteLength) {
      const remainder = chunk.subarray(start)
      if (bufferedBytes + remainder.byteLength > maxLineBytes) {
        parts.length = 0
        bufferedBytes = 0
        options.onError?.(Error(`Line exceeds ${maxLineBytes} byte limit`))
        return
      }
      // Copy slice so retaining chunks across ticks never pins a larger slab.
      parts.push(new Uint8Array(remainder))
      bufferedBytes += remainder.byteLength
    }
  }

  const onEnd = (): void => {
    if (closed) return
    if (bufferedBytes > 0) emitBytes(takeLine(new Uint8Array(0)))
    options.onEnd?.()
  }

  const onError = (error: Error): void => {
    if (closed) return
    options.onError?.(error)
  }

  readable.on('data', onData)
  readable.once('end', onEnd)
  readable.once('error', onError)

  return {
    close(): void {
      if (closed) return
      closed = true
      parts.length = 0
      bufferedBytes = 0
      readable.off('data', onData)
      readable.off('end', onEnd)
      readable.off('error', onError)
    },
  }
}

/** Loose JSON-RPC 2.0 record that also preserves OPL custom string error codes and `opl/*` methods. */
export type AcpWireMessage = Record<string, unknown>

function isWireObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Bidirectional JSON-RPC 2.0 channel over Node streams powered by `@agentclientprotocol/sdk`
 * `ndJsonStream`.
 *
 * Guarantees strict LF-only framing, prevents writing to read-only input streams, preserves
 * custom `opl/*` extension methods and OPL string failure codes, and optionally drops non-JSON
 * diagnostic stdout lines from noisy child CLIs before reaching `ndJsonStream`.
 */
export class AcpJsonRpcChannel {
  private readonly output: Writable
  private readonly writer: WritableStreamDefaultWriter<AnyMessage>
  private readonly reader: ReadableStreamDefaultReader<AnyMessage>
  private readonly lineReader: LineReaderHandle
  private closed = false

  constructor(
    input: Readable,
    output: Writable,
    handlers: {
      onMessage: (message: AcpWireMessage) => void
      onClose?: () => void
      onWriteError?: (error: Error) => void
      ignoreNonJson?: boolean
      maxMessageBytes?: number
    },
  ) {
    this.output = output
    const encoder = new TextEncoder()
    const maxMessageBytes = handlers.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    const ignoreNonJson = handlers.ignoreNonJson ?? true
    let inputController!: ReadableStreamDefaultController<Uint8Array>

    const webInput = new ReadableStream<Uint8Array>({
      start(controller) {
        inputController = controller
      },
    })
    const webOutput = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (this.closed || output.destroyed || output.writableEnded) return
        try {
          output.write(chunk)
        } catch (error) {
          handlers.onWriteError?.(error instanceof Error ? error : Error(String(error)))
        }
      },
    })

    const stream = ndJsonStream(webOutput, webInput, { maxMessageBytes })
    const writer = stream.writable.getWriter()
    const reader = stream.readable.getReader()
    this.writer = writer
    this.reader = reader

    this.lineReader = attachLfLineReader(
      input,
      (line) => {
        if (this.closed) return
        if (ignoreNonJson) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('{')) return
          try {
            const parsed: unknown = JSON.parse(trimmed)
            if (!isWireObject(parsed)) return
          } catch {
            return
          }
        }
        try {
          inputController.enqueue(encoder.encode(line + '\n'))
        } catch {
          // Stream closed concurrently.
        }
      },
      {
        maxLineBytes: maxMessageBytes,
        onEnd: () => {
          try {
            inputController.close()
          } catch {
            // Already closed.
          }
        },
        onError: () => {
          try {
            inputController.close()
          } catch {
            // Already closed.
          }
        },
      },
    )

    void (async () => {
      try {
        while (!this.closed) {
          const { done, value } = await reader.read()
          if (done || this.closed) break
          if (isWireObject(value)) handlers.onMessage(value)
        }
      } catch {
        // Transport closed or errored; teardown notifies onClose below.
      } finally {
        handlers.onClose?.()
      }
    })()
  }

  /** Write one JSON-RPC 2.0 message to the channel's output stream (never its input). */
  send(payload: Record<string, unknown>): void {
    if (this.closed) throw Error('ACP channel is closed')
    const frame = { jsonrpc: '2.0', ...payload } as unknown as AnyMessage
    void this.writer.write(frame).catch(() => {})
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.send({ id, result })
  }

  respondError(id: JsonRpcId, code: number | string, message: string, data?: unknown): void {
    this.send({
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.send(params === undefined ? { method } : { method, params })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.lineReader.close()
    void this.reader.cancel().catch(() => {})
    void this.writer.close().catch(() => {})
    void this.output
  }
}
