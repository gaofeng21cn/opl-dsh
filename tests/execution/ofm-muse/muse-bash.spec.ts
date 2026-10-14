import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { resolveGitBashPath } from '../../../src/shell/host/git-bash.ts'
import {
  CancellationControl,
  EXIT_NO_BASH,
  runBashCommand,
} from '../../../src/execution/host/adapters/muse/muse-bash-mcp.mjs'
import {
  MUSE_BASH_ENV,
  MUSE_MCP_TOOL,
  museBashEnvironment,
  museMcpServer,
  museSettingsDocument,
} from '../../../src/execution/host/adapters/muse/muse-bash.ts'

const exec = promisify(execFile)
const SERVER = fileURLToPath(
  new URL('../../../src/execution/host/adapters/muse/muse-bash-mcp.mjs', import.meta.url),
)

/**
 * Whether this host is the Windows Git Bash runtime that most of this file describes.
 *
 * The interpreter pinning, the absolute-path/existing-file refusals and the process-tree
 * teardown are Windows-only branches *in the tool*: `resolveBash` returns the platform
 * shell untouched off Windows, and the kill reaches MSYS descendants only through
 * `taskkill` plus an MSYS process-group signal. A POSIX `bash` cannot stand in for that,
 * because it exercises the early return instead of the branch under test — so those
 * tests run on Windows only. Every other assertion here stays portable and still runs.
 */
const onWindows = process.platform === 'win32'

/**
 * Whether a real `git` is on PATH.
 *
 * Driving a real external CLI through the tool is worth proving, but the suite must not
 * assume any particular machine installed one, so the git-backed tests are skipped
 * rather than failed when the binary is genuinely absent.
 */
const gitAvailable = await (async () => {
  try {
    const { stdout } = await exec('git', ['--version'], { windowsHide: true, timeout: 15_000 })
    return /^git version \d+\.\d+/u.test(stdout)
  } catch {
    return false
  }
})()

let workspace = ''
let bash = ''

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'opl-muse-bash-'))
  bash = resolveGitBashPath()
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const env = () => ({ ...process.env, [MUSE_BASH_ENV]: bash })

/**
 * Count `sleep.exe` processes on the host.
 *
 * On this host `sleep.exe` only exists because these probes start it, so the count is a
 * direct, race-free readout of whether a command's descendants are still alive. It
 * beats a canary file, which can only be observed after a guessed delay and therefore
 * proves nothing about processes that never write.
 */
async function sleepProcessCount(): Promise<number> {
  const { stdout } = await exec('tasklist', ['/FI', 'IMAGENAME eq sleep.exe', '/NH'], {
    windowsHide: true,
    timeout: 15_000,
  }).catch(() => ({ stdout: '' }))
  return (stdout.match(/^sleep\.exe/gmu) ?? []).length
}

