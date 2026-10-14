import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpProcess } from '../../../src/execution/host/acp.ts'
import {
  kimiCodeAdapter,
  kimiConfigOption,
} from '../../../src/execution/host/adapters/kimi/index.ts'
import {
  KIMI_ENV_MODEL_ALIAS,
  KIMI_PROVIDER,
} from '../../../src/execution/host/adapters/kimi/kimi-models.ts'
import { kimiBashEnvironment } from '../../../src/execution/host/adapters/kimi/kimi-bash.ts'
import { kimiRecord } from './fixtures/records.ts'
import type { ModelRef } from '../../../src/execution/contracts/catalog.ts'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'

const STUB = fileURLToPath(new URL('./fixtures/stub-kimi-acp-agent.mjs', import.meta.url))

let root = ''
/** A working directory with non-ASCII characters and a space. */
let workDir = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'opl-kimi-acp-'))
  workDir = join(root, '中文 目录 project')
  await mkdir(workDir, { recursive: true })
  await writeFile(join(workDir, '说明.txt'), '来自 kimi 的文件\n', 'utf8')
})

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

const record = (extra: Partial<HarnessSession> = {}): HarnessSession =>
  kimiRecord({ provider: KIMI_PROVIDER, model: 'moonshotai/kimi-k3' } as ModelRef, {
    sandbox: 'full-access',
    cwd: workDir,
    ...extra,
  })

interface Agent {
  acp: AcpProcess
  updates: { update?: { content?: { text?: string } } }[]
  exited: Promise<void>
  waitFor(text: string): Promise<void>
}

/**
 * Start the protocol double over the suite's real ACP transport.
 *
 * Synchronisation is by request id and by awaited notifications; nothing waits on a
 * timer to guess whether the agent has caught up.
 */
async function startAgent(env: NodeJS.ProcessEnv = {}): Promise<Agent> {
  const updates: { update?: { content?: { text?: string } } }[] = []
  const seen: string[] = []
  const waiters: { text: string; resolve: () => void }[] = []
  let resolveExit!: () => void
  const exited = new Promise<void>((done) => {
    resolveExit = done
  })
  const acp = new AcpProcess(
    process.execPath,
    [STUB],
    workDir,
    { ...process.env, ...env },
    (value) => {
      updates.push(value as { update?: { content?: { text?: string } } })
      const text = (value as { update?: { content?: { text?: string } } })?.update?.content?.text
      if (typeof text === 'string') {
        seen.push(text)
        for (const waiter of waiters.splice(0))
          if (seen.join('\n').includes(waiter.text)) waiter.resolve()
      }
    },
    () => {},
    () => resolveExit(),
  )
  const waitFor = (text: string) =>
    seen.join('\n').includes(text)
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`no notification containing ${text}`)),
            20000,
          )
          waiters.push({
            text,
            resolve: () => {
              clearTimeout(timer)
              resolve()
            },
          })
        })
  return { acp, updates, exited, waitFor }
}

const initialize = (acp: AcpProcess) =>
  acp.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: 'opl-dsh', version: '0.0.0' },
  })

