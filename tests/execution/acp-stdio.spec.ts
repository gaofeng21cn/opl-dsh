import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { AcpJsonRpcChannel, attachLfLineReader } from '../../src/execution/host/acp-stdio.ts'

describe('shared ACP stdio transport (@agentclientprotocol/sdk ndJsonStream)', () => {
  it('splits strictly on LF and never splits JSON payloads on U+2028 or U+2029', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const received: Record<string, unknown>[] = []
    let closed!: () => void
    const done = new Promise<void>((resolve) => {
      closed = resolve
    })

    const channel = new AcpJsonRpcChannel(input, output, {
      ignoreNonJson: true,
      onMessage: (message) => received.push(message),
      onClose: closed,
    })

    // Non-JSON diagnostic noise must be ignored without writing spurious parse errors.
    input.write('CLI diagnostic banner\n')
    // Multibyte UTF-8 + U+2028/U+2029 inside a JSON string split across chunks.
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method: 'opl/session/history/list',
      id: 7,
      params: { text: 'line1\u2028line2\u2029中文' },
    })
    const bytes = Buffer.from(payload + '\r\n', 'utf8')
    input.write(bytes.subarray(0, 20))
    input.write(bytes.subarray(20))
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        error: { code: 'HARNESS_PROVIDER_RATE_LIMIT', message: 'rate limited' },
      }) + '\n',
    )
    input.end()
    await done

    expect(received).toEqual([
      {
        jsonrpc: '2.0',
        method: 'opl/session/history/list',
        id: 7,
        params: { text: 'line1\u2028line2\u2029中文' },
      },
      {
        jsonrpc: '2.0',
        id: 7,
        error: { code: 'HARNESS_PROVIDER_RATE_LIMIT', message: 'rate limited' },
      },
    ])

    // Outgoing writes must go exclusively to `output`, never `input`.
    const outChunks: string[] = []
    output.on('data', (chunk: Buffer) => outChunks.push(chunk.toString('utf8')))
    const channel2 = new AcpJsonRpcChannel(new PassThrough(), output, {
      onMessage: () => {},
    })
    channel2.send({ id: 9, method: 'session/request_permission', params: { sessionId: 's1' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    channel2.close()
    channel.close()
    expect(outChunks.join('')).toContain('"method":"session/request_permission"')
  })

  it('attachLfLineReader preserves U+2028 and U+2029 across chunk boundaries', () => {
    const input = new PassThrough()
    const lines: string[] = []
    const reader = attachLfLineReader(input, (line) => lines.push(line))
    const raw = Buffer.from('{"text":"a\u2028b\u2029c"}\n', 'utf8')
    for (const byte of raw) input.write(Buffer.from([byte]))
    input.end()
    reader.close()
    expect(lines).toEqual(['{"text":"a\u2028b\u2029c"}'])
  })
})
