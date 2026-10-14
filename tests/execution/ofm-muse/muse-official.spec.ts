/** Real official Muse MSP host, controlled Responses endpoint and actual MCP Bash. */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import { museCodeAdapter } from '../../../src/execution/host/adapters/muse/muse.ts'
import { museRecord, museRef } from './fixtures/records.ts'

const binary = process.env.OPL_MUSE_OFFICIAL_BINARY
const lane = 'muse-spark-1.3-contributor-free'
const owner = { effect: (fn: () => () => void) => fn() } as never
const ctx = {} as never
const bridge = fileURLToPath(
  new URL('../../../src/execution/host/adapters/muse/muse-bridge.mjs', import.meta.url),
)

describe.skipIf(!binary)('Official Muse source endpoint and tools', () => {
  it('runs Bash through the official loop and loads the same session in a new process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-muse-official-'))
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const requests: any[] = []
    let scripted = 0
    let mode = 'normal'
    let announcePending!: () => void
    const pendingRequest = new Promise<void>((resolve) => {
      announcePending = resolve
    })
    const server = createServer(async (req, res) => {
      let text = ''
      for await (const chunk of req) text += chunk
      const body = text ? JSON.parse(text) : {}
      requests.push({ model: body.model, tools: body.tools, input: body.input, path: req.url })
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [
              {
                id: lane,
                object: 'model',
                metadata: {
                  'muse-code': {
                    release_date: '2026-01-01',
                    is_hidden: false,
                    limit: { context: 1000000, output: 1024 },
                  },
                },
              },
            ],
          }),
        )
        return
      }
      if (mode === 'failure') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ error: { type: 'invalid_request_error', message: 'Owned rejection' } }),
        )
        return
      }
      if (mode === 'cancel') {
        announcePending()
        return
      }
      const commandTool = body.tools?.find(
        (tool: any) => tool.name === 'mcp__opl_muse_git_bash__run',
      )
      const shouldRun = commandTool && text.includes('OWNED_MUSE_TOOL') && scripted === 0
      const call = {
        type: 'function_call',
        name: commandTool?.name,
        call_id: 'owned_call',
        arguments: JSON.stringify({
          command: 'printf OWNED_MUSE_TOOL > marker.txt; cat marker.txt; git --version',
          cwd,
        }),
      }
      const response = {
        id: 'owned_response_' + requests.length,
        object: 'response',
        model: body.model,
        status: 'completed',
        output: shouldRun ? [call] : [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }
      const frames: any[] = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      ]
      if (shouldRun) {
        scripted++
        frames.push(
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...call, arguments: '', item_id: 'owned_item' },
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'owned_item',
            output_index: 0,
            delta: call.arguments,
          },
        )
      } else
        frames.push({
          type: 'response.output_text.delta',
          item_id: 'owned_message',
          output_index: 0,
          content_index: 0,
          delta: 'OWNED_MUSE_ACK',
        })
      frames.push({ type: 'response.completed', response })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        frames
          .map(
            (frame, i) => 'data: ' + JSON.stringify({ ...frame, sequence_number: i + 1 }) + '\n\n',
          )
          .join(''),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, {
      provider: 'our-free-model',
      supports: () => true,
      resolve: async () => ({
        model: lane,
        protocol: 'responses',
        apiKey: 'owned-dummy',
        baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      }),
    })
    const record = museRecord(museRef(lane), {
      cwd,
      sandbox: 'full-access',
      reasoningEffort: 'max',
    })
    const options = {
      home: root,
      command: binary,
      nativeBridgePath: bridge,
      grokCommand: 'grok',
      modelSources: sources,
    }
    const children: ReturnType<typeof spawn>[] = []
    const traces: any[] = []
    async function start(load?: string) {
      const launch = await museCodeAdapter.prepare!(ctx, record, options)
      const child = spawn(launch.command, launch.args, {
        cwd,
        env: launch.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      children.push(child)
      const exited = new Promise((resolve) => child.once('close', resolve))
      const trace: any = { updates: [], stderr: '' }
      traces.push(trace)
      const pending = new Map<number, (m: any) => void>()
      const updates: any[] = []
      let seq = 0
      let stderr = ''
      child.stderr!.on('data', (b) => {
        stderr += b
        trace.stderr += b
      })
      createInterface({ input: child.stdout! }).on('line', (line) => {
        const m = JSON.parse(line)
        if (pending.has(m.id)) {
          pending.get(m.id)!(m)
          pending.delete(m.id)
        } else {
          updates.push(m)
          trace.updates.push(m)
        }
      })
      const call = (method: string, params: any) =>
        new Promise<any>((resolve, reject) => {
          const id = ++seq
          const timer = setTimeout(() => {
            pending.delete(id)
            reject(Error(method + ' timed out: ' + stderr.slice(-1800)))
          }, 60000)
          pending.set(id, (message) => {
            clearTimeout(timer)
            message.error
              ? reject(Error(message.error.message + ' : ' + stderr.slice(-3000)))
              : resolve(message.result)
          })
          child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
        })
      await call('initialize', {})
      const session = await call(load ? 'session/load' : 'session/new', {
        cwd,
        ...(load ? { sessionId: load } : {}),
      })
      expect(session.configOptions).toEqual({ modelId: lane, reasoningEffort: 'max' })
      return { child, call, session, updates, exited, stderr: () => stderr }
    }
    try {
      const first = await start()
      const result = await first.call('session/prompt', {
        sessionId: first.session.sessionId,
        prompt: [{ type: 'text', text: 'Use the command tool for OWNED_MUSE_TOOL.' }],
      })
      expect(result.stopReason).toBe('end_turn')
      expect(
        scripted,
        JSON.stringify(requests.map((r) => ({ path: r.path, tools: r.tools, model: r.model }))) +
          first.stderr(),
      ).toBe(1)
      if (process.env.OPL_MUSE_OFFICIAL_REPORT)
        await writeFile(
          process.env.OPL_MUSE_OFFICIAL_REPORT,
          JSON.stringify({ updates: first.updates, requests, stderr: first.stderr() }, null, 2),
        )
      expect(await readFile(join(cwd, 'marker.txt'), 'utf8')).toBe('OWNED_MUSE_TOOL')
      expect(first.updates.some((m) => m.params?.update?.sessionUpdate === 'tool_call')).toBe(true)
      expect(first.updates.some((m) => JSON.stringify(m).includes('git version'))).toBe(true)
      first.child.stdin!.end()
      await first.exited
      const loaded = await start(first.session.sessionId)
      expect(
        (
          await loaded.call('session/prompt', {
            sessionId: loaded.session.sessionId,
            prompt: [{ type: 'text', text: 'Reply ACK without tools.' }],
          })
        ).stopReason,
      ).toBe('end_turn')
      mode = 'failure'
      await expect(
        loaded.call('session/prompt', {
          sessionId: loaded.session.sessionId,
          prompt: [{ type: 'text', text: 'Owned error test.' }],
        }),
      ).rejects.toThrow()
      mode = 'cancel'
      const cancelledTurn = loaded.call('session/prompt', {
        sessionId: loaded.session.sessionId,
        prompt: [{ type: 'text', text: 'Owned cancellation test.' }],
      })
      await pendingRequest
      expect(
        (await loaded.call('session/cancel', { sessionId: loaded.session.sessionId })).stopReason,
      ).toBe('cancel_requested')
      expect((await cancelledTurn).stopReason).toBe('cancelled')
      expect(await readFile(join(cwd, 'marker.txt'), 'utf8')).toBe('OWNED_MUSE_TOOL')
      loaded.child.stdin!.end()
      await loaded.exited
      expect(scripted).toBe(1)
      expect(
        requests.some(
          (r) =>
            r.path === '/v1/responses' &&
            r.tools?.some((t: any) => t.name === 'mcp__opl_muse_git_bash__run'),
        ),
      ).toBe(true)
    } finally {
      if (process.env.OPL_MUSE_OFFICIAL_REPORT)
        await writeFile(
          process.env.OPL_MUSE_OFFICIAL_REPORT,
          JSON.stringify({ requests, scripted, mode, traces }, null, 2),
        )
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const done = new Promise((resolve) => child.once('close', resolve))
          child.stdin!.end()
          const timer = setTimeout(() => child.kill(), 3000)
          await done
          clearTimeout(timer)
        }
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 180000)
})