/**
 * Wait for a condition, polling instead of sleeping a guessed interval.
 *
 * @param predicate - the condition to reach.
 * @param timeoutMs - how long to keep trying before giving up.
 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((done) => setTimeout(done, 100))
  }
}

describe('Muse Bash tool: interpreter selection', () => {
  it.runIf(onWindows)('pins a real Git Bash and proves it is an MSYS shell', async () => {
    const resolved = await museBashEnvironment(process.env)
    expect(resolved.shell).toMatch(/bash\.exe$/iu)
    expect(resolved.env[MUSE_BASH_ENV]).toBe(resolved.shell)
    const { stdout } = await exec(
      resolved.shell,
      ['--noprofile', '--norc', '-c', '/usr/bin/uname -s'],
      {
        env: resolved.env,
        windowsHide: true,
      },
    )
    expect(stdout.trim()).toMatch(/^(?:MINGW(?:32|64)|MSYS)_NT-/u)
  })

  it('runs an arbitrary command, not a fixed probe', async () => {
    // Three unrelated commands through one call path: identity, exit status and output.
    const result = await runBashCommand({ command: 'echo one; echo two >&2; exit 7' }, env())
    expect(result.exitCode).toBe(7)
    expect(result.stdout).toContain('one')
    expect(result.stderr).toContain('two')
    expect(result.refused).toBeUndefined()
  })

  it('honours an arbitrary working directory, including a non-ASCII one with a space', async () => {
    const dir = join(workspace, '中文 空格')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '中文 空格.txt'), 'owned-muse-bash-marker', 'utf8')
    const result = await runBashCommand({ command: 'cat "中文 空格.txt"; pwd', cwd: dir }, env())
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('owned-muse-bash-marker')
    // Git Bash reports its own POSIX view of the same directory; the file was read
    // through that view, which is the point.
    expect(result.stdout).toMatch(/中文 空格/u)
  })

  it.runIf(gitAvailable)('runs a real external Git command end to end', async () => {
    const repo = join(workspace, 'git-repo')
    await mkdir(repo, { recursive: true })
    const { shell } = await museBashEnvironment(process.env)
    await exec(shell, ['--noprofile', '--norc', '-c', 'git init -q -b main .'], {
      cwd: repo,
      env: env(),
      windowsHide: true,
    })
    const result = await runBashCommand(
      {
        command: 'git --version && git symbolic-ref --short HEAD && git status --porcelain | wc -l',
        cwd: repo,
      },
      env(),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/git version \d+\.\d+/u)
    expect(result.stdout).toContain('main')
    expect(result.stdout).toMatch(/0\s*$/u)
  })

  it('passes stdin to the command', async () => {
    const result = await runBashCommand(
      { command: 'cat; echo done', stdin: 'piped-value\n' },
      env(),
    )
    expect(result.stdout).toContain('piped-value')
    expect(result.stdout).toContain('done')
  })

  it('reports truncation instead of hiding it', async () => {
    const result = await runBashCommand(
      {
        command:
          'for i in $(seq 1 5000); do echo "line-$i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; done',
        maxOutputBytes: 2048,
      },
      env(),
    )
    expect(result.exitCode).toBe(0)
    expect(result.truncatedBytes).toBeGreaterThan(0)
    expect(result.stdout).toMatch(/\[opl-muse-bash: truncated \d+ of \d+ bytes\]/u)
  })
})

describe('Muse Bash tool: refusal without a fallback interpreter', () => {
  it('refuses when the interpreter is not configured at all', async () => {
    const bare = { ...process.env }
    delete bare[MUSE_BASH_ENV]
    await expect(runBashCommand({ command: 'echo hi' }, bare)).rejects.toThrow(
      /OPL_MUSE_GIT_BASH is not set/,
    )
  })

  it.runIf(onWindows)('refuses a bash path that does not exist, naming no substitute', async () => {
    const missing = join(workspace, 'no-such', 'bash.exe')
    await expect(
      runBashCommand({ command: 'echo hi' }, { ...process.env, [MUSE_BASH_ENV]: missing }),
    ).rejects.toThrow(/does not name an existing file/)
    // The message names no other interpreter, so a caller cannot mistake it for one.
    await expect(
      runBashCommand({ command: 'echo hi' }, { ...process.env, [MUSE_BASH_ENV]: missing }),
    ).rejects.toThrow(/^(?!.*(?:PowerShell|WSL)).*$/su)
  })

  it.runIf(onWindows)('refuses a relative interpreter path rather than resolving it', async () => {
    await expect(
      runBashCommand({ command: 'echo hi' }, { ...process.env, [MUSE_BASH_ENV]: 'bash' }),
    ).rejects.toThrow(/is not an absolute path/)
  })

  it('refuses an empty command and a bad working directory', async () => {
    expect((await runBashCommand({ command: '   ' }, env())).refused).toMatch(/non-empty/u)
    const missingCwd = join(workspace, 'not-created')
    expect((await runBashCommand({ command: 'pwd', cwd: missingCwd }, env())).refused).toMatch(
      /cwd does not exist/u,
    )
    expect((await runBashCommand({ command: 'pwd', cwd: SERVER }, env())).refused).toMatch(
      /not a directory/u,
    )
  })
})

describe('Muse Bash tool: timeout and process cleanup', () => {
  it.runIf(onWindows)('kills a timed-out command and says so', async () => {
    const started = Date.now()
    const result = await runBashCommand({ command: 'sleep 30', timeoutMs: 1500 }, env())
    expect(result.timedOut).toBe(true)
    // It really waited for the timeout, then returned, rather than blocking on sleep.
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(result.exitCode).not.toBe(0)
  })

  it.runIf(onWindows)('leaves no descendant process behind after a timeout', async () => {
    // `sleep.exe` exists on this host only as what these probes start, so a clean
    // baseline plus an empty count afterwards is a direct check of tree teardown —
    // and unlike a canary write it cannot lose a race with the kill.
    expect(await sleepProcessCount()).toBe(0)
    const result = await runBashCommand({ command: 'sleep 300 & wait', timeoutMs: 1500 }, env())
    expect(result.timedOut).toBe(true)
    expect(result.killConfirmed).toBe(true)
    await waitFor(async () => (await sleepProcessCount()) === 0)
    expect(await sleepProcessCount()).toBe(0)
  })

  it.runIf(onWindows)(
    'stops a cancelled command, awaits its close and reports the cancellation',
    async () => {
      expect(await sleepProcessCount()).toBe(0)
      const control = new CancellationControl()
      const started = Date.now()
      // A timeout far longer than the test budget: if the kill failed, the call would run
      // to it, so a quick settle is itself evidence the kill worked.
      const pending = runBashCommand(
        { command: 'sleep 300 & wait', timeoutMs: 60_000 },
        env(),
        control,
      )
      control.cancel()
      const result = await pending
      expect(result.cancelled).toBe(true)
      expect(result.timedOut).toBe(false)
      expect(result.killConfirmed).toBe(true)
      expect(Date.now() - started).toBeLessThan(30_000)
      await waitFor(async () => (await sleepProcessCount()) === 0)
      expect(await sleepProcessCount()).toBe(0)
    },
  )
})

/** Drive the MCP server over stdio, exactly the way the official CLI does. */
function driveTool(bashPath: string) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, [MUSE_BASH_ENV]: bashPath },
    windowsHide: true,
  })
  const pending = new Map<string, (value: any) => void>()
  const notifications: any[] = []
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const key = String(message.id)
      const waiter = message.id !== undefined ? pending.get(key) : undefined
      if (waiter) {
        waiter(message)
        pending.delete(key)
      } else notifications.push(message)
    }
  })
  let next = 1
  const send_ = (method: string, params?: unknown) => {
    const id = String(next++)
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`${method} timed out`)), 30_000)
      pending.set(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return { id, promise }
  }
  const call = (method: string, params?: unknown) => send_(method, params).promise
  /** Issue a request and keep its id, so a cancellation can name the right one. */
  const callWithId = (method: string, params?: unknown) => send_(method, params)
  const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)))
  return { child, call, callWithId, notifications, stderr, exited }
}

