/**
 * Git Bash MCP server for the official Muse Code CLI.
 *
 * Why this exists, from the installed binary (1.4.7-R6101.1):
 *
 *  - The built-in shell is PowerShell. `--enable-shell-tool` selects the legacy
 *    shell tool and it still receives PowerShell argv, so pointing the CLI at
 *    `bash.exe` fails with exit `2` and `-N: invalid option` when a `-c` command
 *    string is handed to it. There is no supported switch that turns that path
 *    into a POSIX shell.
 *  - The supported extension point is MCP. The CLI reads `mcpServers` and
 *    `run.toolset` from its own settings, advertises each server to the model as
 *    the namespace tool `mcp__<serverKey>__<tool>`, and runs those servers outside
 *    its native shell sandbox.
 *
 * So this is a real command tool, not a probe: it takes an arbitrary command, an
 * optional working directory, an optional timeout and an optional stdin payload,
 * and reports exit code, stdout, stderr and truncation as separate fields. A fixed
 * command would only prove that one command works.
 *
 * The shell is chosen once, from `OPL_MUSE_GIT_BASH`, which the adapter resolves
 * with the suite's Git Bash resolver. A missing or unusable bash is a startup
 * failure with a distinct exit code — this server never falls back to PowerShell,
 * CMD or WSL, because a silent interpreter swap would make every recorded command
 * line a lie.
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Distinct exit codes so the adapter and the tests can tell failures apart. */
export const EXIT_OK = 0
export const EXIT_NO_BASH = 3
export const EXIT_PROTOCOL = 4

/** Default cap on captured output; larger output is truncated with a stated marker. */
const DEFAULT_MAX_OUTPUT = 256 * 1024
const MAX_OUTPUT_CEILING = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const TIMEOUT_CEILING_MS = 3_600_000

const encode = (value) => JSON.stringify(value)

