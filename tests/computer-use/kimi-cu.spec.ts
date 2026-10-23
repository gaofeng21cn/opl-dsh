import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  KIMI_CU_CALL_TIMEOUT_MS,
  KIMI_CU_EXECUTABLE,
  KIMI_CU_MCP_ARGS,
  KIMI_CU_TOOLS,
  KimiCuClient,
  kimiCuFailure,
  kimiCuResult,
} from '../../src/computer-use/host/kimi-cu.ts'
import { KIMI_CU_MUTATIONS } from '../../src/computer-use/host/index.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A real stdio MCP process with a controlled tool result and cancellation observation. */
async function fakeMcp(): Promise<{ executable: string; calls: () => Promise<string[]> }> {
  const root = await mkdtemp(join(tmpdir(), 'opl-dsh-kimi-cu-'))
  roots.push(root)
  const executable = join(root, 'fake-kimi-cu.mjs')
  const calls = join(root, 'calls.jsonl')
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const calls = ${JSON.stringify(calls)}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i)
    buffer = buffer.slice(i + 1)
    const m = JSON.parse(line)
    if (m.method === 'initialize')
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-kimi-cu', version: '0.6.6' } } }) + '\\n')
    else if (m.method === 'tools/call') {
      appendFileSync(calls, JSON.stringify(m.params) + '\\n')
      const finish = () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'fixture result' }], structuredContent: { ok: true } } }) + '\\n')
      if (m.params.arguments.wait) setTimeout(finish, 10000)
      else finish()
    }
  }
})
`,
    { mode: 0o700 },
  )
  return {
    executable,
    calls: async () =>
      (await readFile(calls, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { name: string }).name),
  }
}

describe('KimiCU MCP bridge', () => {
  it('uses the verified KimiCU contract and preserves the original action vocabulary', () => {
    expect(KIMI_CU_EXECUTABLE).toBe('/Applications/KimiCU.app/Contents/MacOS/kimi-cu')
    expect(KIMI_CU_MCP_ARGS).toEqual(['mcp', '-s', 'user'])
    expect(KIMI_CU_CALL_TIMEOUT_MS).toBe(30_000)
    expect(KIMI_CU_TOOLS).toContain('get_app_state')
    expect(KIMI_CU_TOOLS).toContain('drag_paths')
    expect(KIMI_CU_MUTATIONS.has('get_app_state')).toBe(false)
    expect(KIMI_CU_MUTATIONS.has('click')).toBe(true)
  })

  it('initializes, forwards one tool call, and maps text results', async () => {
    const fixture = await fakeMcp()
    const client = new KimiCuClient(fixture.executable, ['mcp', '-s', 'user'])
    const result = kimiCuResult(
      await client.call('list_apps', { running_only: true }, new AbortController().signal),
    )
    await client.close()
    expect(result).toMatchObject({ text: 'fixture result', isError: false, images: [] })
    expect(await fixture.calls()).toContain('list_apps')
  })

  it('cancels an in-flight call and does not leave a pending response', async () => {
    const fixture = await fakeMcp()
    const client = new KimiCuClient(fixture.executable, ['mcp', '-s', 'user'])
    const controller = new AbortController()
    await client.start()
    const call = client.call('click', { wait: true }, controller.signal)
    controller.abort()
    await expect(call).rejects.toThrow('取消')
    await client.close()
  })

  it('preserves KimiCU image blocks and reports tool errors', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    expect(
      kimiCuResult({
        content: [
          { type: 'text', text: 'captured' },
          { type: 'image', data: png, mimeType: 'image/png' },
        ],
      }),
    ).toMatchObject({
      text: 'captured',
      isError: false,
      images: [{ mediaType: 'image/png', name: 'kimi-cu-1.png' }],
    })
    expect(
      kimiCuResult({ isError: true, content: [{ type: 'text', text: 'permission required' }] }),
    ).toMatchObject({ text: 'permission required', isError: true })
  })

  it('keeps the original service error when a companion diagnostic is unavailable', () => {
    expect(
      kimiCuFailure(
        {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'service unavailable: connection to ai.kimi.cu.service was invalidated',
            },
          ],
        },
        join(tmpdir(), 'missing-kimi-cu-executable'),
      ),
    ).toMatch(/service unavailable/u)
  })
})