describe('Muse Bash tool: MCP protocol surface', () => {
  it('advertises one general-purpose command tool under the documented name', async () => {
    const { child, call, stderr, exited } = driveTool(bash)
    try {
      const opened = await call('initialize', { protocolVersion: '2025-06-18' })
      expect(opened.result.serverInfo.name).toBe('opl_muse_git_bash')
      const listed = await call('tools/list')
      const names = listed.result.tools.map((tool: { name: string }) => tool.name)
      expect(names).toEqual(['run'])
      // The advertised schema accepts cwd, timeout and stdin, which is what makes it
      // a command tool rather than a single scripted probe.
      const properties = Object.keys(listed.result.tools[0].inputSchema.properties)
      expect(properties).toEqual(expect.arrayContaining(['command', 'cwd', 'timeoutMs', 'stdin']))
      // Registered under the name the CLI gives the model.
      expect(MUSE_MCP_TOOL).toBe('mcp__opl_muse_git_bash__run')
      expect(stderr.join('')).toContain('serving run through')
      child.stdin.end()
      expect(await exited).toBe(0)
    } finally {
      child.kill()
    }
  })

  it.runIf(gitAvailable)(
    'runs a real command through a tool call and reports the exit code',
    async () => {
      const { child, call } = driveTool(bash)
      try {
        await call('initialize', { protocolVersion: '2025-06-18' })
        const called = await call('tools/call', {
          name: 'run',
          arguments: {
            command: 'printf "MUSE_MCP_BASH=%s\\n" "$BASH_VERSION"; uname -s; git --version',
          },
        })
        const text = called.result.content[0].text as string
        expect(text).toMatch(/^exit=0/u)
        expect(text).toContain(`shell=${bash}`)
        expect(text).toMatch(/MUSE_MCP_BASH=/u)
        // `uname -s` is the interpreter's own answer, so the tool reports a real shell on
        // both platforms rather than a hard-coded identity: an MSYS build on Windows, the
        // POSIX kernel elsewhere. Asserting the host's own name keeps that honest.
        expect(text).toMatch(
          onWindows ? /(?:MINGW(?:32|64)|MSYS)_NT-/u : /^(?:Linux|Darwin|FreeBSD)$/mu,
        )
        expect(text).toMatch(/git version \d+\.\d+/u)
        expect(called.result.isError).toBe(false)
      } finally {
        child.kill()
      }
    },
  )

  it('reports a failing command as an error without pretending it succeeded', async () => {
    const { child, call } = driveTool(bash)
    try {
      await call('initialize', { protocolVersion: '2025-06-18' })
      const called = await call('tools/call', { name: 'run', arguments: { command: 'exit 3' } })
      expect(called.result.isError).toBe(true)
      expect(called.result.content[0].text).toContain('exit=3')
    } finally {
      child.kill()
    }
  })

  it('refuses an unknown tool and a malformed call instead of guessing', async () => {
    const { child, call } = driveTool(bash)
    try {
      await call('initialize', { protocolVersion: '2025-06-18' })
      expect((await call('tools/call', { name: 'rm', arguments: {} })).error.message).toMatch(
        /unknown tool/u,
      )
      const refused = await call('tools/call', { name: 'run', arguments: { command: '' } })
      expect(refused.result.isError).toBe(true)
      expect(refused.result.content[0].text).toMatch(/non-empty/u)
      expect((await call('session/unknown')).error.code).toBe(-32601)
    } finally {
      child.kill()
    }
  })

  it.runIf(onWindows)(
    'cancels the call named by requestId and stops its descendants',
    async () => {
      expect(await sleepProcessCount()).toBe(0)
      const { child, call, callWithId, stderr } = driveTool(bash)
      try {
        await call('initialize', { protocolVersion: '2025-06-18' })
        const { id, promise } = callWithId('tools/call', {
          name: 'run',
          arguments: { command: 'sleep 300 & wait', timeoutMs: 60_000 },
        })
        // The cancellation has to name the request it withdraws; counting notifications
        // left the command running and still writing.
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } })}
`,
        )
        const answer = await promise
        const text = answer.result.content[0].text as string
        expect(text).toContain('cancelled')
        expect(text).toContain('killConfirmed=true')
        expect(answer.result.isError).toBe(true)
        await waitFor(async () => (await sleepProcessCount()) === 0)
        expect(await sleepProcessCount()).toBe(0)
        expect(stderr.join('')).not.toMatch(/没有对应的运行中调用/)
      } finally {
        child.kill()
      }
    },
    30_000,
  )

  it('says so when a cancellation names no running call, instead of claiming success', async () => {
    const { child, call, stderr } = driveTool(bash)
    try {
      await call('initialize', { protocolVersion: '2025-06-18' })
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'does-not-exist' } })}
`,
      )
      const listed = await call('tools/list')
      expect(listed.result.tools).toHaveLength(1)
      expect(stderr.join('')).toMatch(/没有对应的运行中调用/)
    } finally {
      child.kill()
    }
  })

  it.runIf(onWindows)(
    'exits with its own code when the interpreter is unusable, and serves nothing',
    async () => {
      const { child, call, exited } = driveTool(join(workspace, 'absent', 'bash.exe'))
      try {
        // The tool never answers a call; it fails at launch instead of leaving the model
        // with a server that appears healthy.
        const outcome = await Promise.race([
          call('initialize', { protocolVersion: '2025-06-18' }).then(() => 'answered'),
          exited.then((code) => `exited:${code}`),
        ])
        expect(outcome).toBe(`exited:${EXIT_NO_BASH}`)
      } finally {
        child.kill()
      }
    },
  )
})

describe('Muse Bash tool: registration shape the official CLI reads', () => {
  it('builds a stdio server entry with the interpreter passed in, not discovered', () => {
    const server = museMcpServer(process.execPath, SERVER, process.env, bash)
    expect(server).toMatchObject({
      transport: 'stdio',
      command: process.execPath,
      mode: 'required',
    })
    expect(server.args).toEqual([SERVER])
    expect(server.env[MUSE_BASH_ENV]).toBe(bash)
    // A tool process must not inherit a user's profile.
    for (const forbidden of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME'])
      expect(server.env).not.toHaveProperty(forbidden)
  })

  it('limits the toolset to the Bash tool so no PowerShell shell is advertised', () => {
    expect(
      museSettingsDocument(museMcpServer(process.execPath, SERVER, process.env, bash)),
    ).toMatchObject({ schema_version: 1, run: { toolset: [MUSE_MCP_TOOL] } })
  })
})
