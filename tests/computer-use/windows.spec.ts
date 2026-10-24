import { afterEach, expect, it } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KimiCuClient, kimiCuResult } from '../../src/computer-use/host/kimi-cu.ts'
import {
  windowsKimiCuCall,
  windowsKimiCuLaunch,
  WINCU_ACTIONS,
} from '../../src/computer-use/host/windows.ts'

const roots: string[] = []
const clients: KimiCuClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await Promise.all(
    roots
      .splice(0)
      .map((p) => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  )
})
async function fixture(js = true) {
  const root = await mkdtemp(join(tmpdir(), 'wincu-mcp-'))
  roots.push(root)
  const file = join(root, 'mcp.mjs')
  const log = join(root, 'calls.jsonl')
  await writeFile(
    file,
    `import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs';
  createInterface({input:process.stdin}).on('line', l => {
    const m=JSON.parse(l); appendFileSync(${JSON.stringify(log)},l+String.fromCharCode(10));
    let result;
    if(m.method==='initialize') result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    else if(m.method==='tools/list') result={tools:${js ? "[{name:'js'}]" : '[]'}};
    else if(m.method==='tools/call') {
      if(m.params.arguments.code.includes('hang-marker')) return;
      result={content:[{type:'text',text:JSON.stringify(m.params)}, {type:'image',mimeType:'image/png',data:'iVBORw=='}]};
    } else return;
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+String.fromCharCode(10));
  });`,
  )
  const client = new KimiCuClient(file, [], { codeMode: true })
  clients.push(client)
  return { client, log }
}
it('uses code mode and never advertises macOS-only methods on Windows', () => {
  expect(WINCU_ACTIONS).toContain('drag_path')
  expect(WINCU_ACTIONS).not.toContain('get_app_state')
  expect(() => windowsKimiCuCall('get_app_state', {})).toThrow('不支持')
  const payload = windowsKimiCuCall('type_text', {
    text: '"); throw Error("injected") //',
    window: { id: 1, app: 'a' },
  })
  expect(payload.name).toBe('js')
  expect(payload.arguments.code).toContain(
    JSON.stringify({ text: '"); throw Error("injected") //', window: { id: 1, app: 'a' } }),
  )
})
it('refuses missing complete plugin and relative configuration before starting', () => {
  expect(() => windowsKimiCuLaunch({ OPL_KIMI_CU_WINDOWS_ROOT: 'relative' })).toThrow(
    '安装目录无效',
  )
  expect(() =>
    windowsKimiCuLaunch({ OPL_KIMI_CU_WINDOWS_ROOT: join(tmpdir(), 'missing-wincu-plugin') }),
  ).toThrow('ENOENT')
})
it('negotiates js once and preserves official image and text content', async () => {
  const { client, log } = await fixture()
  await Promise.all([client.start(), client.start()])
  const result = kimiCuResult(await client.call('list_windows', {}, new AbortController().signal))
  expect(JSON.parse(result.text).name).toBe('js')
  expect(result.images).toHaveLength(1)
  const calls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  expect(calls.filter((c) => c.method === 'initialize')).toHaveLength(1)
  expect(calls.findIndex((c) => c.method === 'tools/list')).toBeLessThan(
    calls.findIndex((c) => c.method === 'tools/call'),
  )
})
it('refuses a server without js before sending any desktop action', async () => {
  const { client, log } = await fixture(false)
  await expect(client.call('click', {}, new AbortController().signal)).rejects.toThrow('未广告')
  expect(await readFile(log, 'utf8')).not.toContain('tools/call')
})
it('pre-cancelled actions never start a process, and cancellation closes the owned frontend', async () => {
  const { client, log } = await fixture()
  const early = new AbortController()
  early.abort()
  await expect(client.call('click', {}, early.signal)).rejects.toThrow('取消')
  await expect(readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await client.start()
  const controller = new AbortController()
  const pending = client.call('type_text', { text: 'hang-marker' }, controller.signal)
  controller.abort()
  await expect(pending).rejects.toThrow('取消')
  await client.close()
  await expect(client.start()).rejects.toThrow('关闭')
})
