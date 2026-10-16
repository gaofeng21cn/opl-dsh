import { afterEach, expect, it } from 'vitest'
import { AcpProcess, HarnessTransportError } from '../../src/execution/host/acp.ts'

let transport: AcpProcess | undefined
afterEach(async () => {
  await transport?.dispose()
  transport = undefined
})

function connect(script: string): AcpProcess {
  return (transport = new AcpProcess(
    process.execPath,
    ['-e', script],
    process.cwd(),
    process.env,
    () => {},
    () => {},
    () => {},
  ))
}

it('keeps internal failures inconclusive and does not reflect provider diagnostics', async () => {
  const instance = connect(`
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request=JSON.parse(line)
      process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id,
        error:{code:-32603,message:'synthetic-private-key',data:{details:'synthetic-private-key'}}})+'\\n')
    })
  `)
  const failure = await instance.request('session/prompt', {}).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(HarnessTransportError)
  expect(String(failure)).toContain('等待本轮结果')
  expect(String(failure)).not.toMatch(/synthetic-private-key|登录/)
})

it('keeps process exit distinct from model failure', async () => {
  const instance = connect(`process.stdin.once('data', () => process.exit(2))`)
  const failure = await instance.request('session/load', {}).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(HarnessTransportError)
  expect(String(failure)).toContain('进程已结束（恢复会话）')
})

it('keeps a request timeout actionable without reporting an extension name', async () => {
  const instance = connect(`process.stdin.resume()`)
  const failure = await instance
    .request('synthetic-private-method', {}, 100)
    .catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(HarnessTransportError)
  expect(String(failure)).toContain('请求超时（扩展请求）')
  expect(String(failure)).not.toContain('synthetic-private-method')
})

it('reports a client-only free channel without suggesting a CLI login problem', async () => {
  const instance =
    connect(`require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const request=JSON.parse(line)
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:'HARNESS_PROVIDER_CLIENT_REQUIRED',message:'synthetic-private-key'}})+String.fromCharCode(10))
  })`)
  const failure = await instance.request('session/prompt', {}).catch((error: unknown) => error)
  expect(String(failure)).toContain('指定的官方客户端')
  expect(String(failure)).not.toMatch(/synthetic-private-key|登录/)
})
