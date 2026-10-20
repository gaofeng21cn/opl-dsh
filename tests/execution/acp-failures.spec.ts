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
  expect(String(failure)).toContain('执行本轮请求')
  expect(String(failure)).not.toMatch(/synthetic-private-key|登录/)
})

it.each([429, 503])(
  'preserves structured HTTP %s without reflecting the response',
  async (status) => {
    const instance = connect(`
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request=JSON.parse(line)
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32603,
        message:'synthetic-private-key',data:{service:'session',errorName:'APIError',
        details:{statusCode:${status},responseBody:'synthetic-private-key'}}}})+'\\n')
    })
  `)
    const failure = String(await instance.request('session/prompt', {}).catch((error) => error))
    expect(failure).toContain(`HTTP ${status}`)
    expect(failure).toContain('APIError')
    expect(failure).toContain('RPC -32603')
    expect(failure).not.toMatch(/synthetic-private-key|尚未提供可确认的 HTTP/)
  },
)

it('preserves the native bridge RPC diagnostic beneath its fixed ACP error code', async () => {
  const instance = connect(`
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request=JSON.parse(line)
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:'HARNESS_EXECUTION',
        data:{service:'codex',rpcCode:-32000,httpStatus:503,terminalState:'failed'},
        message:'synthetic-private-key'}})+'\\n')
    })
  `)
  const failure = String(await instance.request('session/prompt', {}).catch((error) => error))
  expect(failure).toContain('Codex')
  expect(failure).toContain('HTTP 503')
  expect(failure).toContain('RPC -32000')
  expect(failure).not.toMatch(/synthetic-private-key|认证/)
})

it.each([
  ['APIError', '模型接口请求失败'],
  ['ContextOverflowError', '上下文容量'],
  ['StructuredOutputError', '结构化输出'],
  ['synthetic-private-error-name', '尚不能确定'],
])(
  'interprets the official session error %s without echoing arbitrary diagnostics',
  async (errorName, expected) => {
    const instance = connect(`
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request=JSON.parse(line)
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,
        error:{code:-32603,message:'synthetic-private-key',data:{service:'session',errorName:${JSON.stringify(errorName)},details:'synthetic-private-key'}}})+String.fromCharCode(10))
    })
  `)
    const failure = await instance.request('session/prompt', {}).catch((error: unknown) => error)
    expect(String(failure)).toContain(expected)
    expect(String(failure)).not.toMatch(/synthetic-private|等待本轮结果/)
  },
)

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
