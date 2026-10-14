import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import {
  museToolWire,
  startMuseEndpoint,
} from '../../../src/execution/host/adapters/muse/muse-endpoint.mjs'

const declaration = {
  type: 'namespace',
  name: 'mcp__opl_muse_git_bash',
  tools: [
    {
      type: 'function',
      name: 'run',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
  ],
}
describe('Muse OFM Responses translation', () => {
  it('flattens declared tools and history, then restores namespace calls', () => {
    const wire = museToolWire({
      tools: [declaration],
      reasoning: { effort: 'max' },
      input: [
        {
          type: 'function_call',
          namespace: declaration.name,
          name: 'run',
          call_id: 'call1',
          arguments: '{}',
        },
      ],
    })
    expect(wire.body.tools[0]).toMatchObject({
      name: 'mcp__opl_muse_git_bash__run',
      parameters: declaration.tools[0].parameters,
    })
    expect(wire.body.reasoning_effort).toBe('max')
    expect(wire.body.input[0]).not.toHaveProperty('namespace')
    expect(
      wire.restore({
        type: 'response.output_item.added',
        item: { type: 'function_call', name: wire.body.tools[0].name },
      }).item,
    ).toMatchObject({ name: 'mcp__opl_muse_git_bash__run' })
    expect(
      wire.restore({
        response: { output: [{ type: 'function_call', name: wire.body.tools[0].name }] },
      }).response.output[0],
    ).toMatchObject({ name: 'mcp__opl_muse_git_bash__run' })
  })
  it('rejects unknown calls, collisions and unavailable history tools', () => {
    const wire = museToolWire({ tools: [declaration] })
    expect(() => wire.restore({ item: { type: 'function_call', name: 'undeclared' } })).toThrow(
      /undeclared/,
    )
    expect(() =>
      museToolWire({
        tools: [declaration, { type: 'function', name: 'mcp__opl_muse_git_bash__run' }],
      }),
    ).toThrow(/collide/)
    expect(() =>
      museToolWire({
        tools: [],
        input: [{ type: 'function_call', namespace: 'other', name: 'run' }],
      }),
    ).toThrow(/undeclared/)
  })
  it('settles only real final calls once, preserves failure, and carries long names through history', () => {
    const tool = { type: 'function', name: 'x'.repeat(90), parameters: {} }
    const wire = museToolWire({
      tools: [tool],
      input: [{ type: 'function_call', name: tool.name, call_id: 'a', arguments: '{}' }],
    })
    const name = wire.body.tools[0].name
    expect(name.length).toBeLessThanOrEqual(64)
    expect(wire.body.input[0].name).toBe(name)
    expect(
      wire.events({ type: 'response.failed', response: { status: 'failed', output: [] } }),
    ).toHaveLength(1)
    const call = {
      type: 'function_call',
      name,
      call_id: 'a',
      arguments: '{"command":"git --version"}',
    }
    const complete = wire.events({ type: 'response.completed', response: { output: [call] } })
    expect(complete.map((event: any) => event.type)).toEqual([
      'response.function_call_arguments.done',
      'response.completed',
    ])
    expect(complete[0]).toMatchObject({ name: tool.name, arguments: call.arguments })
    expect(complete[1].sequence_number).toBe(complete[0].sequence_number + 1)
    expect(wire.events({ type: 'response.completed', response: { output: [call] } })).toHaveLength(
      1,
    )
  })
  it('preserves SSE frames when a CRLF delimiter crosses network chunks', async () => {
    const source = createServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        'data: ' +
          JSON.stringify({ type: 'response.failed', response: { status: 'failed' } }) +
          String.fromCharCode(13),
      )
      setImmediate(() => res.end(String.fromCharCode(10, 13, 10)))
    })
    await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve))
    const endpoint = await startMuseEndpoint({
      baseURL: `http://127.0.0.1:${(source.address() as any).port}`,
      apiKey: 'dummy',
    })
    try {
      const response = await fetch(endpoint.baseURL + '/responses', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + endpoint.apiKey },
        body: '{}',
      })
      const stream = await response.text()
      expect(stream).toContain('event: response.failed')
      expect(stream).not.toContain('response.completed')
      expect(stream).toContain('"sequence_number":1')
    } finally {
      await endpoint.close()
      source.closeAllConnections()
      await new Promise<void>((resolve) => source.close(() => resolve()))
    }
  })
  it('authenticates locally, forwards only owned routes and preserves failure status', async () => {
    const received: any[] = []
    const source = createServer(async (req, res) => {
      let text = ''
      for await (const chunk of req) text += chunk
      received.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(text),
      })
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'quota_error' } }))
    })
    await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve))
    const endpoint = await startMuseEndpoint({
      baseURL: `http://127.0.0.1:${(source.address() as any).port}/v1`,
      apiKey: 'dummy-upstream',
    })
    try {
      const call = (path: string, key: string) =>
        fetch(endpoint.baseURL + path, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + key },
          body: JSON.stringify({ tools: [declaration], input: [] }),
        })
      expect((await call('/responses', 'wrong')).status).toBe(401)
      expect((await call('/anything', endpoint.apiKey)).status).toBe(404)
      const result = await call('/responses', endpoint.apiKey)
      expect(result.status).toBe(429)
      expect(await result.json()).toEqual({ error: { type: 'quota_error' } })
      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({
        url: '/v1/responses',
        authorization: 'Bearer dummy-upstream',
      })
      expect(received[0].body.tools[0].type).toBe('function')
    } finally {
      await endpoint.close()
      source.closeAllConnections()
      await new Promise<void>((resolve) => source.close(() => resolve()))
    }
  })
  it('drains an in-flight upstream when the relay closes', async () => {
    let started!: () => void
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    const source = createServer(() => started())
    await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve))
    const endpoint = await startMuseEndpoint({
      baseURL: `http://127.0.0.1:${(source.address() as any).port}`,
      apiKey: 'dummy',
    })
    const request = fetch(endpoint.baseURL + '/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + endpoint.apiKey },
      body: '{}',
    }).catch(() => null)
    try {
      await began
      await endpoint.close()
      await request
    } finally {
      source.closeAllConnections()
      await new Promise<void>((resolve) => source.close(() => resolve()))
    }
  })
})
