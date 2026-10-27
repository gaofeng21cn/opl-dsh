/**
 * Official Kimi Code local-server control for message editing.
 *
 * The ACP server has no history-rewind method. The official product does expose a local
 * REST server (`kimi web`) with `POST /api/v1/sessions/{id}:undo {count}` and an exact
 * user-anchor transcript (`GET /api/v1/sessions/{id}/transcript/user-messages`). This
 * module starts that server for one operation and never talks to a real account:
 *
 *  - it reuses the adapter's own launch environment, including `KIMI_CODE_HOME`, so the
 *    server sees the same suite-owned profile as the ACP process;
 *  - it uses the bearer token the server prints at startup. It never passes
 *    `--dangerous-bypass-auth` and never reads, copies or rewrites a credential;
 *  - it disables the provider-model catalog refresh through the official public
 *    environment controls (`KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START=0`,
 *    `KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS=0`). Without that suppression a running
 *    web server rewrites `config.toml` and can clear the provider key, which would make
 *    the subsequent ACP reconnect fail.
 *
 * The server is loopback-only and lives for one operation; `close()` reaps it.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { AdapterLaunch } from '../types.ts'
import { commandLaunch } from '../../harness-registry.ts'
import {
  ExternalMessageEditError,
  type ExternalMessageEditFailure,
} from '../../message-edit-opencode-common.ts'
import { parseKimiContextUsage, readKimiTranscriptUsages } from '../../usage-account.ts'
import type { HarnessContextUsage, HarnessStatistics } from '../../../contracts/usage.ts'

const exec = promisify(execFile)

const REFRESH_ON_START = 'KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START'
const REFRESH_INTERVAL = 'KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS'
const KIMI_HOME = 'KIMI_CODE_HOME'
const KIMI_COMMAND = 'OPL_KIMI_COMMAND'
const KIMI_ARGS = 'OPL_KIMI_ARGS'

const START_TIMEOUT_MS = 30_000
const HTTP_TIMEOUT_MS = 20_000

const object = (value: unknown): Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}

const string = (value: unknown): string => (typeof value === 'string' ? value : '')

function failure(code: ExternalMessageEditFailure): ExternalMessageEditError {
  return new ExternalMessageEditError(code)
}

/** One official user-anchor row from the transcript endpoint. */
export interface KimiUserMessage {
  readonly turnId: string
  readonly ordinal: number
  readonly state: string
  readonly origin: Record<string, any>
  readonly prompt: string
  readonly attachmentIds: readonly string[]
}

/** One official undo response; the driver maps its envelope. */
export interface KimiUndoResponse {
  readonly status: number
  readonly body: unknown
}

/** Exact statistics keyed by the official Kimi transcript turn id. */
export type KimiTurnStatistics = HarnessStatistics

export interface KimiControl {
  readUserMessages(sessionId: string): Promise<KimiUserMessage[]>
  readTurnStatistics(
    sessionId: string,
    latestTurnId?: string,
  ): Promise<Map<string, KimiTurnStatistics>>
  undo(sessionId: string, count: number): Promise<KimiUndoResponse>
  close(): Promise<void>
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => (port > 0 ? resolvePort(port) : rejectPort(new Error('no port'))))
    })
  })
}

async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
  if (process.platform === 'win32' && pid) {
    await exec('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10_000,
    }).catch(() => {})
  } else {
    try {
      child.kill()
    } catch {}
  }
  const first = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
  if (first) return
  if (pid) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  await Promise.race([exited, sleep(2000)])
  if (child.exitCode === null && child.signalCode === null) throw failure('control-unavailable')
}

/**
 * Rebuild the official `kimi web` launch from the adapter's own CLI binding.
 *
 * `launch.command` is the suite's ACP bridge, not the CLI, so the CLI path and its argument
 * prefix come from `OPL_KIMI_COMMAND` / `OPL_KIMI_ARGS` exactly as the adapter set them.
 */
