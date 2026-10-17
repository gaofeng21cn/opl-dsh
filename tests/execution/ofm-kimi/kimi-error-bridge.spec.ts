/** Built bridge regression: a CLI that omits an HTTP failure must not report success. */
import { it, expect } from 'vitest'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

it('reports a sanitized provider failure and clears it before load and the next prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kimi-error-bridge-'))
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      calls++
      res.writeHead(calls === 1 ? 502 : 200, { 'content-type': 'application/json' })
      res.end(
        calls === 1
          ? JSON.stringify({
              error: { message: 'Function private-id: Not found for account private-account' },
            })
          : '{}',
      )
    })
  })
  let calls = 0
  let child: ReturnType<typeof spawn> | undefined
  let exited: Promise<number | null> | undefined
  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const address = server.address() as { port: number }
    const bundled = await build({
      entryPoints: [resolve('src/execution/host/adapters/kimi/kimi-error-bridge.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      write: false,
    })
    const bridge = join(root, 'bridge.mjs'),
      cli = join(root, 'cli.mjs')
    await writeFile(bridge, bundled.outputFiles![0]!.contents)
    await writeFile(
      cli,
      `import {createInterface} from 'node:readline';
const input=createInterface({input:process.stdin});
input.on('line',async line=>{const m=JSON.parse(line);if(m.method==='session/prompt'){const r=await fetch(process.env.KIMI_MODEL_BASE_URL+'/messages?beta=true',{method:'POST',headers:{'x-api-key':process.env.KIMI_MODEL_API_KEY,'content-type':'application/json'},body:JSON.stringify({model:'fixture'})});await r.text();}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='session/prompt'?{stopReason:'end_turn'}:{sessionId:'fixture-session'}})+String.fromCharCode(10));});
input.on('close',()=>process.exit(0));`,
    )
    child = spawn(process.execPath, [bridge], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPL_KIMI_COMMAND: process.execPath,
        OPL_KIMI_ARGS: JSON.stringify([cli]),
        KIMI_MODEL_NAME: 'fixture',
        KIMI_MODEL_API_KEY: 'provider-secret',
        KIMI_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      },
    })
    exited = new Promise((r) => child!.once('exit', r))
    child.stderr!.resume()
    let seq = 0
    const pending = new Map<number, (value: Record<string, any>) => void>()
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const value = JSON.parse(line)
      pending.get(value.id)?.(value)
      pending.delete(value.id)
    })
    const request = (method: string) =>
      new Promise<Record<string, any>>((r) => {
        const id = ++seq
        pending.set(id, r)
        child!.stdin!.write(
          JSON.stringify({ jsonrpc: '2.0', id, method, params: { sessionId: 'fixture-session' } }) +
            '\n',
        )
      })
    await request('session/new')
    const failed = await request('session/prompt')
    expect(failed.error.code).toBe('HARNESS_PROVIDER_ROUTE')
    expect(JSON.stringify(failed)).not.toMatch(/private-id|private-account|provider-secret/)
    await request('session/load')
    expect((await request('session/prompt')).result.stopReason).toBe('end_turn')
    expect(calls).toBe(2)
    child.stdin!.end()
    expect(await exited).toBe(0)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin!.end()
      child.kill()
      await exited
    }
    await new Promise<void>((r) => {
      server.close(() => r())
      server.closeAllConnections()
    })
    await rm(root, { recursive: true, force: true })
  }
})
