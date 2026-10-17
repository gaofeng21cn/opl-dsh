/**
 * Live surface evidence from the official pinned OpenCode CLI.
 *
 * This spec talks to a **real** official `opencode` binary over the suite's own ACP
 * transport. It exists because several capability decisions in this adapter came from
 * measuring that binary rather than from documentation:
 *
 *   - `session/load` returns an advertisement on the CLI's own default model, so a
 *     restored session cannot be assumed to have kept its pinned model.
 *   - `session/cancel` answers `-32601 "Method not found"`, which is why the adapter
 *     declares `cancel: false`.
 *   - `session/set_config_option` with `configId: "model"` really does write the selection
 *     and return the refreshed advertisement.
 *
 * Model requests use a keyless loopback fixture. The request-body assertion verifies the
 * provider-qualified EAC model id without calling an upstream model or using credentials.
 *
 * The binary is not vendored into this repository. Point `OPENCODE_OFFICIAL_BINARY` at a
 * verified official install (or the pinned `opencode-windows-x64` build); when it is
 * unset the whole suite skips rather than pretending to have run.
 */
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AcpProcess } from '../../../src/execution/host/acp.ts'
import {
  openCodeProfileRoots,
  OPENCODE_MODEL_OPTION,
  openCodeModelValue,
} from '../../../src/execution/host/adapters/opencode/index.ts'

const exec = promisify(execFile)
/** Set this to a verified official binary path to enable the suite. */
const BINARY = process.env.OPENCODE_OFFICIAL_BINARY
const PINNED_VERSION = '1.19.0'
const MODEL = 'inclusionai/ling-3.1-flash'
const MODEL_VALUE = openCodeModelValue(MODEL)
const EAC_MODEL = 'opencode/glm-5.3-flash-free'

interface Fixture {
  acp: AcpProcess
  dir: string
  cwd: string
}

let root = ''
let harness: Fixture
const booted: AcpProcess[] = []
let server: Server | undefined
const requests: { model: string }[] = []

beforeAll(async () => {
  if (!BINARY) return
  await access(BINARY)
  root = await mkdtemp(join(tmpdir(), 'opl-opencode-official-'))
  const profile = openCodeProfileRoots(root)
  for (const dir of Object.values(profile)) await mkdir(dir, { recursive: true })
  // A Chinese-plus-space working directory: the launch vector must carry it verbatim.
  const cwd = join(root, '中文 项目 dir')
  await mkdir(cwd, { recursive: true })
  server = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const choice of [
      { delta: { role: 'assistant', content: 'EAC_ROUTE_OK' }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' },
    ])
      res.write(
        `data: ${JSON.stringify({ id: 'eac-probe', object: 'chat.completion.chunk', created: 1, model: EAC_MODEL, choices: [{ index: 0, ...choice }] })}\n\n`,
      )
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Loopback fixture did not bind')
  const acp = new AcpProcess(
    BINARY,
    ['acp', '--cwd', cwd],
    cwd,
    {
      ...process.env,
      PATH: process.env.PATH!,
      ...profile,
      // Isolated profile; no shared XDG roots, no updater, no user config files.
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: {
          oplopencode: {
            npm: '@ai-sdk/openai-compatible',
            name: 'OPL Route',
            options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'probe-keyless' },
            models: { [MODEL]: { name: MODEL }, [EAC_MODEL]: { name: EAC_MODEL } },
          },
        },
      }),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    },
    () => {},
    () => {},
    () => {},
  )
  booted.push(acp)
  harness = { acp, dir: root, cwd }
}, 120_000)

