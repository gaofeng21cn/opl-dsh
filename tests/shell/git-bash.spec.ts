import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { type Config, GitBashExecutor, resolveGitBashPath } from '../../src/shell/host/git-bash.ts'

describe('Git Bash path resolution', () => {
  it('accepts an explicit executable path containing spaces', () => {
    const path = resolveGitBashPath({
      platform: 'win32',
      env: { OPL_GIT_BASH_PATH: 'C:/Program Files/Git/bin/bash.exe' },
      exists: (candidate) => candidate.includes('Program Files'),
    })
    expect(path).toBe('C:/Program Files/Git/bin/bash.exe')
  })

  it('reports an actionable error when Git Bash is unavailable', () => {
    expect(() =>
      resolveGitBashPath({ platform: 'win32', env: { PATH: '' }, exists: () => false }),
    ).toThrow(/OPL_GIT_BASH_PATH/)
  })

  it('does not fall back when an explicit override is invalid', () => {
    expect(() =>
      resolveGitBashPath({
        platform: 'win32',
        env: { OPL_GIT_BASH_PATH: 'C:/missing/bash.exe', ProgramFiles: 'C:/Program Files' },
        exists: (candidate) => candidate.includes('Program Files'),
      }),
    ).toThrow(/no fallback/)
    expect(() =>
      resolveGitBashPath({
        platform: 'win32',
        env: { OPL_GIT_BASH_PATH: 'bash.exe' },
        exists: () => true,
      }),
    ).toThrow(/absolute/)
  })
})

/**
 * The Bash this host's executor will actually spawn, or `null` when the host has none.
 * A missing Bash is a capability gap, so the dependent cases skip instead of asserting less.
 */
const configuredBash = (): string | null => {
  try {
    const path = resolveGitBashPath()
    // POSIX resolves to the bare `bash` name and resolves through PATH; only a
    // Windows absolute path is probed on disk.
    return path === 'bash' || statSync(path).isFile() ? path : null
  } catch {
    return null
  }
}

const CONFIGURED_BASH = configuredBash()

/** A collect-mode reader over an already-captured buffer, as the subprocess seam requires. */
const bufferReader = (buffer: () => Buffer) => ({
  readFrom: (from = 0) => ({
    text: buffer().subarray(from).toString('utf8'),
    lossy: false,
    nextOffset: buffer().length,
  }),
})

const settled = () => ({
  done: Promise.resolve({ exitCode: 0, signal: null }),
  collected: {
    stdout: bufferReader(() => Buffer.alloc(0)),
    stderr: bufferReader(() => Buffer.alloc(0)),
  },
  terminate: () => {},
})

/** One spawn the executor handed to the subprocess seam. */
interface CapturedSpawn {
  readonly argv: readonly string[]
  readonly cwd: string
}

/**
 * Mount the executor on a context carrying only the services its constructor and the
 * public entry touch, so the cases drive the real class rather than a stand-in.
 *
 * Real spawns are owned by the returned disposer: it never targets a PID it did not
 * create, kills only children still running, and awaits their exit before returning.
 */
const mountExecutor = (
  options: {
    readonly mode?: 'danger-full-access' | 'workspace-write'
    readonly real?: boolean
  } = {},
) => {
  const mode = options.mode ?? 'danger-full-access'
  const real = options.real ?? true
  const captured: CapturedSpawn[] = []
  const owned: { child: ChildProcess; done: Promise<unknown>; detach: () => void }[] = []

  const spawnOwned = (spec: {
    argv: readonly string[]
    cwd: string
    env: Record<string, string>
    signal?: AbortSignal
  }) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    const child = spawn(spec.argv[0]!, spec.argv.slice(1) as string[], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
    const stdout = () => Buffer.concat(out)
    const stderr = () => Buffer.concat(err)
    // The handle only settles once the streams close, so the executor must not hold a
    // delayed kill that could land after the process exited and its PID was reused.
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('close', (code, signal) =>
          resolve({ exitCode: code, signal: signal as NodeJS.Signals | null }),
        )
        child.once('error', (error: Error) => {
          err.push(Buffer.from(`spawn failed: ${error.message}\n`))
          resolve({ exitCode: null, signal: null })
        })
      },
    )
    const onAbort = () => child.kill()
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    owned.push({ child, done, detach: () => spec.signal?.removeEventListener('abort', onAbort) })
    return {
      done,
      collected: { stdout: bufferReader(stdout), stderr: bufferReader(stderr) },
      terminate: () => child.kill(),
    }
  }

  const ctx = new Context() as Context & Record<string, unknown>
  Object.assign(ctx, {
    sandboxPolicy: { defaultMode: mode, resolve: () => ({ mode }) },
    sandbox: {
      // The official seam hands the provider the inner argv, not a command string.
      confine: (argv: readonly string[]) => ({
        argv: ['/runner/sandbox-exec', '--', ...argv],
        enforcement: 'native',
        denialSignatures: [],
        runnerFailureRules: [],
      }),
    },
    subprocess: {
      spawn: (spec: Parameters<typeof spawnOwned>[0]) => {
        captured.push({ argv: spec.argv, cwd: spec.cwd })
        return real ? spawnOwned(spec) : settled()
      },
    },
  })
  const config = {
    cwd: { get: () => process.cwd() },
    timeoutMs: { get: () => 30_000 },
    maxTimeoutMs: { get: () => 120_000 },
    maxOutputBytes: { get: () => 64_000 },
    maxSpillBytes: { get: () => 1_000_000 },
    graceMs: { get: () => 200 },
  } as unknown as Config

  return {
    executor: new GitBashExecutor(ctx, config),
    captured,
    /** Release every child this mount created and wait for its exit. */
    dispose: async () => {
      for (const entry of owned) {
        entry.detach()
        // Only a child still running is signalled; a settled one owns no PID to hit.
        if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill()
      }
      await Promise.allSettled(owned.map((entry) => entry.done))
    },
  }
}

