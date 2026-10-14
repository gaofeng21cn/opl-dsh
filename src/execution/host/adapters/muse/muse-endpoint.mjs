/** Translate Muse MCP namespaces to the OFM listener's flat Responses tools. */
import { createServer } from 'node:http'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

/** Preserve namespace identities across tool declarations, history and returned calls. */
export function museToolWire(body) {
  const byName = new Map()
  const byIdentity = new Map()
  const byCandidate = new Map()
  const tools = []
  const add = (tool, namespace) => {
    if (tool?.type !== 'function' || typeof tool.name !== 'string')
      throw Error('Muse tool declaration is unsupported')
    const identity = namespace ? `${namespace}.${tool.name}` : tool.name
    const candidate = namespace ? `${namespace}__${tool.name}` : tool.name
    const name =
      candidate.length <= 64
        ? candidate
        : `opl_muse_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
    if (byName.has(name)) throw Error('Muse tool names collide')
    byName.set(name, { name: candidate })
    byIdentity.set(identity, name)
    byCandidate.set(candidate, name)
    tools.push({ ...tool, name })
  }
  for (const tool of body.tools ?? []) {
    if (tool?.type === 'namespace') {
      if (typeof tool.name !== 'string' || !Array.isArray(tool.tools))
        throw Error('Invalid Muse namespace')
      for (const nested of tool.tools) add(nested, tool.name)
    } else add(tool)
  }
  const input = Array.isArray(body.input)
    ? body.input.map((item) => {
        if (item?.type !== 'function_call') return item
        const name = item.namespace
          ? byIdentity.get(`${item.namespace}.${item.name}`)
          : (byCandidate.get(item.name) ?? byIdentity.get(item.name))
        if (!name) throw Error('Muse history references an undeclared tool')
        const { namespace, ...flat } = item
        return { ...flat, name }
      })
    : body.input
  const restoreItem = (item) => {
    if (item?.type !== 'function_call') return item
    const original = byName.get(item.name)
    if (!original) throw Error('Endpoint returned an undeclared Muse tool')
    return { ...item, ...original }
  }
  const restoreResponse = (response) =>
    response && Array.isArray(response.output)
      ? { ...response, output: response.output.map(restoreItem) }
      : response
  const announced = new Map()
  const settled = new Set()
  let sequence = 0
  return {
    body: {
      ...body,
      tools,
      input,
      ...(body.reasoning?.effort && !body.reasoning_effort
        ? { reasoning_effort: body.reasoning.effort }
        : {}),
    },
    restore(value) {
      const result = { ...value }
      if (result.item) result.item = restoreItem(result.item)
      if (result.response) result.response = restoreResponse(result.response)
      if (Array.isArray(result.output)) result.output = result.output.map(restoreItem)
      if (result.type === 'response.function_call_arguments.done' && result.name) {
        const original = byName.get(result.name)
        if (!original) throw Error('Endpoint returned an undeclared Muse tool')
        Object.assign(result, original)
      }
      return result
    },
    events(value) {
      const event = this.restore(value)
      if (event.type === 'response.output_item.added' && event.item?.type === 'function_call')
        announced.set(event.item.call_id, {
          item_id: event.item.item_id ?? event.item.id,
          output_index: event.output_index,
        })
      if (event.type === 'response.function_call_arguments.done') settled.add(event.call_id)
      const events = []
      if (event.type === 'response.completed') {
        for (const [output_index, item] of (event.response?.output ?? []).entries()) {
          if (item.type !== 'function_call' || settled.has(item.call_id)) continue
          settled.add(item.call_id)
          events.push({
            ...item,
            type: 'response.function_call_arguments.done',
            item_id:
              item.item_id ?? item.id ?? announced.get(item.call_id)?.item_id ?? item.call_id,
            output_index: announced.get(item.call_id)?.output_index ?? output_index,
          })
        }
      }
      events.push(event)
      return events.map((event) => ({ ...event, sequence_number: ++sequence }))
    },
  }
}

/** Bind one authenticated loopback relay; close aborts and drains owned requests. */
export async function startMuseEndpoint({ baseURL, apiKey }) {
  const source = new URL(baseURL)
  if (
    !['http:', 'https:'].includes(source.protocol) ||
    source.username ||
    source.password ||
    source.search ||
    source.hash
  )
    throw Error('Invalid Muse source endpoint')
  const token = randomBytes(32).toString('hex')
  const work = new Set()
  let closing = false
  const server = createServer((req, res) => {
    const abort = new AbortController()
    const expected = Buffer.from(`Bearer ${token}`)
    const received = Buffer.from(req.headers.authorization ?? '')
    if (closing || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.writeHead(401)
      res.end()
      return
    }
    res.on('close', () => {
      if (!res.writableEnded) abort.abort()
    })
    const operation = (async () => {
      try {
        const path = req.url
        if (
          !(req.method === 'POST' && path === '/responses') &&
          !(req.method === 'GET' && path === '/muse-code/models')
        ) {
          res.writeHead(404)
          res.end()
          return
        }
        let size = 0
        const parts = []
        for await (const chunk of req) {
          size += chunk.length
          if (size > 64 * 1024 * 1024) throw Error('Muse request exceeds the relay input limit')
          parts.push(chunk)
        }
        const wire =
          req.method === 'POST'
            ? museToolWire(JSON.parse(Buffer.concat(parts).toString('utf8')))
            : undefined
        const upstream = await fetch(`${source.href.replace(/\/$/u, '')}${path}`, {
          method: req.method,
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          ...(wire ? { body: JSON.stringify(wire.body) } : {}),
          signal: abort.signal,
          redirect: 'error',
        })
        const contentType = upstream.headers.get('content-type') ?? 'application/json'
        res.writeHead(upstream.status, { 'content-type': contentType })
        if (!wire || !upstream.ok) {
          for await (const chunk of upstream.body ?? []) res.write(chunk)
        } else if (contentType.includes('text/event-stream')) {
          let buffer = ''
          const decoder = new TextDecoder()
          for await (const chunk of upstream.body ?? []) {
            buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/gu, '\n')
            let end
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end)
              buffer = buffer.slice(end + 2)
              const data = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('\n')
              if (!data || data === '[DONE]') res.write(frame + '\n\n')
              else
                for (const event of wire.events(JSON.parse(data)))
                  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            }
          }
          buffer = (buffer + decoder.decode()).replace(/\r\n/gu, '\n')
          if (buffer.trim()) throw Error('Muse endpoint stream ended inside a frame')
        } else res.write(JSON.stringify(wire.restore(await upstream.json())))
        res.end()
      } catch {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              error: { type: 'server_error', message: 'Muse endpoint relay failed' },
            }),
          )
        } else res.destroy()
      }
    })()
    work.add({ operation, abort })
    operation.finally(() => {
      for (const entry of work) if (entry.operation === operation) work.delete(entry)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    apiKey: token,
    async close() {
      closing = true
      for (const entry of work) entry.abort.abort()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await Promise.allSettled([...work].map((entry) => entry.operation))
    },
  }
}