function deriveWebLaunch(
  launch: AdapterLaunch,
  port: number,
): {
  command: string
  args: string[]
  windowsVerbatimArguments: boolean
} {
  const command = string(launch.env[KIMI_COMMAND])
  if (!command) throw failure('control-unavailable')
  let args: string[] = []
  const rawArgs = string(launch.env[KIMI_ARGS])
  if (rawArgs) {
    try {
      const parsed: unknown = JSON.parse(rawArgs)
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string'))
        throw failure('control-unavailable')
      args = parsed
    } catch (error) {
      if (error instanceof ExternalMessageEditError) throw error
      throw failure('control-unavailable')
    }
  }
  const acp = args.indexOf('acp')
  const prefix = acp >= 0 ? args.slice(0, acp) : args
  const served = commandLaunch(command, [...prefix, 'web', '--no-open', '--port', String(port)])
  return {
    command: served.command,
    args: served.args,
    windowsVerbatimArguments: !!served.windowsVerbatimArguments,
  }
}

interface Startup {
  base: string
  token: string
}

async function waitForStartup(child: ChildProcess, timeoutMs = START_TIMEOUT_MS): Promise<Startup> {
  if (!child.stdout) throw failure('control-unavailable')
  return await new Promise<Startup>((resolveStartup, rejectStartup) => {
    let base = ''
    let token = ''
    let settled = false
    const finish = (error?: ExternalMessageEditError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      lines.close()
      if (error) rejectStartup(error)
      else if (base && token) resolveStartup({ base, token })
      else rejectStartup(failure('control-unavailable'))
    }
    const timer = setTimeout(() => finish(failure('control-unavailable')), timeoutMs)
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', (line) => {
      // The token is printed once in a URL fragment; it is kept in memory only.
      const tokenMatch = line.match(/#token=([A-Za-z0-9_-]+)/)
      if (tokenMatch) token = tokenMatch[1]!
      const urlMatch = line.match(/https?:\/\/127\.0\.0\.1:\d+/)
      if (urlMatch) base = urlMatch[0]!
      if (base && token) finish()
    })
    child.once('error', () => finish(failure('control-unavailable')))
    child.once('exit', () => finish(failure('control-unavailable')))
  })
}

async function waitHealthy(base: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal.aborted) throw failure('aborted')
    try {
      const response = await fetch(base + '/api/v1/healthz', {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      })
      if (response.ok) return
    } catch {
      // The listener may not be accepting yet; retry until the bounded deadline.
    }
    await sleep(50)
  }
  throw failure('control-unavailable')
}

function asUserMessages(value: unknown): KimiUserMessage[] {
  const body = object(value)
  if (body.code !== 0) throw failure('protocol')
  const data = object(body.data)
  const agents = Array.isArray(data.agents) ? data.agents : undefined
  if (!agents) throw failure('protocol')
  const main = agents.find((agent) => string(object(agent).agent_id) === 'main') ?? agents[0]
  if (!main) return []
  const messages = Array.isArray(object(main).messages) ? object(main).messages : undefined
  if (!messages) throw failure('protocol')
  const result: KimiUserMessage[] = []
  const seen = new Set<string>()
  for (const raw of messages) {
    const item = object(raw)
    const turnId = string(item.turn_id)
    if (!turnId || seen.has(turnId)) throw failure('protocol')
    seen.add(turnId)
    const ordinal = item.ordinal
    if (typeof ordinal !== 'number' || !Number.isFinite(ordinal)) throw failure('protocol')
    const state = string(item.state)
    if (!state) throw failure('protocol')
    const origin = object(item.origin)
    const prompt = string(item.prompt)
    const attachmentIds = Array.isArray(item.attachment_ids)
      ? item.attachment_ids.filter((id: unknown): id is string => typeof id === 'string')
      : []
    result.push({ turnId, ordinal, state, origin, prompt, attachmentIds })
  }
  result.sort((left, right) => left.ordinal - right.ordinal)
  return result
}

/**
 * Start the official local server from the adapter's exact environment. Callers must have
 * disconnected the ACP session first: this is a sequential single-owner lifecycle.
 */
