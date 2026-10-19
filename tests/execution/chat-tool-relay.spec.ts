import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'
import {
  startChatToolRelay,
  toolDeltaStream,
} from '../../src/execution/host/adapters/chat-tool-relay.ts'

const frame = (calls: unknown[]) =>
  'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: calls } }] }) + '\n\n'
async function transform(input: Buffer[]) {
  let output = ''
  await pipeline(Readable.from(input), toolDeltaStream(), async (source) => {
    for await (const chunk of source) output += chunk.toString()
  })
  return output
}

describe('OFM tool delta compatibility', () => {
  it('joins metadata to its function across byte boundaries without inventing arguments', async () => {
    const input =
      frame([{ index: 0, id: 'a', type: 'function' }]) +
      frame([{ index: 0, function: { name: 'bash', arguments: '{"command":"中文"}' } }]) +
      frame([{ index: 0 }]) +
      'data: [DONE]\n\n'
    const output = await transform([...Buffer.from(input)].map((b) => Buffer.from([b])))
    const frames = output
      .split('\n')
      .filter((l) => l.startsWith('data: {'))
      .map((l) => JSON.parse(l.slice(6)))
    expect(frames[0].choices[0].delta.tool_calls).toEqual([])
    expect(frames[1].choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        id: 'a',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"中文"}' },
      },
    ])
    expect(frames[2].choices[0].delta.tool_calls).toEqual([{ index: 0, function: {} }])
    expect(output).toContain('data: [DONE]')
  })
  it('does not repair invalid functions or rewrite ordinary text and terminal fields', async () => {
    const input =
      ': ping\n\ndata: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\n' +
      frame([{ index: 0, function: null }])
    expect(await transform([Buffer.from(input)])).toBe(input)
  })
  it('rejects incomplete metadata and conflicting ids instead of fabricating a tool', async () => {
    await expect(
      transform([Buffer.from(frame([{ index: 0, id: 'a' }]) + 'data: [DONE]\n\n')]),
    ).rejects.toThrow('incomplete tool metadata')
    await expect(
      transform([
        Buffer.from(
          frame([{ index: 0, id: 'a' }]) +
            frame([{ index: 0, id: 'b', function: { name: 'bash' } }]),
        ),
      ]),
    ).rejects.toThrow('Conflicting')
  })
  it('does not forward a successful terminal frame for an unfinished tool', async () => {
    const stream = toolDeltaStream()
    let output = ''
    stream.on('data', (chunk) => {
      output += chunk.toString()
    })
    const failed = new Promise<Error>((resolve) => stream.once('error', resolve))
    stream.end(frame([{ index: 0, id: 'a' }]) + 'data: [DONE]\n\n')
    expect((await failed).message).toContain('incomplete tool metadata')
    expect(output).not.toContain('[DONE]')
  })
  it('preserves request bytes and upstream errors, rejects foreign keys/models, and closes pending requests', async () => {
    const received: string[] = []
    let entered!: () => void
    const pending = new Promise<void>((resolve) => {
      entered = resolve
    })
    let disconnected!: () => void
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve
    })
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      received.push(body)
      expect(req.headers.authorization).toBe('Bearer owned-key')
      if (JSON.parse(body).stream) {
        res.once('close', disconnected)
        entered()
      } else
        res
          .writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
          .end('{"error":"quota"}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Missing fixture address')
    const relay = await startChatToolRelay({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'owned-key',
      model: 'owned-model',
    })
    const send = (body: string, key = relay.key) =>
      fetch(relay.baseURL + '/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + key },
        body,
      })
    try {
      expect((await send('{"model":"owned-model"}', 'wrong')).status).toBe(403)
      expect((await send('{"model":"other"}')).status).toBe(400)
      const body = '{ "model": "owned-model", "messages": [] }'
      const result = await send(body)
      expect(result.status).toBe(429)
      expect(result.headers.get('retry-after')).toBe('7')
      expect(await result.text()).toBe('{"error":"quota"}')
      expect(received).toEqual([body])
      const request = send('{"model":"owned-model","stream":true}').catch(() => undefined)
      await pending
      await relay.close()
      await Promise.all([request, closed])
      expect(received).toHaveLength(2)
    } finally {
      await relay.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