/** Run one command through the public entry and always leave nothing running. */
const runBash = async (
  executor: GitBashExecutor,
  request: Parameters<GitBashExecutor['resolve']>[0],
) => {
  const execution = await executor.execute(executor.resolve(request))
  try {
    return await execution.result()
  } finally {
    if (execution.status === 'running') execution.kill()
  }
}

describe.skipIf(CONFIGURED_BASH === null)('Git Bash executor runs Bash', () => {
  it('runs a Bash command under the configured Bash, including a work directory with spaces', async () => {
    const { executor, captured, dispose } = mountExecutor()
    const workdir = mkdtempSync(join(tmpdir(), 'opl git bash '))
    try {
      const result = await runBash(executor, {
        command: 'pwd; echo shell=$0; echo marker=OPL_BASH_OK',
        workdir,
      })

      expect(result.exitCode).toBe(0)
      expect(result.stderr.text).toBe('')
      expect(result.stdout.text).toContain('opl git bash')
      expect(result.stdout.text).toContain('marker=OPL_BASH_OK')
      // The interpreter is Bash, not another shell.
      expect(result.stdout.text).toMatch(/shell=.*bash/u)
      // The spawn carried the configured executable verbatim, unquoted and unbroken.
      expect(captured[0]?.argv[0]).toBe(CONFIGURED_BASH)
      expect(captured[0]?.cwd).toBe(workdir)
    } finally {
      await dispose()
    }
  })

  it('runs valid Bash whose text happens to read like PowerShell', async () => {
    // Regression cover for the rejected heuristic: every one of these is ordinary
    // Bash that must keep running untouched, at exit 0 with its literal output.
    const cases: readonly { command: string; stdout: string }[] = [
      { command: "printf '%s\\n' '$env:PATH'", stdout: '$env:PATH' },
      {
        command: "printf '%s\\n' '[System.IO.Path]::GetTempPath()'",
        stdout: '[System.IO.Path]::GetTempPath()',
      },
      { command: "printf '%s\\n' 'Get-Location'", stdout: 'Get-Location' },
      { command: 'PSVersionTable=ordinary; printf "%s\\n" "$PSVersionTable"', stdout: 'ordinary' },
      { command: "cat <<'TEXT'\nGet-Location\nTEXT", stdout: 'Get-Location' },
    ]
    const { executor, dispose } = mountExecutor()
    try {
      for (const { command, stdout } of cases) {
        const result = await runBash(executor, { command })
        expect(result.exitCode, command).toBe(0)
        expect(result.stderr.text, command).toBe('')
        expect(result.stdout.text.trim(), command).toBe(stdout)
      }
    } finally {
      await dispose()
    }
  })

  it('runs the shell probes the chief review used to identify the interpreter', async () => {
    const { executor, dispose } = mountExecutor()
    try {
      const probe = await runBash(executor, { command: 'echo shell=$0; uname -s; pwd' })
      expect(probe.exitCode).toBe(0)
      expect(probe.stdout.text).toContain('shell=')
      expect(probe.stdout.text).toMatch(/OPL|MINGW|CYGWIN|Linux|Darwin/u)
    } finally {
      await dispose()
    }
  })
})

describe('Git Bash executor confinement', () => {
  it('still confines Bash and still rewrites it to the configured Windows Bash', async () => {
    // No real process is spawned here, so the argv reaching the seam is the whole
    // assertion and nothing needs cleaning up.
    const { executor, captured, dispose } = mountExecutor({ mode: 'workspace-write', real: false })
    try {
      await executor.execute(executor.resolve({ command: 'echo confined=OPL_CONFINED_OK' }))

      expect(captured[0]?.argv).toEqual([
        '/runner/sandbox-exec',
        '--',
        resolveGitBashPath(),
        '-c',
        'echo confined=OPL_CONFINED_OK',
      ])
    } finally {
      await dispose()
    }
  })
})
