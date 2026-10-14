/**
 * Windows shell binding for the official OpenCode CLI.
 *
 * ## Why this module exists at all
 *
 * OpenCode has two different shell bindings, and only one of them works in the pinned
 * release (`opencode-ai@1.19.0`). This was verified by running the real binary, not by
 * reading a changelog:
 *
 * | binding                                             | observed result                              |
 * | -------------------------------------------------- | -------------------------------------------- |
 * | root config `shell` = verified `bash.exe`            | ran in Git Bash (`/usr/bin/bash`, MINGW64)     |
 * | `OPENCODE_GIT_BASH_PATH` env only                    | ran in **PowerShell** (exit 1, cmdlet error)  |
 * | neither, on a host with no `SHELL`                   | ran in **PowerShell**                         |
 * | root config `shell` pointing at a missing file       | **silently ran in PowerShell**                |
 *
 * The pinned CLI selects its shell in `@opencode/ShellSelect`. `resolve()` prefers the
 * root config's `shell` value; `OPENCODE_GIT_BASH_PATH` survives only as `Options.gitbash`,
 * which feeds the Windows *candidate list* `[pwsh, powershell, gitbash, COMSPEC]`. That
 * list is consulted only after the configured value fails to resolve — so on a host with
 * no `SHELL`, setting the environment variable alone still lands on `pwsh`.
 *
 * Two consequences shape this module:
 *
 * 1. The root config `shell` is the only binding this suite may rely on.
 * 2. A wrong `shell` value is **not** an error. OpenCode silently falls through to
 *    PowerShell, so this suite must never let one reach the CLI unverified: it runs the
 *    chosen executable first and refuses the launch when it is missing or is not a Git
 *    Bash/MSYS runtime. No PowerShell, CMD, or WSL fallback is attempted.
 *
 * The environment still carries `OPENCODE_GIT_BASH_PATH` and `SHELL` pointing at the same
 * verified executable. Neither is load-bearing on the pinned release; they are set so an
 * older V1 build — where the environment variable *was* the binding — also stays on Git
 * Bash instead of silently switching shells. That is a compatibility hint, never a claim:
 * the assertion made here is only about the executable this suite hands over, verified by
 * actually running it.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, isAbsolute, win32 } from 'node:path'
import { resolveGitBashPath } from '../../../../shell/host/git-bash.ts'
import { HarnessConfigurationError } from '../../acp.ts'

const exec = promisify(execFile)

/** Root config key the pinned CLI's shell selector actually reads. */
export const OPENCODE_SHELL_CONFIG_KEY = 'shell'
/** The variable V1 used as its binding; still read as `Options.gitbash` in V2. */
export const OPENCODE_GIT_BASH_VARIABLE = 'OPENCODE_GIT_BASH_PATH'
/** Variable the selector consults when no configured value is present. */
export const OPENCODE_SHELL_VARIABLE = 'SHELL'
/** Prefix used by the launch probe so its output cannot be confused with a task's. */
const PROBE_PREFIX = 'OPL_OPENCODE_BASH:'

/**
 * What the pinned CLI does and does not expose about its shell choice. Exported so
 * capabilities, diagnostics, and tests all describe the same measured behaviour instead
 * of each asserting something slightly different.
 */
export const OPENCODE_SHELL_FACTS = {
  /** The root config `shell` value is the selector's first choice. */
  bindsFromRootConfig: true,
  /** `OPENCODE_GIT_BASH_PATH` only feeds the Windows candidate list, after pwsh. */
  gitBashVariableIsSufficient: false,
  /** An unresolvable configured shell silently falls through to PowerShell. */
  invalidShellFallsBackToPowerShell: true,
  /** The ACP agent advertises no shell, so the choice cannot be read back over ACP. */
  advertisesShell: false,
  /** The ACP agent advertises no terminal capability. */
  advertisesTerminal: false,
} as const

/** Options for {@link openCodeShellBinding}, all injectable so failure paths are testable. */
export interface OpenCodeShellOptions {
  readonly platform?: NodeJS.Platform
  /** Overrides Git Bash discovery; the default uses the suite's own resolver. */
  readonly resolve?: () => string
  /** Overrides the launch probe. Receives the candidate shell and returns its `uname`. */
  readonly probe?: (shell: string, env: NodeJS.ProcessEnv) => Promise<string>
}

