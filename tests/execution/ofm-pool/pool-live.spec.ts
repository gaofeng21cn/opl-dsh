/**
 * Live official-CLI test: the real `pool acp` process, driven by the adapter's own
 * launch vector, against a controlled OpenAI-compatible provider on loopback.
 *
 * Scope, stated plainly: the CLI, its shell tool, its hooks, its approval flow, its
 * external `git` execution and its filesystem writes are real. The model is not.
 * Nothing here is evidence about network model availability or about DSH product
 * acceptance; the OFM owner still has to accept the real route through the public
 * owner interface.
 *
 * Skipped unless `OPL_POOL_TEST_BIN` points at an official `pool` executable, so
 * the suite stays runnable on a host without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { poolAdapter } from '../../../src/execution/host/adapters/pool/index.ts'
import {
  POOL_LAGUNA_S,
  POOL_SHELL_AUDIT_VARIABLE,
  POOL_SHELL_VARIABLE,
} from '../../../src/execution/host/adapters/pool/index.ts'
import { ctx, poolRecord, poolSource, poolSources, route, scratchRoot } from './fixtures/records.ts'
import type { AcpRequestSurface } from '../../../src/execution/host/adapters/types.ts'
import type {
  AdapterOptions,
  AcpSessionSnapshot,
} from '../../../src/execution/host/adapters/types.ts'

const BIN = process.env.OPL_POOL_TEST_BIN
const PROVIDER_MODEL = POOL_LAGUNA_S

/** A shell command that only a POSIX shell can run, plus real external git. */
const COMMAND = [
  'printf "OPL_BASH=%s\\n" "$BASH_VERSION"',
  'uname -s',
  'printf "OPL_GIT="; git --version',
  'printf "OPL_MARKER" > "中文 空格.txt"',
  'printf "OPL_READ="; cat "中文 空格.txt"',
  'printf "\\n"',
  'printf "OPL_PWD="; pwd',
].join('; ')

interface Provider {
  server: Server
  baseURL: string
  close(): Promise<void>
  models(): string[]
}

/**
 * A command that proves the interpreter without consulting PATH at all, for the case
 * where every Git/Bash directory has been removed from it.
 */
const SELF_CONTAINED_COMMAND = [
  'printf "OPL_BASH=%s' + String.fromCharCode(92) + 'n" "$BASH_VERSION"',
  'printf "OPL_ARGV0=%s' + String.fromCharCode(92) + 'n" "$0"',
  'case "$(uname -s 2>/dev/null || echo unknown-uname)" in MINGW*|MSYS*) echo OPL_MSYSLIKE=yes ;; *) echo OPL_MSYSLIKE=no ;; esac',
].join('; ')