afterAll(async () => {
  for (const acp of booted.splice(0)) await acp.dispose()
  if (server?.listening) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    )
  }
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe.skipIf(!BINARY)('官方 OpenCode CLI 实测面', () => {
  it('报告的版本与 pin 版本一致', async () => {
    const result = await exec(BINARY!, ['--version'], {
      env: { ...process.env, ...openCodeProfileRoots(root) },
      windowsHide: true,
    })
    expect(result.stdout.trim()).toBe(PINNED_VERSION)
  })

  it('initialize 广告 ACP v1 与 loadSession，profile 落在自有目录', async () => {
    const agent = (await harness.acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: 'opl-official-probe', version: '1.0.0' },
    })) as Record<string, any>
    expect(agent.protocolVersion).toBe(1)
    expect(agent.agentCapabilities.loadSession).toBe(true)
    expect(agent.agentInfo.version).toBe(PINNED_VERSION)
  })

  it('新会话广告本路由的模型，并可用官方配置接口固定后回读一致', async () => {
    const created = (await harness.acp.request('session/new', {
      cwd: harness.cwd,
      mcpServers: [],
    })) as Record<string, any>
    const model = (created.configOptions as any[]).find((o) => o.id === OPENCODE_MODEL_OPTION)
    // A slash-bearing model id survives the provider/model namespace unchanged.
    expect(model.options.map((o: any) => o.value)).toContain(MODEL_VALUE)

    const written = (await harness.acp.request('session/set_config_option', {
      sessionId: created.sessionId,
      configId: OPENCODE_MODEL_OPTION,
      value: MODEL_VALUE,
    })) as Record<string, any>
    const readBack = (written.configOptions as any[]).find((o) => o.id === OPENCODE_MODEL_OPTION)
    expect(readBack.currentValue).toBe(MODEL_VALUE)
    await harness.acp.request('session/close', { sessionId: created.sessionId })
  })

  it('session/load 不恢复已固定的模型，因此恢复后必须重新固定', async () => {
    const created = (await harness.acp.request('session/new', {
      cwd: harness.cwd,
      mcpServers: [],
    })) as Record<string, any>
    await harness.acp.request('session/set_config_option', {
      sessionId: created.sessionId,
      configId: OPENCODE_MODEL_OPTION,
      value: MODEL_VALUE,
    })
    const restored = (await harness.acp.request('session/load', {
      sessionId: created.sessionId,
      cwd: harness.cwd,
      mcpServers: [],
    })) as Record<string, any>
    const model = (restored.configOptions as any[]).find((o) => o.id === OPENCODE_MODEL_OPTION)
    // 实测：回到 CLI 自带默认模型。适配器因此在 load 之后重新固定，而不是信任旧值。
    expect(model.currentValue).not.toBe(MODEL_VALUE)

    const again = (await harness.acp.request('session/set_config_option', {
      sessionId: created.sessionId,
      configId: OPENCODE_MODEL_OPTION,
      value: MODEL_VALUE,
    })) as Record<string, any>
    const readBack = (again.configOptions as any[]).find((o) => o.id === OPENCODE_MODEL_OPTION)
    expect(readBack.currentValue).toBe(MODEL_VALUE)
    await harness.acp.request('session/close', { sessionId: created.sessionId })
  })

  it('session/cancel 未实现，适配器因此不广告取消', async () => {
    const created = (await harness.acp.request('session/new', {
      cwd: harness.cwd,
      mcpServers: [],
    })) as Record<string, any>
    await expect(
      harness.acp.request('session/cancel', { sessionId: created.sessionId }),
    ).rejects.toThrow()
    await harness.acp.request('session/close', { sessionId: created.sessionId })
  })

  it('EAC GLM Flash Free can be pinned after both new and load without becoming the built-in free route', async () => {
    const created = (await harness.acp.request('session/new', {
      cwd: harness.cwd,
      mcpServers: [],
    })) as Record<string, any>
    try {
      const value = openCodeModelValue(EAC_MODEL)
      expect(value).toBe('oplopencode/opencode/glm-5.3-flash-free')
      for (const load of [false, true]) {
        if (load)
          await harness.acp.request('session/load', {
            sessionId: created.sessionId,
            cwd: harness.cwd,
            mcpServers: [],
          })
        const written = (await harness.acp.request('session/set_config_option', {
          sessionId: created.sessionId,
          configId: OPENCODE_MODEL_OPTION,
          value,
        })) as Record<string, any>
        expect(
          written.configOptions.find((o: any) => o.id === OPENCODE_MODEL_OPTION).currentValue,
        ).toBe(value)
        const before = requests.length
        const result = (await harness.acp.request('session/prompt', {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'Reply EAC_ROUTE_OK without using tools.' }],
        })) as Record<string, any>
        expect(result.stopReason).toBe('end_turn')
        const sent = requests.slice(before)
        expect(sent).not.toHaveLength(0)
        expect(sent.every((request) => request.model === EAC_MODEL)).toBe(true)
      }
    } finally {
      await harness.acp.request('session/close', { sessionId: created.sessionId })
    }
  })
})
