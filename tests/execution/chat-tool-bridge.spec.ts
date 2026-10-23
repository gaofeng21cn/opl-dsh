import { openCodeStreamFailure } from '../../src/execution/host/adapters/opencode/stream-failure.ts'
import { build } from 'esbuild'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AcpProcess, HarnessTransportError } from '../../src/execution/host/acp.ts'
import { openCodeProfileRoots } from '../../src/execution/host/adapters/opencode/opencode.ts'

let root: string
let bridge: string
let fixture: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'opl-chat-error-'))
  bridge = process.env.OPL_CHAT_TEST_BRIDGE ?? join(root, 'bridge.mjs')
  fixture = join(root, 'cli.mjs')
  if (!process.env.OPL_CHAT_TEST_BRIDGE) {
    const bundled = await build({
      entryPoints: ['src/execution/host/adapters/chat-tool-bridge.ts'],
      outfile: bridge,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      write: false,
    })
    await writeFile(bridge, bundled.outputFiles[0]!.contents)
  }
  await writeFile(
    fixture,
    `
    import { createInterface } from 'node:readline'
    const family = process.env.KILO_CONFIG_CONTENT ? 'kilo' : 'opencode'
    const provider = JSON.parse(process.env[family === 'kilo' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT']).provider[family === 'kilo' ? 'oplkilo' : 'oplopencode']
    const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n')
    createInterface({input:process.stdin}).on('line', async line => {
      const m = JSON.parse(line)
      if (m.method !== 'session/prompt') { reply(m.id, {}); return }
      // This fixture deliberately retries failed HTTP requests and never reports
      // their ACP error, matching the observed OpenCode failure path.
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const response = await fetch(provider.options.baseURL+'/chat/completions', {
            method:'POST', headers:{authorization:'Bearer '+provider.options.apiKey},
            body:JSON.stringify({model:Object.keys(provider.models)[0],stream:true})
          })
          await response.text()
          if (!response.ok) continue
          reply(m.id,{stopReason:'end_turn'}); return
        } catch { }
      }
    })
  `,
  )
})
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

it.each(['opencode', 'kilo'])(
  '%s reports the first upstream HTTP failure before its body ends and prevents retries',
  async (family) => {
    for (const status of [403, 429, 503, 0]) {
      let requests = 0
      const server = createServer((req, res) => {
        requests++
        req.resume()
        if (status === 0) {
          req.socket.destroy()
          return
        }
        // The error body intentionally never ends. Receipt of headers is enough.
        res.writeHead(status, { 'content-type': 'application/json' })
        res.flushHeaders()
        res.write('{"error":"synthetic-private-key')
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw Error('Missing fixture port')
      const key = family === 'kilo' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT'
      const provider = family === 'kilo' ? 'oplkilo' : 'oplopencode'
      const acp = new AcpProcess(
        process.execPath,
        [bridge],
        root,
        {
          SystemRoot: process.env.SystemRoot,
          PATH: process.env.PATH,
          TEMP: root,
          TMP: root,
          OPL_CHAT_CLI: family,
          OPL_CHAT_COMMAND: process.execPath,
          OPL_CHAT_ARGS: JSON.stringify([fixture]),
          [key]: JSON.stringify({
            provider: {
              [provider]: {
                options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'owned-key' },
                models: { 'owned-model': {} },
              },
            },
          }),
        },
        () => {},
        () => {},
        () => {},
      )
      try {
        const failure = await acp
          .request('session/prompt', { sessionId: 'owned' }, 8000)
          .catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(HarnessTransportError)
        if (status) expect(String(failure)).toContain(`HTTP ${status}`)
        else {
          expect(String(failure)).toContain('连接或响应流中断')
          expect(String(failure)).not.toContain('HTTP')
        }
        expect(String(failure)).not.toMatch(/synthetic-private-key|请求超时/)
      } finally {
        await acp.dispose()
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      expect(requests).toBe(1)
    }
  },
  30000,
)

it('preserves a successful prompt through the same bridge', async () => {
  const server = createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Missing fixture port')
  const acp = new AcpProcess(
    process.execPath,
    [bridge],
    root,
    {
      SystemRoot: process.env.SystemRoot,
      PATH: process.env.PATH,
      TEMP: root,
      TMP: root,
      OPL_CHAT_CLI: 'opencode',
      OPL_CHAT_COMMAND: process.execPath,
      OPL_CHAT_ARGS: JSON.stringify([fixture]),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          oplopencode: {
            options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'owned-key' },
            models: { 'owned-model': {} },
          },
        },
      }),
    },
    () => {},
    () => {},
    () => {},
  )
  try {
    expect(await acp.request('session/prompt', { sessionId: 'owned' }, 8000)).toEqual({
      stopReason: 'end_turn',
    })
  } finally {
    await acp.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 15000)