export async function startKimiControl(context: {
  readonly launch: AdapterLaunch
  readonly cwd: string
  readonly signal: AbortSignal
}): Promise<KimiControl> {
  if (context.signal.aborted) throw failure('aborted')
  const port = await freePort().catch(() => {
    throw failure('control-unavailable')
  })
  const launch = deriveWebLaunch(context.launch, port)
  const env: NodeJS.ProcessEnv = {
    ...context.launch.env,
    // Public controls: suppress the startup and interval catalog refresh. This is what
    // keeps the running server from rewriting the provider entry the ACP reconnect needs.
    [REFRESH_ON_START]: '0',
    [REFRESH_INTERVAL]: '0',
  }
  if (!string(env[KIMI_HOME])) throw failure('control-unavailable')
  const child = spawn(launch.command, launch.args, {
    cwd: context.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  })
  child.stderr?.on('data', () => {})
  let startup: Startup
  try {
    startup = await waitForStartup(child)
    await waitHealthy(startup.base, context.signal)
  } catch (error) {
    await stopOwnedChild(child)
    if (context.signal.aborted) throw failure('aborted')
    throw error
  }

  const authorization = `Bearer ${startup.token}`
  const request = async (
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<{ status: number; json: unknown }> => {
    const response = await fetch(startup.base + path, {
      redirect: 'error',
      method: init.method ?? 'GET',
      headers: {
        authorization,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.any([
        context.signal,
        AbortSignal.timeout(init.timeoutMs ?? HTTP_TIMEOUT_MS),
      ]),
    })
    const text = await response.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      throw failure('protocol')
    }
    return { status: response.status, json }
  }

  return {
    async readUserMessages(sessionId: string): Promise<KimiUserMessage[]> {
      let result: { status: number; json: unknown }
      try {
        result = await request(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript/user-messages`,
        )
      } catch (error) {
        if (context.signal.aborted) throw failure('aborted')
        if (error instanceof ExternalMessageEditError) throw error
        throw failure('control-unavailable')
      }
      if (result.status === 401 || result.status === 403) throw failure('control-unavailable')
      if (result.status === 404) throw failure('stale')
      if (result.status < 200 || result.status >= 300) throw failure('control-unavailable')
      return asUserMessages(result.json)
    },
    async undo(sessionId: string, count: number): Promise<KimiUndoResponse> {
      try {
        const result = await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}:undo`, {
          method: 'POST',
          body: { count },
          timeoutMs: 30_000,
        })
        return { status: result.status, body: result.json }
      } catch (error) {
        if (context.signal.aborted) throw failure('aborted')
        if (error instanceof ExternalMessageEditError) throw error
        throw failure('uncertain')
      }
    },
    async readTurnStatistics(
      sessionId: string,
      latestTurnId?: string,
    ): Promise<Map<string, KimiTurnStatistics>> {
      const usages = await readKimiTranscriptUsages(async (beforeTurn) => {
        const query = new URLSearchParams({ agent_id: 'main', page_size: '100' })
        if (beforeTurn) query.set('before_turn', beforeTurn)
        const result = await request(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript?${query.toString()}`,
        )
        if (result.status === 401 || result.status === 403) throw failure('control-unavailable')
        if (result.status === 404) throw failure('stale')
        if (result.status < 200 || result.status >= 300) throw failure('control-unavailable')
        return result.json
      })
      let contextUsage: HarnessContextUsage | undefined
      try {
        const status = await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/status`)
        if (status.status >= 200 && status.status < 300)
          contextUsage = parseKimiContextUsage(status.json)
      } catch (error) {
        if (context.signal.aborted) throw failure('aborted')
        if (error instanceof ExternalMessageEditError && error.code === 'stale') throw error
        // A missing status endpoint does not invalidate transcript turn usage.
      }
      const statistics = new Map<string, KimiTurnStatistics>()
      for (const [turnId, usage] of usages) statistics.set(turnId, { usage })
      if (contextUsage && latestTurnId) {
        const current = statistics.get(latestTurnId) ?? {}
        statistics.set(latestTurnId, { ...current, contextUsage })
      }
      return new Map(
        [...statistics.entries()].filter(([, value]) => value.usage || value.contextUsage),
      )
    },
    async close(): Promise<void> {
      await stopOwnedChild(child)
    },
  }
}