/** Controlled endpoint: one shell tool call with no interpreter, then a closing message. */
async function startProvider(command: string = COMMAND): Promise<Provider> {
  let advertised = [PROVIDER_MODEL]
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: advertised.map((id) => ({ id })) }))
        return
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      const messages = (body.messages ?? []) as { role: string }[]
      const shellTool = (
        (body.tools ?? []) as {
          function?: { name?: string; parameters?: { properties?: Record<string, unknown> } }
        }[]
      ).find((tool) => tool.function?.name === 'shell')
      const alreadyRan = messages.some((message) => message.role === 'tool')
      let message: Record<string, unknown> = { role: 'assistant', content: 'done' }
      let finish = 'stop'
      if (!alreadyRan && shellTool) {
        const properties = shellTool.function?.parameters?.properties ?? {}
        const args: Record<string, unknown> = {}
        for (const key of Object.keys(properties)) {
          // No `shell` / `shell_args`: the interpreter must not come from the model.
          if (key === 'cmd' || key === 'command' || key === 'script') args[key] = command
          else if (key === 'mode') args[key] = 'foreground'
        }
        message = {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'shell', arguments: JSON.stringify(args) },
            },
          ],
        }
        finish = 'tool_calls'
      }
      const payload = {
        id: 'live',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
      const head = { ...payload, object: 'chat.completion.chunk' }
      res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' })
      if (body.stream) {
        res.write(
          `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`,
        )
        res.write(
          `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
        )
        res.write('data: [DONE]\n\n')
      } else res.end(JSON.stringify(payload))
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    server,
    baseURL: `http://127.0.0.1:${port}/v1`,
    // Keep-alive sockets would keep `server.close` pending forever, so they are
    // drained explicitly and the callback is awaited.
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    models: () => advertised,
  }
}

/** Minimal ACP client over stdio. */
class LiveClient implements AcpRequestSurface {
  private sequence = 0
  readonly updates: Record<string, any>[] = []
  readonly permissions: Record<string, any>[] = []
  private readonly waiters: { id: number; resolve: (message: any) => void }[] = []
  constructor(readonly child: ReturnType<typeof spawn>) {
    child.stderr?.resume()
    createInterface({ input: child.stdout as any }).on('line', (line) => {
      if (!line.trim()) return
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.method === 'session/update') this.updates.push(message.params?.update ?? {})
      if (message.method === 'session/request_permission')
        this.permissions.push(message.params ?? {})
      for (let index = this.waiters.length - 1; index >= 0; index -= 1)
        if (this.waiters[index]!.id === message.id && ('result' in message || 'error' in message))
          this.waiters.splice(index, 1)[0]!.resolve(message)
    })
  }

  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly open = new Set<(error: Error) => void>()
  private exited = false

  async request(method: string, params: object, timeoutMs = 60_000): Promise<unknown> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      // Every pending request is tracked so a closing session cannot leave a timer
      // behind that keeps the event loop alive after the test ends.
      const fail = (error: Error) => reject(error)
      this.open.add(fail)
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        this.open.delete(fail)
        reject(new Error(`timeout ${method}`))
      }, timeoutMs)
      this.timers.add(timer)
      this.waiters.push({
        id,
        resolve: (message) => {
          clearTimeout(timer)
          this.timers.delete(timer)
          this.open.delete(fail)
          if ('error' in message) reject(new Error(`${method} -> ${JSON.stringify(message.error)}`))
          else resolve(message.result)
        },
      })
      this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  /**
   * Stop the official CLI and wait for it.
   *
   * A bare `kill()` only schedules the exit: the process, its hooks and their
   * command runners can still be alive after the test ends. Pending requests are
   * rejected, then the exit is awaited with a bounded wait before a forced kill.
   */
  async close(): Promise<void> {
    if (this.exited) return
    this.exited = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const fail of this.open) fail(new Error('session closed'))
    this.open.clear()
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => this.child.once('close', () => resolve()))
    const forced = setTimeout(() => this.child.kill(), 5_000)
    try {
      await exited
    } finally {
      clearTimeout(forced)
    }
  }

  notify(method: string, params: object): void {
    this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  waitFor(predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const tick = () => {
        if (predicate()) resolve()
        else if (Date.now() > deadline) reject(new Error('wait timed out'))
        else setTimeout(tick, 25)
      }
      tick()
    })
  }
}

interface Turn {
  readonly output: string
  readonly prompt: Record<string, any>
}