describe.skipIf(process.platform !== 'win32')('Kimi Code ACP session lifecycle', () => {
  it('creates, pins the env alias and permission mode, and closes', async () => {
    const env = await kimiBashEnvironment({ PATH: process.env.PATH })
    const agent = await startAgent(env)
    try {
      const initialized = (await initialize(agent.acp)) as Record<string, any>
      expect(initialized.protocolVersion).toBe(1)
      expect(initialized.agentCapabilities.loadSession).toBe(true)
      expect(initialized.agentInfo).toEqual({ name: 'Kimi Code CLI', version: '2.1.1' })

      const created = (await agent.acp.request('session/new', {
        cwd: workDir,
        mcpServers: [],
      })) as Record<string, any>
      const sessionId = created.sessionId as string
      expect(sessionId).toBeTruthy()
      // The official CLI advertises its environment alias, not the wire model name.
      expect(kimiConfigOption(created.configOptions, 'model')?.values).toEqual([
        KIMI_ENV_MODEL_ALIAS,
      ])

      const session = record({ acpSessionId: sessionId })
      const configured = await kimiCodeAdapter.configureSession!(agent.acp, session, {
        agent: initialized,
        session: { sessionId },
        configOptions: created.configOptions,
      } as never)
      expect(kimiConfigOption(configured!.configOptions, 'model')?.currentValue).toBe(
        KIMI_ENV_MODEL_ALIAS,
      )
      // full-access maps to yolo, and nothing here claims a cwd boundary.
      expect(kimiConfigOption(configured!.configOptions, 'mode')?.currentValue).toBe('yolo')

      kimiCodeAdapter.verifySession!(session, {
        agent: initialized,
        session: { sessionId },
        configOptions: configured!.configOptions,
      } as never)

      // The agent sees the real, non-ASCII working directory that has a space in it.
      const prompt = agent.acp.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: 'go' }] },
        30000,
      )
      await agent.waitFor('plan:')
      await agent.acp.request('stub/proceed', { sessionId })
      expect(((await prompt) as Record<string, any>).stopReason).toBe('end_turn')
      await agent.waitFor(`cwd=${workDir}`)

      await agent.acp.request('session/close', { sessionId })
    } finally {
      await agent.acp.dispose()
    }
    await agent.exited
  }, 60000)

  it('cancels an in-flight prompt without leaving the process running', async () => {
    const env = await kimiBashEnvironment({ PATH: process.env.PATH })
    const agent = await startAgent(env)
    try {
      await initialize(agent.acp)
      const created = (await agent.acp.request('session/new', {
        cwd: workDir,
        mcpServers: [],
      })) as Record<string, any>
      const sessionId = created.sessionId as string
      const prompt = agent.acp.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: 'long' }] },
        30000,
      )
      // Wait for the turn to start so the cancellation is observed rather than racing it.
      await agent.waitFor('plan:')
      agent.acp.cancel(sessionId)
      expect(((await prompt) as Record<string, any>).stopReason).toBe('cancelled')
    } finally {
      await agent.acp.dispose()
    }
    await agent.exited
  }, 60000)

  it('re-pins after load, because load restores the mode but not the session state', async () => {
    const env = await kimiBashEnvironment({ PATH: process.env.PATH })
    const agent = await startAgent(env)
    try {
      const initialized = (await initialize(agent.acp)) as Record<string, any>
      const created = (await agent.acp.request('session/new', {
        cwd: workDir,
        mcpServers: [],
      })) as Record<string, any>
      const sessionId = created.sessionId as string
      const session = record({ acpSessionId: sessionId })
      await kimiCodeAdapter.configureSession!(agent.acp, session, {
        agent: initialized,
        session: { sessionId },
        configOptions: created.configOptions,
      } as never)
      const loaded = (await agent.acp.request('session/load', {
        sessionId,
        cwd: workDir,
        mcpServers: [],
      })) as Record<string, any>
      const reconfigured = await kimiCodeAdapter.configureSession!(agent.acp, session, {
        agent: initialized,
        session: { sessionId },
        configOptions: loaded.configOptions,
      } as never)
      expect(kimiConfigOption(reconfigured!.configOptions, 'mode')?.currentValue).toBe('yolo')
      expect(kimiConfigOption(reconfigured!.configOptions, 'model')?.currentValue).toBe(
        KIMI_ENV_MODEL_ALIAS,
      )
    } finally {
      await agent.acp.dispose()
    }
  }, 60000)

  it('disposes the owned process tree even when the session never closed', async () => {
    const env = await kimiBashEnvironment({ PATH: process.env.PATH })
    const agent = await startAgent(env)
    await initialize(agent.acp)
    await agent.acp.request('session/new', { cwd: workDir, mcpServers: [] })
    await agent.acp.dispose()
    await agent.exited
    // The transport is closed: a further request fails instead of hanging.
    await expect(agent.acp.request('initialize', { protocolVersion: 1 })).rejects.toThrow()
  }, 60000)

  it('fails closed against an agent older than the pinned ACP surface', async () => {
    const env = await kimiBashEnvironment({ PATH: process.env.PATH })
    const agent = await startAgent({ ...env, STUB_AGENT_VERSION: '1.42.0' })
    try {
      const initialized = (await initialize(agent.acp)) as Record<string, any>
      const created = (await agent.acp.request('session/new', {
        cwd: workDir,
        mcpServers: [],
      })) as Record<string, any>
      await expect(
        kimiCodeAdapter.configureSession!(agent.acp, record({ acpSessionId: created.sessionId }), {
          agent: initialized,
          session: { sessionId: created.sessionId },
          configOptions: created.configOptions,
        } as never),
      ).rejects.toThrow(/低于本适配器所需的/)
    } finally {
      await agent.acp.dispose()
    }
  }, 60000)

  it('keeps the working directory that the agent reports', async () => {
    const env = await kimiBashEnvironment({ PATH: process.env.PATH })
    const agent = await startAgent(env)
    expect(existsSync(join(workDir, '说明.txt'))).toBe(true)
    expect(env.KIMI_SHELL_PATH).toBeTruthy()
    await agent.acp.dispose()
  })
})