it.skipIf(!process.env.OPENCODE_OFFICIAL_BINARY).each([403, 429])(
  'official OpenCode propagates HTTP %s through the built bridge without retrying',
  async (status) => {
    const home = await mkdtemp(join(root, 'official-'))
    const profile = openCodeProfileRoots(home)
    for (const directory of Object.values(profile)) await mkdir(directory, { recursive: true })
    let requests = 0
    const server = createServer((req, res) => {
      requests++
      req.resume()
      res.writeHead(status, { 'content-type': 'application/json' }).flushHeaders()
      res.write('{"error":"synthetic-private-key')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Missing fixture port')
    const acp = new AcpProcess(
      process.execPath,
      [bridge],
      home,
      {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        TEMP: home,
        TMP: home,
        ...profile,
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPL_CHAT_CLI: 'opencode',
        OPL_CHAT_COMMAND: process.env.OPENCODE_OFFICIAL_BINARY!,
        OPL_CHAT_ARGS: JSON.stringify(['acp', '--cwd', home]),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: {
            oplopencode: {
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'owned-key' },
              models: { 'flint-40b-free': { name: 'flint-40b-free' } },
            },
          },
        }),
      },
      () => {},
      () => {},
      () => {},
    )
    try {
      await acp.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
          clientInfo: { name: 'owned-error-probe', version: '1' },
        },
        30000,
      )
      const session = (await acp.request('session/new', { cwd: home, mcpServers: [] }, 30000)) as {
        sessionId: string
      }
      await acp.request('session/set_config_option', {
        sessionId: session.sessionId,
        configId: 'model',
        value: 'oplopencode/flint-40b-free',
      })
      const failure = await acp
        .request(
          'session/prompt',
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'Reply OK without tools.' }],
          },
          15000,
        )
        .catch((error: unknown) => error)
      expect(String(failure)).toContain(`HTTP ${status}`)
      expect(String(failure)).not.toMatch(/synthetic-private-key|请求超时/)
    } finally {
      await acp.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    expect(requests).toBe(1)
  },
  90000,
)

it.skipIf(!process.env.OPENCODE_OFFICIAL_BINARY).each([429])(
  'official OpenCode stderr terminates a direct prompt on HTTP %s',
  async (status) => {
    const home = await mkdtemp(join(root, 'official-'))
    const profile = openCodeProfileRoots(home)
    for (const directory of Object.values(profile)) await mkdir(directory, { recursive: true })
    let requests = 0
    const server = createServer((req, res) => {
      requests++
      req.resume()
      res.writeHead(status, { 'content-type': 'application/json' }).flushHeaders()
      res.end(
        JSON.stringify({
          error: { message: 'Free usage limit reached.', type: 'rate_limit_error' },
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Missing fixture port')
    const acp = new AcpProcess(
      process.env.OPENCODE_OFFICIAL_BINARY!,
      ['acp', '--print-logs', '--cwd', home],
      home,
      {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        TEMP: home,
        TMP: home,
        ...profile,
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPL_CHAT_CLI: 'opencode',
        OPL_CHAT_COMMAND: process.env.OPENCODE_OFFICIAL_BINARY!,
        OPL_CHAT_ARGS: JSON.stringify(['acp', '--cwd', home]),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: {
            oplopencode: {
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'owned-key' },
              models: { 'flint-40b-free': { name: 'flint-40b-free' } },
            },
          },
        }),
      },
      () => {},
      () => {},
      () => {},
    )
    try {
      await acp.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
          clientInfo: { name: 'owned-error-probe', version: '1' },
        },
        30000,
      )
      const session = (await acp.request('session/new', { cwd: home, mcpServers: [] }, 30000)) as {
        sessionId: string
      }
      await acp.request('session/set_config_option', {
        sessionId: session.sessionId,
        configId: 'model',
        value: 'oplopencode/flint-40b-free',
      })
      const failure = await acp
        .request(
          'session/prompt',
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'Reply OK without tools.' }],
          },
          15000,
          { stderrFailure: (line) => openCodeStreamFailure(line, session.sessionId) },
        )
        .catch((error: unknown) => error)
      expect(String(failure)).toContain('额度已达上限')
      expect(String(failure)).not.toMatch(/synthetic-private-key|请求超时/)
    } finally {
      await acp.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    expect(requests).toBeGreaterThan(0)
  },
  90000,
)