async function runTurn(
  provider: Provider,
  envOver: NodeJS.ProcessEnv | ((launch: NodeJS.ProcessEnv) => NodeJS.ProcessEnv) = {},
  workDir?: string,
  command?: string,
): Promise<{ client: LiveClient; turn: Turn; env: NodeJS.ProcessEnv; home: string }> {
  const home = await mkdtemp(join(scratchRoot(), 'opl-pool-live-'))
  const cwd = workDir ?? join(home, 'workspace 中文 空格')
  await mkdir(cwd, { recursive: true })
  const options = {
    home,
    grokCommand: 'grok',
    nativeBridgePath: 'bridge.js',
    command: BIN,
    modelSources: poolSources(
      poolSource(route({ baseURL: provider.baseURL, model: PROVIDER_MODEL })),
    ),
  } as unknown as AdapterOptions
  const record = poolRecord({ cwd, sandbox: 'full-access' })
  const launch = await poolAdapter.prepare!(ctx, record, options)
  // A function form keeps a hostile-environment case from reading a value the launch
  // has not produced yet.
  const overrides = typeof envOver === 'function' ? envOver(launch.env) : envOver
  const child = spawn(launch.command, launch.args, {
    cwd,
    env: { ...launch.env, ...overrides },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const client = new LiveClient(child)
  const agent = await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'opl-pool-live-test', version: '1' },
  })
  const session = await client.request('session/new', { cwd, mcpServers: [] })
  const snapshot = {
    agent,
    session,
    configOptions: (session as { configOptions?: unknown }).configOptions,
  } as AcpSessionSnapshot
  await poolAdapter.configureSession!(client, record, snapshot)
  const prompt = (await client.request('session/prompt', {
    sessionId: (session as { sessionId: string }).sessionId,
    prompt: [{ type: 'text', text: 'Use the shell tool once.' }],
  })) as Record<string, any>
  const outputs = client.updates
    .filter((update) => update?.sessionUpdate === 'tool_call_update' && update.content?.length)
    // The official CLI nests the text one level deeper: content[i].content.text.
    .map((update) =>
      update.content.map((entry: any) => entry?.content?.text ?? entry?.text ?? '').join(''),
    )
    .join('\n')
  await client.close()
  return { client, turn: { output: outputs, prompt }, env: launch.env, home }
}

/** Start an adapter-launched official session and return everything needed to drive it. */
async function openLive(
  provider: Provider,
  envOver: NodeJS.ProcessEnv | ((launch: NodeJS.ProcessEnv) => NodeJS.ProcessEnv) = {},
): Promise<{
  client: LiveClient
  launch: Awaited<ReturnType<NonNullable<typeof poolAdapter.prepare>>>
  record: ReturnType<typeof poolRecord>
  session: Record<string, any>
  snapshot: AcpSessionSnapshot
  cwd: string
  home: string
}> {
  const home = await mkdtemp(join(scratchRoot(), 'opl-pool-live-'))
  const cwd = join(home, 'workspace 中文 空格')
  await mkdir(cwd, { recursive: true })
  const options = {
    home,
    grokCommand: 'grok',
    nativeBridgePath: 'bridge.js',
    command: BIN,
    modelSources: poolSources(
      poolSource(route({ baseURL: provider.baseURL, model: PROVIDER_MODEL })),
    ),
  } as unknown as AdapterOptions
  const record = poolRecord({ cwd, sandbox: 'full-access' })
  const launch = await poolAdapter.prepare!(ctx, record, options)
  const overrides = typeof envOver === 'function' ? envOver(launch.env) : envOver
  const child = spawn(launch.command, launch.args, {
    cwd,
    env: { ...launch.env, ...overrides },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const client = new LiveClient(child)
  const agent = await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'opl-pool-live-test', version: '1' },
  })
  const session = (await client.request('session/new', { cwd, mcpServers: [] })) as Record<
    string,
    any
  >
  const snapshot = {
    agent,
    session,
    configOptions: session.configOptions,
  } as AcpSessionSnapshot
  return { client, launch, record, session, snapshot, cwd, home }
}

/** Poll until a path exists, so a landing-point check waits for the real write. */
async function client_waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Every file path under a root, used to prove where the CLI wrote. */
function readdirDeep(root: string, depth = 0): string[] {
  if (depth > 4 || !existsSync(root)) return []
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const full = join(root, entry)
    let isDirectory = false
    try {
      isDirectory = statSync(full).isDirectory()
    } catch {
      return []
    }
    return isDirectory ? readdirDeep(full, depth + 1) : [full]
  })
}

