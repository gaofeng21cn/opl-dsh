import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getTraceable, symbols, type Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { createOfmOwnerApiReader } from '../../src/execution/host/ofm-owner-api.ts'

const servers: Server[] = []
const cleanups: (() => void)[] = []
afterEach(async () => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

async function fixture(
  options: {
    admissionDenied?: boolean
    pause?: Promise<void>
    responseStatus?: number
    loginStatus?: number
  } = {},
) {
  const requests: string[] = []
  let entered!: () => void
  const readStarted = new Promise<void>((resolve) => {
    entered = resolve
  })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`)
    if (url.pathname === '/') {
      if (url.searchParams.get('token') !== 'dummy-launch') {
        res.writeHead(401)
        res.end()
        return
      }
      res.writeHead(options.loginStatus ?? 303, {
        location: './',
        'set-cookie': 'dsh-test=dummy-cookie; HttpOnly; SameSite=Strict',
      })
      res.end()
      return
    }
    requests.push(url.pathname)
    if (options.admissionDenied || req.headers.cookie !== 'dsh-test=dummy-cookie') {
      res.writeHead(401)
      res.end()
      return
    }
    entered()
    await options.pause
    if (res.destroyed) return
    res.writeHead(options.responseStatus ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ key: 'fixture-key-only' }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const connection = { authenticatedUrl: (base: string) => base + '?token=dummy-launch' }
  const webServer = {
    host: '127.0.0.1',
    protocol: 'http:',
    port: (server.address() as AddressInfo).port,
  }
  const services: Record<string, unknown> = { connection, webServer }
  const ctx = {
    get: (name: string) => services[name],
    effect: (effect: () => () => void) => {
      const cleanup = effect()
      cleanups.push(cleanup)
      return cleanup
    },
  } as unknown as Context
  return {
    reader: createOfmOwnerApiReader(ctx, 5000),
    requests,
    services,
    webServer,
    readStarted,
    ctx,
  }
}

it('uses the normal login exchange and admitted public API', async () => {
  const test = await fixture()
  await expect(test.reader.read('/forward/key')).resolves.toEqual({ key: 'fixture-key-only' })
  expect(test.requests).toEqual(['/api/our-free-model/forward/key'])
})

it('accepts the earlier login redirect while retaining cookie admission', async () => {
  const test = await fixture({ loginStatus: 302 })
  await expect(test.reader.read('/clients')).resolves.toEqual({ key: 'fixture-key-only' })
})

it('rejects a successful response without the login redirect', async () => {
  const test = await fixture({ loginStatus: 200 })
  await expect(test.reader.read('/clients')).rejects.toThrow('公开连接读取失败')
  expect(test.requests).toEqual([])
})

it('uses the HTTP listener published by official rc.2 without a protocol getter', async () => {
  const test = await fixture()
  Reflect.deleteProperty(test.webServer, 'protocol')
  await expect(test.reader.read('/clients')).resolves.toEqual({ key: 'fixture-key-only' })
  expect(test.requests).toEqual(['/api/our-free-model/clients'])
})

it('retains service identity across fresh Cordis caller-context proxies', async () => {
  const test = await fixture()
  for (const name of ['connection', 'webServer']) {
    const service = test.services[name] as object
    Reflect.set(service, symbols.tracker, { property: 'ctx', noShadow: true })
  }
  test.ctx.get = ((name: string) => getTraceable(test.ctx, test.services[name])) as Context['get']
  expect(test.ctx.get('connection')).not.toBe(test.ctx.get('connection'))
  await expect(test.reader.read('/clients')).resolves.toEqual({ key: 'fixture-key-only' })
})

it('does not bypass owner admission or expose its response text', async () => {
  const test = await fixture({ admissionDenied: true })
  await expect(test.reader.read('/forward/key')).rejects.toThrow('公开连接读取失败')
  expect(test.requests).toHaveLength(1)
})

it('does not forward launch tokens to a different origin', async () => {
  const test = await fixture()
  test.services.connection = { authenticatedUrl: () => 'http://192.0.2.1/?token=dummy-launch' }
  await expect(test.reader.read('/forward/key')).rejects.toThrow('公开连接读取失败')
  expect(test.requests).toEqual([])
})

it('refuses non-loopback listeners before requesting authentication', async () => {
  const test = await fixture()
  test.webServer.host = '192.0.2.1'
  await expect(test.reader.read('/summary')).rejects.toThrow('本机监听')
  expect(test.requests).toEqual([])
})

it('invalidates an old response when Connection is replaced during the read', async () => {
  let release!: () => void
  const pause = new Promise<void>((resolve) => {
    release = resolve
  })
  const test = await fixture({ pause })
  const pending = test.reader.read('/forward/key')
  await test.readStarted
  test.services.connection = { authenticatedUrl: () => '' }
  release()
  await expect(pending).rejects.toThrow('公开连接读取失败')
})

it('aborts an in-flight owner read when the scope unloads', async () => {
  let release!: () => void
  const pause = new Promise<void>((resolve) => {
    release = resolve
  })
  const test = await fixture({ pause })
  const pending = test.reader.read('/forward/key')
  await test.readStarted
  cleanups.splice(0).forEach((cleanup) => cleanup())
  release()
  await expect(pending).rejects.toThrow('公开连接读取失败')
})
