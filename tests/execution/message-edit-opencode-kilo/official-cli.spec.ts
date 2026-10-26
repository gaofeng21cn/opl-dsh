import { execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'
import type { ExternalEditContext } from '../../../src/execution/host/message-edit-driver.ts'
import type { AdapterLaunch } from '../../../src/execution/host/adapters/types.ts'
import { createOpenCodeMessageEditDriver } from '../../../src/execution/host/message-edit-opencode.ts'
import { createKiloMessageEditDriver } from '../../../src/execution/host/message-edit-kilo.ts'

const TMP_ROOT =
  process.env.OPL_MESSAGE_EDIT_TMP ??
  'C:/Users/root/Documents/Codex/repair-20261026/harness-message-edit/opencode-kilo/implementation-tmp'
mkdirSync(TMP_ROOT, { recursive: true })
const BASH = 'C:/Program Files/Git/bin/bash.exe'
const exec = promisify(execFile)

type Kind = 'opencode' | 'kilo'

function profile(kind: Kind) {
  const root = mkdtempSync(join(TMP_ROOT, `official-${kind}-`))
  const dirs = {
    home: join(root, 'home'),
    data: join(root, 'data'),
    config: join(root, 'config'),
    cache: join(root, 'cache'),
    state: join(root, 'state'),
    kilo: join(root, 'kilo'),
    work: join(root, 'work'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    TMP: root,
    TEMP: root,
    TMPDIR: root,
    XDG_DATA_HOME: dirs.data,
    XDG_CONFIG_HOME: dirs.config,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    KILO_CONFIG_DIR: dirs.kilo,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    KILO_DISABLE_AUTOUPDATE: '1',
    KILO_DISABLE_MODELS_FETCH: '1',
    NO_COLOR: '1',
    CI: '1',
  }
  return { root, dirs, env }
}

function configEnv(kind: Kind): NodeJS.ProcessEnv {
  const model = kind === 'opencode' ? 'inclusionai/ling-3.1-flash' : 'reflection/beam-free'
  const provider = kind === 'opencode' ? 'oplopencode' : 'oplkilo'
  const config = {
    $schema:
      kind === 'opencode' ? 'https://opencode.ai/config.json' : 'https://kilo.ai/schema.json',
    shell: BASH,
    permission: 'allow',
    provider: {
      [provider]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'OPL Route',
        options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'probe-keyless' },
        models: { [model]: { name: model } },
      },
    },
  }
  return kind === 'opencode'
    ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
    : { KILO_CONFIG_CONTENT: JSON.stringify(config) }
}

async function startSeed(kind: Kind, binary: string, env: NodeJS.ProcessEnv, cwd: string) {
  const password = `seed-${kind}-${Date.now()}`
  const passwordEnv = kind === 'opencode' ? 'OPENCODE_SERVER_PASSWORD' : 'KILO_SERVER_PASSWORD'
  const username = kind === 'opencode' ? 'opencode' : 'kilo'
  const child = spawn(binary, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
    cwd,
    env: { ...env, [passwordEnv]: password },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stderr?.on('data', () => {})
  const base = await new Promise<string>((resolveBase, reject) => {
    const timer = setTimeout(() => reject(new Error('seed serve timeout')), 30_000)
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', (line) => {
      const match = line.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) {
        clearTimeout(timer)
        resolveBase(match[1]!)
      }
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error('seed serve exited'))
    })
  })
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: auth,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {}
    return { status: response.status, json }
  }
  return { child, base, call }
}

async function stopSeed(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
  if (process.platform === 'win32' && child.pid) {
    await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10_000,
    }).catch(() => {})
  } else {
    child.kill()
  }
  await Promise.race([exited, new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5000))])
}

const cases: {
  kind: Kind
  binary: string | undefined
  driver: () => ReturnType<typeof createOpenCodeMessageEditDriver>
}[] = [
  {
    kind: 'opencode',
    binary: process.env.OPENCODE_OFFICIAL_BINARY,
    driver: () => createOpenCodeMessageEditDriver(),
  },
  {
    kind: 'kilo',
    binary: process.env.KILO_OFFICIAL_BINARY,
    driver: () =>
      createKiloMessageEditDriver() as ReturnType<typeof createOpenCodeMessageEditDriver>,
  },
]

describe('external message-edit driver official CLI smoke', () => {
  for (const { kind, binary, driver } of cases) {
    it.skipIf(!binary)(
      `${kind}: reads and forks a real keyless session`,
      async () => {
        const p = profile(kind)
        const env = { ...p.env, ...configEnv(kind) }
        const seed = await startSeed(kind, binary!, env, p.dirs.work)
        let sessionId = ''
        try {
          const created = await seed.call('POST', '/session', { title: 'driver-smoke' })
          sessionId = created.json?.id ?? ''
          expect(sessionId).toMatch(/^ses_/)
          const first = await seed.call('POST', `/session/${sessionId}/message`, {
            parts: [{ type: 'text', text: 'alpha' }],
            noReply: true,
          })
          const second = await seed.call('POST', `/session/${sessionId}/message`, {
            parts: [{ type: 'text', text: 'beta' }],
            noReply: true,
          })
          expect(first.status).toBe(200)
          expect(second.status).toBe(200)
          const shell = await seed.call('POST', `/session/${sessionId}/shell`, {
            agent: kind === 'opencode' ? 'build' : 'code',
            command: 'printf tool-output',
          })
          expect(shell.status).toBe(200)
          const listed = await seed.call('GET', `/session/${sessionId}/message`)
          expect(Array.isArray(listed.json)).toBe(true)
        } finally {
          await stopSeed(seed.child)
        }

        const record = {
          id: 'record-1',
          combination: 'probe',
          harnessRef: kind,
          modelRef: { provider: 'probe', model: 'probe' },
          cwd: p.dirs.work,
          acpSessionId: sessionId,
          origin: { kind: 'desktop', sessionId: 'dsh-sidebar-1' },
          title: 'probe',
          sandbox: 'full-access',
          createdAt: '2026-10-26T00:00:00.000Z',
          updatedAt: '2026-10-26T00:00:00.000Z',
          turns: [],
        } as unknown as HarnessSession
        const launch: AdapterLaunch = {
          home: p.root,
          command: binary!,
          args: ['acp', '--cwd', p.dirs.work],
          env,
        }
        const context: ExternalEditContext = {
          record,
          launch,
          signal: new AbortController().signal,
          transport: () => ({ request: async () => ({}) }),
          snapshot: () => ({ agent: {}, session: {}, configOptions: [] }),
          disconnect: async () => {},
          reconnect: async () => {},
        }
        const external = driver()
        const history = await external.read(context)
        expect(history.boundaries.map((boundary) => boundary.text)).toEqual(['alpha', 'beta'])
        const target = history.boundaries.find((boundary) => boundary.text === 'beta')!
        const result = await external.rewind(context, {
          operationId: 'op-1',
          targetId: target.id,
          expected: history,
        })
        expect(result.retained).toEqual([
          { previousId: history.boundaries[0]!.id, nextId: result.retained[0]!.nextId },
        ])
        expect(result.sessionId).toMatch(/^ses_/)
        expect(result.sessionId).not.toBe(sessionId)
      },
      30_000,
    )
  }
})
