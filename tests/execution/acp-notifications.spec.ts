/**
 * ACP 传输的扩展通知与请求分流。
 *
 * 官方 ACP 只定义 `session/update`，其余通知必须由使用方自行取用；而带 id 的是发往
 * 本方的请求，必须照常回应。两者混在一起会让审批永远等不到回应，因此分别钉住。
 */
import { afterEach, expect, it, vi } from 'vitest'
import { AcpProcess } from '../../src/execution/host/acp.ts'

/** 子进程先发一条权限请求、一条扩展通知、一条未声明的请求，再按收到的回应回报。 */
const CHILD = `
let buffer = ''
process.stdout.write([
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/request_permission', params: { toolName: 'bash' } }),
  JSON.stringify({ jsonrpc: '2.0', method: 'opl/session/history/boundary', params: { clientRequestId: 'op-1', userMessageId: 'u1' } }),
  JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/not_declared' }),
].join('\\n') + '\\n')
process.stdin.on('data', (chunk) => {
  buffer += String(chunk)
  if (buffer.includes('"id":1') && buffer.includes('selected'))
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'test/answered', params: { id: 1 } }) + '\\n')
  if (buffer.includes('"id":2') && buffer.includes('-32601'))
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'test/rejected', params: { id: 2 } }) + '\\n')
  if (buffer.includes('test/rejected')) setTimeout(() => process.exit(0), 30)
})
setTimeout(() => process.exit(0), 4000)
`

let transport: AcpProcess | undefined
afterEach(async () => {
  await transport?.dispose()
  transport = undefined
})

function connect() {
  const notifications: { method: string; params: unknown }[] = []
  let instance: AcpProcess | undefined
  instance = new AcpProcess(
    process.execPath,
    ['-e', CHILD],
    process.cwd(),
    process.env,
    () => {
      throw Error('本用例不应收到 session/update')
    },
    (id, params) => {
      // 权限请求必须立刻得到回应，否则子进程永远不会继续。
      instance?.answer(id, 'allow')
      notifications.push({ method: 'answered-permission', params })
    },
    () => {},
    false,
    (method, params) => notifications.push({ method, params }),
  )
  transport = instance
  return {
    notifications,
    async settle() {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        if (notifications.some((item) => item.method === 'test/rejected')) return
      }
    },
  }
}

it('扩展通知交给使用方，官方 update 不受影响', async () => {
  const handle = connect()
  await handle.settle()
  expect(handle.notifications).toContainEqual({
    method: 'opl/session/history/boundary',
    params: { clientRequestId: 'op-1', userMessageId: 'u1' },
  })
})

it('权限请求仍走它自己的通道：被回应，而不是被扩展通知吞掉', async () => {
  const handle = connect()
  await handle.settle()
  const answered = handle.notifications.filter((item) => item.method === 'answered-permission')
  expect(answered).toEqual([{ method: 'answered-permission', params: { toolName: 'bash' } }])
  // 子进程只有收到那条回应才会回报 test/answered。
  expect(handle.notifications).toContainEqual({ method: 'test/answered', params: { id: 1 } })
})

it('未声明的客户端请求仍然按 -32601 拒绝，不会被扩展通知改写', async () => {
  const handle = connect()
  await handle.settle()
  expect(handle.notifications).toContainEqual({ method: 'test/rejected', params: { id: 2 } })
})

it('仅响应适配器显式绑定的私有请求，失败不回显凭据诊断', async () => {
  const notifications: unknown[] = []
  const child = `
    const {createInterface} = require('node:readline')
    for (const [id, method] of [[1,'opl/credential'],[2,'opl/failure'],[3,'credentials/arbitrary'],[4,'opl/empty']])
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,method,params:{ref:'OTHER_KEY'}})+'\\n')
    createInterface({input:process.stdin}).on('line',line=>{
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'test/reply',params:JSON.parse(line)})+'\\n')
    })
  `
  transport = new AcpProcess(
    process.execPath,
    ['-e', child],
    process.cwd(),
    process.env,
    () => {},
    () => {},
    () => {},
    false,
    (_method, params) => {
      notifications.push(params)
    },
    new Map<string, () => Promise<unknown>>([
      ['opl/credential', async () => 'synthetic-bound-key'],
      ['opl/empty', async () => undefined],
      [
        'opl/failure',
        async () => {
          throw Error('must-not-leak-key')
        },
      ],
    ]),
  )
  await vi.waitFor(() => expect(notifications).toHaveLength(4))
  expect(notifications).toContainEqual({ jsonrpc: '2.0', id: 1, result: 'synthetic-bound-key' })
  expect(notifications).toContainEqual({
    jsonrpc: '2.0',
    id: 2,
    error: { code: -32603, message: 'Bridge request failed' },
  })
  expect(notifications).toContainEqual({
    jsonrpc: '2.0',
    id: 3,
    error: { code: -32601, message: 'Unsupported ACP client request' },
  })
  expect(notifications).toContainEqual({ jsonrpc: '2.0', id: 4, result: null })
  expect(JSON.stringify(notifications)).not.toContain('must-not-leak-key')
})