describe.skipIf(!BIN)('pool against the official CLI', () => {
  let provider: Provider
  beforeAll(async () => {
    provider = await startProvider()
  })
  afterAll(async () => {
    await provider?.close()
  })

  it('runs real Git Bash with real git in a Chinese, space-bearing workspace', async () => {
    const { turn, client } = await runTurn(provider)
    // MINGW/MSYS, not PowerShell: the interpreter is the pinned one.
    expect(turn.output).toMatch(/OPL_BASH=5\.|OPL_BASH=4\./u)
    expect(turn.output).toMatch(/MINGW64_NT-|MSYS_NT-/u)
    expect(turn.output).toMatch(/OPL_GIT=git version 2\./u)
    expect(turn.output).toContain('OPL_READ=OPL_MARKER')
    expect(turn.output).toMatch(/workspace 中文 空格/u)
    expect(turn.prompt.stopReason).toBeTruthy()
    expect(client.updates.some((update) => update?.sessionUpdate === 'tool_call')).toBe(true)
  }, 180_000)

  it('keeps the pin when the environment names PowerShell and PATH hides Git', async () => {
    const systemRoot = process.env.SystemRoot ?? 'C:/Windows'
    const minimal = await startProvider(SELF_CONTAINED_COMMAND)
    const { turn } = await runTurn(minimal, (launch) => ({
      SHELL: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      // Every directory that could resolve a bash is removed. The suite's own hook
      // launcher directory stays, because that entry is part of the launch contract:
      // drop it and the hook cannot start, which the official CLI lets pass through.
      PATH: (launch.PATH ?? '')
        .split(';')
        .filter((entry) => !/git/i.test(entry))
        .concat(join(systemRoot, 'System32'))
        .join(';'),
    }))
    expect(turn.output).toMatch(/OPL_BASH=5\.|OPL_BASH=4\./u)
    // `$0` is the interpreter the CLI actually exec'd, resolved through the pin.
    expect(turn.output).toContain('OPL_ARGV0=/usr/bin/bash')
    expect(turn.output).not.toMatch(/ParserError|CategoryInfo|所在位置 行:/u)
  }, 180_000)

  it('blocks the call when the pinned interpreter is gone, with no other shell', async () => {
    // Exactly what a machine that loses Git for Windows mid-session looks like: the
    // hook answers with a refusal instead of letting the model's own shell run.
    const { turn, client } = await runTurn(provider, {
      OPL_POOL_SHELL: 'C:/uninstalled/opl-bash.exe',
    })
    const statuses = client.updates
      .filter((update) => update?.sessionUpdate === 'tool_call_update')
      .map((update) => update.status)
    expect(statuses).toContain('failed')
    expect(turn.output).toContain('no fallback to PowerShell, CMD or WSL')
    expect(turn.output).not.toMatch(/MINGW64_NT-|MSYS_NT-/u)
  }, 180_000)

  it('reloads the pinned session and refuses it again only when it actually drifted', async () => {
    const { client, record, session, snapshot, cwd } = await openLive(provider)
    await poolAdapter.configureSession!(client, record, snapshot)
    // `session/load` is advertised by this agent; the reloaded session has to carry
    // the same configuration surface, otherwise `verifySession` must refuse it.
    const reloaded = (await client.request('session/load', {
      sessionId: session.sessionId,
      cwd,
      mcpServers: [],
    })) as Record<string, any>
    // `session/load` returns no session id by ACP contract; what matters is that the
    // reloaded session carries the configuration surface this adapter has to verify.
    expect(Array.isArray(reloaded.configOptions)).toBe(true)
    const reloadedSnapshot = {
      agent: snapshot.agent,
      session: { ...session, ...reloaded },
      configOptions: reloaded.configOptions,
    } as AcpSessionSnapshot
    const configured = await poolAdapter.configureSession!(client, record, reloadedSnapshot)
    // Only the advertisement that came back from the writes describes the current
    // session: the load reply still advertises the mode the session had before, and
    // verifying against it must fail rather than pass on stale values.
    const current = { ...reloadedSnapshot, configOptions: configured?.configOptions }
    expect(() => poolAdapter.verifySession!(record, current)).not.toThrow()
    expect(() => poolAdapter.verifySession!(record, reloadedSnapshot)).toThrow(
      /会话 mode 与要求的/u,
    )
    // A reloaded session that advertises nothing is refused rather than trusted.
    expect(() =>
      poolAdapter.verifySession!(record, { ...current, configOptions: undefined }),
    ).toThrow(/未广告配置项/u)
    await client.close()
  }, 180_000)

  it('cancels a running tool call and leaves no process finishing behind', async () => {
    const started = join(await mkdtemp(join(scratchRoot(), 'opl-pool-cancel-')), 'started.txt')
    const finished = join(await mkdtemp(join(scratchRoot(), 'opl-pool-cancel-')), 'finished.txt')
    const slow = await startProvider(
      `printf START > "${started}"; sleep 12; printf DONE > "${finished}"`,
    )
    const { client, record, session, snapshot } = await openLive(slow)
    await poolAdapter.configureSession!(client, record, snapshot)
    const prompt = client.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Use the shell tool once.' }],
    })
    // Event-driven start: the command announces itself before it sleeps, so the cancel
    // lands while the tool is genuinely running rather than racing the model call.
    await client.waitFor(() => existsSync(started))
    client.notify('session/cancel', { sessionId: session.sessionId })
    const result = (await prompt) as Record<string, any>
    expect(result.stopReason).toBeTruthy()
    // Bounded negative window: a cancelled tool must not run to completion afterwards.
    await new Promise((resolve) => setTimeout(resolve, 12_000))
    expect(existsSync(finished)).toBe(false)
    expect(client.permissions).toEqual([])
    await client.close()
    await slow.close()
  }, 240_000)

  it('creates the official profile inside the suite-owned directory', async () => {
    const { client, launch, home } = await openLive(provider)
    // Owned evidence only: the launch points the measured Windows profile options at
    // the session directory, and the CLI's own tree is created there. The real user
    // profile is never enumerated from this suite.
    expect(launch.env.USERPROFILE!.startsWith(home)).toBe(true)
    expect(launch.env.APPDATA!.startsWith(home)).toBe(true)
    const owned = join(launch.env.USERPROFILE!, 'AppData', 'Local', 'poolside')
    await client_waitFor(() => existsSync(owned))
    expect(existsSync(owned)).toBe(true)
    expect(readdirDeep(owned).length).toBeGreaterThan(0)
    await client.close()
  }, 180_000)

  it('never approves on a human behalf', async () => {
    const { client } = await runTurn(provider, {}, undefined)
    // `always-allow` is the official "approve everything" mode, so the suite itself
    // answers nothing: an approval request would mean the pin or the mode was ignored.
    expect(client.permissions).toEqual([])
  }, 180_000)

  it('records one audit line per rewritten tool call, without the command text', async () => {
    const { turn, env } = await runTurn(provider)
    const audit = env[POOL_SHELL_AUDIT_VARIABLE]!
    const lines = (await readFile(audit, 'utf8')).trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    const entries = lines.map((line) => JSON.parse(line))
    for (const entry of entries) {
      expect(entry.shell).toBe(env[POOL_SHELL_VARIABLE])
      expect(entry.shell_args).toEqual(['--noprofile', '--norc', '-c'])
    }
    expect(await readFile(audit, 'utf8')).not.toContain('OPL_BASH=%s')
    expect(turn.output).toMatch(/MINGW64_NT-|MSYS_NT-/u)
  }, 180_000)
})

describe.skipIf(!BIN)('pool launch preconditions on a real host', () => {
  it('detects the official binary and proves the pin when the host is ready', async () => {
    const home = await mkdtemp(join(scratchRoot(), 'opl-pool-available-'))
    try {
      const result = await poolAdapter.available(ctx, {
        home,
        command: BIN,
        grokCommand: 'grok',
        nativeBridgePath: 'bridge.js',
      } as unknown as AdapterOptions)
      expect(result.available).toBe(true)
      expect(existsSync(join(home, 'harnesses', 'pool', 'availability', 'settings.yaml'))).toBe(
        true,
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)
})

void POOL_SHELL_AUDIT_VARIABLE
void readFile
