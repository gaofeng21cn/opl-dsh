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

it('closes a prompt that never reports progress with a fixed diagnostic', async () => {
  const instance = connect(`process.stdin.resume()`)
  const failure = await instance
    .request('session/prompt', { sessionId: 'session-1' }, 10_000, {
      firstProgressTimeoutMs: 30,
      firstProgressTimeoutMessage: 'OpenCode 未报告本轮进展',
      isProgress: (method, params) =>
        method === 'session/update' && (params as { sessionId?: string }).sessionId === 'session-1',
    })
    .catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(HarnessTransportError)
  expect(String(failure)).toContain('OpenCode 未报告本轮进展（执行本轮请求）')
})

it('removes the first-progress guard after an ACP update', async () => {
  const instance = connect(`
    const rl=require('node:readline').createInterface({input:process.stdin})
    rl.on('line', line => {
      const request=JSON.parse(line)
      if (request.method !== 'session/prompt') return
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session-1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ok'}}}})+'\\n')
      setTimeout(() => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{stopReason:'end_turn'}})+'\\n'), 60)
    })
  `)
  const result = await instance.request('session/prompt', { sessionId: 'session-1' }, 500, {
    firstProgressTimeoutMs: 200,
    isProgress: (method, params) =>
      method === 'session/update' && (params as { sessionId?: string }).sessionId === 'session-1',
  })
  expect(result).toEqual({ stopReason: 'end_turn' })
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

it('ends an owned prompt on its fixed stderr diagnostic without waiting for timeout', async () => {
  const instance = connect(
    `require('node:readline').createInterface({input:process.stdin}).on('line', () => process.stderr.write('owned-failure'+String.fromCharCode(10)))`,
  )
  const failure = await instance
    .request('session/prompt', { sessionId: 'owned' }, 10000, {
      stderrFailure: (line) => (line === 'owned-failure' ? '固定失败' : undefined),
    })
    .catch((error: unknown) => error)
  expect(String(failure)).toContain('固定失败')
  expect(String(failure)).not.toContain('超时')
})

it('rejects a pending request immediately, ignores late notifications, and ends its child', async () => {
  const updates: unknown[] = []
  transport = new AcpProcess(
    process.execPath,
    [
      '-e',
      `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const request=JSON.parse(line)
        if (request.method === 'session/prompt') setTimeout(() => {
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{late:true}})+String.fromCharCode(10))
        }, 40)
      })`,
    ],
    process.cwd(),
    process.env,
    (value) => updates.push(value),
    () => {},
    () => {},
  )
  const child = transport
  const pending = child.request('session/prompt', {}, 10_000).catch((error: unknown) => error)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const termination = child.terminate('固定截止诊断')
  const failure = await pending
  expect(failure).toBeInstanceOf(HarnessTransportError)
  expect(String(failure)).toContain('固定截止诊断（执行本轮请求）')
  await termination
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(updates).toEqual([])
  expect(child.closed).toBe(true)
  expect(child['child'].exitCode).not.toBeNull()
})
