/**
 * Windows shell binding for the official MiMo Code CLI (`mimo`).
 *
 * MiMo selects its shell in `@/shell/shell`, and the selection is decided once from the
 * child's environment:
 *
 *   `preferred = lazy(() => select(process.env.SHELL))`
 *   `select(file)` returns `full(file)` when `SHELL` is set, and only falls back to
 *   `pick()` (`pwsh.exe`, then `powershell.exe`) when `SHELL` is empty. On Windows,
 *   `full()` returns an absolute `SHELL` path unchanged, so pointing `SHELL` at a real
 *   Git Bash removes the PowerShell path from consideration entirely.
 *   `gitbash()` is the separate fallback used when no `SHELL` is given, and it honours
 *   the `MIMOCODE_GIT_BASH_PATH` flag. Both variables are therefore injected with the
 *   same executable so neither selection path can reach PowerShell, CMD, or WSL.
 *
 * What this module deliberately does *not* do is claim the CLI honoured either
 * variable. MiMo's ACP `initialize` advertises no shell at all — its `_meta` carries
 * only variant information, and `agentCapabilities` declares no terminal method — so
 * there is no public read-back to compare against. Setting an environment variable is
 * therefore never treated as proof: the only assertion made here is about the
 * executable this suite hands over, verified by actually running it. An agent-side
 * advertisement is required before this suite can claim the binding was accepted, and
 * until one exists the gap is recorded rather than papered over.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, isAbsolute, win32 } from 'node:path'
import { resolveGitBashPath } from '../../../../shell/host/git-bash.ts'
import { HarnessConfigurationError } from '../../acp.ts'

const exec = promisify(execFile)

/** The variable MiMo's shell selection actually reads. */
export const MIMO_SHELL_VARIABLE = 'SHELL'
/** The flag MiMo's `gitbash()` fallback honours; declared in `@/flag/flag`. */
export const MIMO_GIT_BASH_VARIABLE = 'MIMOCODE_GIT_BASH_PATH'
/** Prefix used by the launch probe so its output cannot be confused with a task's. */
const PROBE_PREFIX = 'OPL_MIMO_BASH:'

/**
 * What the official CLI does and does not expose about its shell choice, as of the
 * pinned source. Exported so capabilities, diagnostics, and tests all describe the
 * same real limitation instead of each asserting something slightly different.
 */
export const MIMO_SHELL_FACTS = {
  /** The CLI reads `SHELL` and, for its fallback, the `MIMOCODE_GIT_BASH_PATH` flag. */
  readsShellEnvironment: true,
  /** MiMo's ACP agent advertises no shell, so the choice cannot be read back. */
  advertisesShell: false,
  /** MiMo's ACP agent advertises no terminal capability. */
  advertisesTerminal: false,
} as const

/** Options for {@link mimoShellEnvironment}, all injectable so failure paths are testable. */
export interface MimoShellOptions {
  readonly platform?: NodeJS.Platform
  /** Overrides Git Bash discovery; the default uses the suite's own resolver. */
  readonly resolve?: () => string
  /** Overrides the launch probe. Receives the candidate shell and returns its `uname`. */
  readonly probe?: (shell: string, env: NodeJS.ProcessEnv) => Promise<string>
}

const missingShell = (reason: string) =>
  new HarnessConfigurationError(
    `MiMo Code Git Bash 启动验证失败（${reason}）。请安装 Git for Windows，或将 OPL_GIT_BASH_PATH 指向可运行的 bash.exe。未启动 mimo，未回退 PowerShell、CMD 或 WSL。`,
  )

/**
 * Verify the shell this suite selected really is a runnable Git Bash, by executing it.
 * Returns the reported system name so callers can record what answered.
 *
 * @throws when the candidate cannot be run or is not a Git Bash/MSYS runtime.
 */
export async function verifyMimoGitBash(shell: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await exec(
      shell,
      ['--noprofile', '--norc', '-c', `printf '${PROBE_PREFIX}'; /usr/bin/uname -s`],
      { env, windowsHide: true, timeout: 10_000, maxBuffer: 4096 },
    )
    const output = result.stdout.trim()
    if (output.startsWith(PROBE_PREFIX)) {
      const uname = output.slice(PROBE_PREFIX.length)
      if (/^MINGW(?:32|64)?_NT-|^MSYS_NT-/.test(uname)) return uname
    }
  } catch {
    throw missingShell('所选 shell 无法执行')
  }
  throw missingShell('所选 shell 不是 Git Bash 运行时')
}

/**
 * Check the shape MiMo's own `full()` requires before it will use a Windows `SHELL`.
 * `select()` only bypasses the PowerShell fallback when the variable holds a path that
 * resolves to a file, so a bare `bash` or a directory path is refused here instead of
 * being handed over as a selection MiMo would reinterpret.
 *
 * @returns true when MiMo's selection rule will accept this path unchanged.
 */
export function mimoShellSelectionAccepts(shell: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return true
  if (!isAbsolute(shell)) return false
  return /^bash(?:\.exe)?$/i.test(basename(shell))
}

/**
 * Build the child environment that pins the official CLI to Git Bash.
 *
 * Both variables receive the same verified executable, and a selection MiMo could
 * reinterpret is refused instead of being passed along. POSIX hosts keep their own
 * default shell and inject nothing.
 *
 * @returns the environment to hand to the child process.
 * @throws when Git Bash is missing, unusable, or unusable as a `SHELL` value.
 */
export async function mimoShellEnvironment(
  env: NodeJS.ProcessEnv,
  options: MimoShellOptions = {},
): Promise<NodeJS.ProcessEnv> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return env
  let shell: string
  try {
    shell = (options.resolve ?? (() => resolveGitBashPath()))()
  } catch (cause) {
    throw missingShell(cause instanceof Error ? cause.message : '未找到 Git Bash')
  }
  if (!mimoShellSelectionAccepts(shell, platform))
    throw missingShell(`所选路径不是 MiMo 会直接采用的 bash.exe：${shell}`)
  const uname = await (options.probe ?? ((target, source) => verifyMimoGitBash(target, source)))(
    shell,
    env,
  )
  if (!uname) throw missingShell('未获得 shell 运行时标识')
  return { ...env, [MIMO_SHELL_VARIABLE]: shell, [MIMO_GIT_BASH_VARIABLE]: shell }
}

/**
 * Compare two Windows paths the way MiMo's `name()` does, so a drive-letter or
 * separator difference never turns a correct shell into a false mismatch.
 */
export function sameShellFile(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
}