const missingShell = (reason: string) =>
  new HarnessConfigurationError(
    `OpenCode Git Bash 启动验证失败（${reason}）。请安装 Git for Windows，或将 OPL_GIT_BASH_PATH 指向可运行的 bash.exe。未启动 OpenCode，未回退 PowerShell、CMD 或 WSL。`,
  )

/**
 * Verify the shell this suite selected really is a runnable Git Bash, by executing it.
 *
 * @returns the reported system name so callers can record what answered.
 * @throws when the candidate cannot be run or is not a Git Bash/MSYS runtime.
 */
export async function verifyOpenCodeGitBash(
  shell: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
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
 * Check the shape the CLI's own `full()` requires before it will use a configured shell.
 *
 * `executable()` only accepts a rooted path that stats to a file, so a bare `bash` or a
 * directory is refused here instead of being handed over as a value the selector would
 * reinterpret — and then silently replace with PowerShell.
 *
 * @returns true when the selector will accept this path unchanged.
 */
export function openCodeShellSelectionAccepts(shell: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return true
  if (!isAbsolute(shell)) return false
  return /^bash(?:\.exe)?$/i.test(basename(shell))
}

export interface OpenCodeShellBinding {
  /**
   * Root config fragment carrying the verified shell, to merge into the CLI config.
   * Empty on POSIX hosts, where the selector has no PowerShell fall-through to guard.
   */
  readonly config: Readonly<Partial<Record<typeof OPENCODE_SHELL_CONFIG_KEY, string>>>
  /** Environment overrides for the child process. */
  readonly env: NodeJS.ProcessEnv
  /** The runtime identifier the verified executable reported, for diagnostics only. */
  readonly uname: string
}

/**
 * Resolve, execute, and describe the one shell binding the pinned CLI actually honours.
 *
 * POSIX hosts keep their own default shell and inject nothing: the Windows PowerShell
 * fall-through this guards against does not exist there, and overriding a POSIX host's
 * shell would be an unrequested change to the user's environment.
 *
 * @throws when Git Bash is missing, unusable, or unusable as a configured shell value.
 */
export async function openCodeShellBinding(
  env: NodeJS.ProcessEnv,
  options: OpenCodeShellOptions = {},
): Promise<OpenCodeShellBinding> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32')
    return { config: {}, env, uname: platform === 'darwin' ? '/bin/zsh' : '/bin/sh' }
  let shell: string
  try {
    shell = (options.resolve ?? (() => resolveGitBashPath()))()
  } catch (cause) {
    throw missingShell(cause instanceof Error ? cause.message : '未找到 Git Bash')
  }
  if (!openCodeShellSelectionAccepts(shell, platform))
    throw missingShell(`所选路径不是 OpenCode 会直接采用的 bash.exe：${shell}`)
  const uname = await (
    options.probe ?? ((target, source) => verifyOpenCodeGitBash(target, source))
  )(shell, env)
  if (!uname) throw missingShell('未获得 shell 运行时标识')
  return {
    config: { [OPENCODE_SHELL_CONFIG_KEY]: shell },
    env: { ...env, [OPENCODE_SHELL_VARIABLE]: shell, [OPENCODE_GIT_BASH_VARIABLE]: shell },
    uname,
  }
}

/**
 * Merge the verified shell into a serialised CLI configuration document.
 *
 * The document is produced by this suite in {@link buildOpenCodeRouteConfig}, so parsing
 * and re-serialising it here cannot lose or reorder the owner's route. The `shell` key is
 * a root key, exactly where the CLI's shell selector reads it.
 *
 * @throws when the document is not the JSON this suite produced.
 */
export function withOpenCodeShell(content: string, binding: OpenCodeShellBinding): string {
  let document: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('not an object')
    document = parsed as Record<string, unknown>
  } catch {
    throw new HarnessConfigurationError(
      '模型来源的 OpenCode 配置无法解析，已停止，未启动 OpenCode。',
    )
  }
  if (Object.keys(binding.config).length === 0) return content
  return JSON.stringify({ ...binding.config, ...document })
}

/**
 * Compare two Windows paths the way the CLI's `name()` does, so a drive-letter or
 * separator difference never turns a correct shell into a false mismatch.
 */
export function sameShellFile(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
}