function reply(id, result) {
  process.stdout.write(`${encode({ jsonrpc: '2.0', id, result })}\n`)
}
function fail(id, code, message) {
  process.stdout.write(`${encode({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}
function log(line) {
  // stdout is the protocol channel; diagnostics go to stderr, where the CLI
  // collects them instead of corrupting the JSON-RPC stream.
  process.stderr.write(`${line}\n`)
}

const isWindows = process.platform === 'win32'

/**
 * The bash to run, resolved by the adapter before this process started.
 *
 * Nothing is probed or discovered here: a path that is not configured, not absolute,
 * or not a file is a startup failure, so the session that needed a shell learns
 * that instead of getting a different interpreter.
 */
function resolveBash(env) {
  const configured = env.OPL_MUSE_GIT_BASH
  if (!configured)
    throw Error(
      'OPL_MUSE_GIT_BASH is not set: this tool runs only the Git Bash the adapter resolved, and never falls back to PowerShell, CMD or WSL.',
    )
  if (!isWindows) return { shell: configured, native: false }
  if (!isAbsolute(configured))
    throw Error(`OPL_MUSE_GIT_BASH is not an absolute path: ${configured}`)
  if (!existsSync(configured) || !statSync(configured).isFile())
    throw Error(`OPL_MUSE_GIT_BASH does not name an existing file: ${configured}`)
  return { shell: configured, native: true }
}

/**
 * Stop a command and everything it started, and confirm the result.
 *
 * On Windows this needs two steps, because neither alone is enough — measured against
 * Git Bash 5.3.15 on this host, with a `sleep 300 & wait` command:
 *
 *  - `taskkill /PID <winpid> /T /F` ends the bash process itself (`exit` fires), but an
 *    MSYS grandchild keeps the inherited stdout/stderr handles open, so `close` does
 *    not fire and the call could not settle.
 *  - Signalling bash's own MSYS process group (`kill -9 -<msyspid>`) reaches those
 *    descendants and releases the pipes; with both steps the `close` event fires and
 *    the call settles with the command genuinely gone.
 *
 * The MSYS pid is not the Windows pid — bash reports its own pid as `$$`, and the two
 * numbering spaces do not agree — so the command is prefixed with a pid write to a file
 * inside the session's own temporary directory, read once at startup and removed
 * afterwards. The user's own stdout and stderr are untouched by this prefix.
 * @param child - the spawned bash process.
 * @param shell - the bash executable, reused to run the group signal.
 * @param pidFile - the file bash wrote its own pid to, read here rather than at startup
 * so a normal run pays nothing for it.
 * @returns whether both steps completed without error.
 */
async function killTree(child, shell, pidFile) {
  let ok = false
  if (child.pid)
    try {
      await execFileAsync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 10_000,
      })
      ok = true
    } catch {
      /* the process may already be gone; the MSYS step below still runs */
    }
  const msysPid = isWindows ? readMsysPidSync(pidFile) : undefined
  if (isWindows && msysPid)
    try {
      await execFileAsync(
        shell,
        ['--noprofile', '--norc', '-c', `kill -9 -${msysPid} 2>/dev/null`],
        {
          windowsHide: true,
          timeout: 10_000,
        },
      )
      ok = true
    } catch {
      /* nothing left to signal */
    }
  if (!ok && child.pid)
    try {
      child.kill('SIGKILL')
      ok = true
    } catch {
      /* already gone */
    }
  return ok
}

/**
 * Read bash's own pid from the file the command prefix writes.
 *
 * Synchronous and single-shot on purpose. This runs at kill time, when bash has long
 * written the file, and it must not add startup latency to commands that are never
 * killed. `undefined` simply means the group signal is unavailable, which the Win32
 * tree kill already covers for ordinary children.
 * @param file - the pid file the command prefix writes.
 * @returns bash's own pid, or `undefined`.
 */
function readMsysPidSync(file) {
  try {
    const value = readFileSync(file, 'utf8').trim()
    return /^\d+$/u.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Bound a captured stream, reporting the loss instead of hiding it. */
function collector(limit) {
  const chunks = []
  let size = 0
  let dropped = 0
  return {
    push(chunk) {
      size += chunk.length
      if (size <= limit) {
        chunks.push(chunk)
        return
      }
      const room = limit - (size - chunk.length)
      if (room > 0) chunks.push(chunk.subarray(0, room))
      dropped += chunk.length - Math.max(room, 0)
    },
    get bytes() {
      return size
    },
    text() {
      const value = Buffer.concat(chunks).toString('utf8')
      return dropped > 0
        ? `${value}\n[opl-muse-bash: truncated ${dropped} of ${size} bytes]`
        : value
    },
    get dropped() {
      return dropped
    },
  }
}

/**
 * Run one command through Git Bash.
 *
 * Exported so the adapter's own tests can drive the exact execution path the MCP
 * tool uses, instead of a parallel re-implementation that could drift from it.
 * @param params - command, optional cwd, timeoutMs and stdin.
 * @param env - the environment holding the resolved shell.
 * @param control - optional cancellation handle. When `control.cancel()` is called the
 * process tree is killed and the returned promise only settles once the child has
 * actually closed, so a caller that awaits the result knows the command is gone.
 * @returns exit code and the three outcome channels, or a refusal for bad input.
 */
export async function runBashCommand(params, env = process.env, control = undefined) {
  const command = typeof params?.command === 'string' ? params.command : ''
  if (!command.trim()) return { refused: 'command must be a non-empty string' }

  const requestedCwd = typeof params?.cwd === 'string' && params.cwd.trim() ? params.cwd : undefined
  let cwd
  if (requestedCwd) {
    cwd = resolve(requestedCwd)
    let stats
    try {
      stats = statSync(cwd)
    } catch {
      return { refused: `cwd does not exist: ${requestedCwd}` }
    }
    if (!stats.isDirectory()) return { refused: `cwd is not a directory: ${requestedCwd}` }
  }

  const rawTimeout = Number(params?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const timeoutMs = Math.min(
    Math.max(Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS, 1),
    TIMEOUT_CEILING_MS,
  )
  const rawMax = Number(params?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT)
  const maxOutputBytes = Math.min(
    Math.max(Number.isFinite(rawMax) && rawMax > 0 ? rawMax : DEFAULT_MAX_OUTPUT, 1024),
    MAX_OUTPUT_CEILING,
  )

  const { shell, native } = resolveBash(env)
  // The pid file lives in the session's own temporary directory and is removed before
  // this function returns, so a timed-out or cancelled command leaves nothing behind.
  const pidFile = join(tmpdir(), `opl-muse-bash-${process.pid}-${nextPidFile()}.pid`)
  const script = `printf '%s' "$$" > "${pidFile}" 2>/dev/null; ${command}`
  const child = spawn(shell, ['--noprofile', '--norc', '-c', script], {
    cwd,
    env: {
      ...env,
      // Git Bash reads these to keep UTF-8 arguments and paths intact; without
      // them a non-ASCII workspace name is mangled on the way to the command.
      MSYS_NO_PATHCONV: '1',
      MSYS2_ARG_CONV_EXCL: '*',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    windowsHide: true,
    detached: !native,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout = collector(maxOutputBytes)
  const stderr = collector(maxOutputBytes)
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))

  const stdinText = typeof params?.stdin === 'string' ? params.stdin : ''
  if (stdinText) child.stdin.end(stdinText)
  else child.stdin.end()

  let timedOut = false
  let cancelled = false
  // The kill is awaited before its result is reported: `close` can fire while the
  // signal is still in flight, and reporting "kill confirmed" from a flag that had not
  // been written yet would be exactly the kind of unearned success this file avoids.
  let killPromise = Promise.resolve(false)
  const stop = () => {
    killPromise = killTree(child, shell, pidFile)
  }
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, timeoutMs)
  // Cancellation kills the same tree the timeout does, and the promise below still
  // settles only on the child's own `close`. So awaiting this call is itself the proof
  // that the command is no longer running — no separate "did it die?" step, and no
  // window in which the caller could observe a command that is still writing.
  control?.attach(child)
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    stop()
  }
  control?.onCancel(cancel)
  if (control?.isCancelled()) cancel()

  const outcome = await new Promise((done) => {
    child.on('error', (error) => done({ error: error }))
    child.on('close', (code, signal) => done({ code, signal }))
  })
  clearTimeout(timer)
  const killConfirmed = timedOut || cancelled ? await killPromise : false
  control?.detach()
  rmSync(pidFile, { force: true })

  if (outcome.error) return { refused: `failed to start ${shell}: ${outcome.error.message}` }
  return {
    exitCode: outcome.code ?? null,
    signal: outcome.signal ?? null,
    timedOut,
    cancelled,
    killConfirmed,
    command,
    cwd: cwd ?? process.cwd(),
    shell,
    stdout: stdout.text(),
    stderr: stderr.text(),
    truncatedBytes: stdout.dropped + stderr.dropped,
  }
}

let pidSequence = 0
function nextPidFile() {
  pidSequence += 1
  return pidSequence
}

/**
 * One cancellable tool call.
 *
 * The MCP `notifications/cancelled` message carries the id of the request being
 * withdrawn, so the server keeps that id attached to the child it started and kills
 * exactly that tree. Counting cancellations was not enough: the controlled command kept
 * running and kept writing after the notification arrived.
 */
export class CancellationControl {
  constructor() {
    this.child = undefined
    this.cancelled = false
    this.listener = undefined
  }
  attach(child) {
    this.child = child
  }
  detach() {
    this.child = undefined
    this.listener = undefined
  }
  isCancelled() {
    return this.cancelled
  }
  onCancel(listener) {
    this.listener = listener
  }
  /** Kill this call's process tree, if it is still running. */
  cancel() {
    this.cancelled = true
    if (this.child) this.listener?.()
  }
}

const TOOLS = [
  {
    name: 'run',
    description:
      'Run a command in Git Bash (MSYS). Accepts an arbitrary shell command, an optional working directory, an optional timeout and optional stdin. Reports exit code, stdout and stderr separately.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run through bash -c.' },
        cwd: {
          type: 'string',
          description: 'Working directory. Defaults to the session workspace.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          description: 'Kill the command and its children after this many milliseconds.',
        },
        stdin: { type: 'string', description: 'Optional stdin payload.' },
        maxOutputBytes: {
          type: 'integer',
          minimum: 1024,
          description: 'Cap on captured stdout/stderr. Truncation is reported, never silent.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
]

async function handle(message, state) {
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'opl_muse_git_bash', version: '1' },
      })
    case 'tools/list':
      return reply(id, { tools: TOOLS })
    case 'ping':
      return reply(id, {})
    case 'tools/call': {
      const tool = params?.name
      if (tool !== 'run') return fail(id, -32602, `unknown tool: ${String(tool)}`)
      // Register the control under the request id before the child exists, so a
      // cancellation that arrives during startup is not lost.
      const control = new CancellationControl()
      state.running.set(String(id), control)
      let result
      try {
        result = await runBashCommand(params?.arguments ?? {}, process.env, control)
      } finally {
        state.running.delete(String(id))
      }
      if (result.refused)
        return reply(id, {
          content: [{ type: 'text', text: `Refused: ${result.refused}` }],
          isError: true,
        })
      const summary = [
        `exit=${result.exitCode}`,
        result.signal ? `signal=${result.signal}` : '',
        result.timedOut
          ? `timedOut after ${params?.arguments?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
          : '',
        // A withdrawn call is reported as cancelled, which is a real outcome the
        // runtime chose, not an error invented by the server.
        result.cancelled ? 'cancelled' : '',
        // Only claimed when the tree kill actually reported success.
        result.timedOut || result.cancelled ? `killConfirmed=${result.killConfirmed}` : '',
        `shell=${result.shell}`,
        `cwd=${result.cwd}`,
        result.truncatedBytes ? `truncatedBytes=${result.truncatedBytes}` : '',
      ]
        .filter(Boolean)
        .join(' ')
      return reply(id, {
        content: [
          {
            type: 'text',
            text: `${summary}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
          },
        ],
        isError: result.exitCode !== 0 || result.timedOut || result.cancelled,
      })
    }
    case 'notifications/cancelled': {
      // `requestId` names the call being withdrawn. Without it there is nothing to
      // cancel and nothing is claimed.
      const target = String(params?.requestId ?? '')
      const control = state.running.get(target)
      state.cancelled += 1
      if (!control) {
        log(`opl-muse-bash: 取消请求没有对应的运行中调用（requestId=${target || '缺失'}）`)
        return undefined
      }
      control.cancel()
      return undefined
    }
    default:
      if (id === undefined) return undefined
      return fail(id, -32601, `Method not implemented: ${String(method)}`)
  }
}

/**
 * Run the server on stdio until the CLI closes the pipe.
 *
 * The bash is resolved before the first read, so a missing shell fails the launch
 * with its own exit code instead of surfacing later as a tool error that looks like
 * the model's fault.
 */
export async function main() {
  let shellInfo
  try {
    shellInfo = resolveBash(process.env)
  } catch (error) {
    log(`opl-muse-bash: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(EXIT_NO_BASH)
  }
  log(`opl-muse-bash: serving run through ${shellInfo.shell}`)

  const state = { cancelled: 0, running: new Map() }
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch (error) {
        log(
          `opl-muse-bash: dropped unparsable line: ${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }
      Promise.resolve(handle(message, state)).catch((error) => {
        if (message.id !== undefined)
          fail(message.id, -32603, error instanceof Error ? error.message : String(error))
      })
    }
  })
  process.stdin.on('end', () => process.exit(EXIT_OK))
  process.stdin.on('error', () => process.exit(EXIT_OK))
}

// Only self-start when executed as a program; importing for tests must not
// hijack the caller's stdio. `pathToFileURL` rather than string concatenation:
// on Windows `import.meta.url` carries a `file:///C:/…` authority-less triple
// slash, which a hand-built `file://` prefix never matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
