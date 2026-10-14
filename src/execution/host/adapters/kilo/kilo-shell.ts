/**
 * Windows shell binding for the official Kilo CLI.
 *
 * ## Why this module exists at all
 *
 * The pinned release (`@kilocode/cli@7.8.8`) has two different shell bindings, and only one
 * of them actually decides which interpreter runs a command. This was measured by driving a
 * real `bash` tool call through the official agent loop with a keyless loopback provider,
 * not by reading documentation:
 *
 * | merged config root `shell` | environment                        | observed interpreter        |
 * | ------------------------- | --------------------------------- | --------------------------- |
 * | verified Git Bash `bash.exe` | anything                         | **Git Bash** (MINGW64_NT, `bash 5.3.15`, `$0=/usr/bin/bash`) |
 * | verified Git Bash `bash.exe` | anything                         | **Git Bash** (same marker)  |
 * | missing / unrunnable path | valid Git Bash in `SHELL` **and** `KILO_GIT_BASH_PATH` | **PowerShell** — a PowerShell `ParserError`, *not* Git Bash |
 *
 * The shipped source agrees with the measurement. The bash tool reads
 * `config.entries()`, merges the root `shell` key across its document entries, and uses
 * `?? defaultShell()` when that key is absent. Nothing in that path consults the
 * environment. `KILO_GIT_BASH_PATH` and `SHELL` live only in the legacy shell selector,
 * which still produces the bash tool's *description* text — so a run can *say* "Shell: bash"
 * and still execute in PowerShell.
 *
 * Three consequences shape this module:
 *
 * 1. The merged config `shell` is the only binding this suite may rely on, so the verified
 *    executable is written into that root key rather than left to the environment.
 * 2. A wrong or unrunnable `shell` value is **not** an error. Kilo silently falls through
 *    to PowerShell, so this suite must never let one reach the CLI unverified: it runs the
 *    chosen executable first and refuses the launch when it is missing or is not a Git
 *    Bash/MSYS runtime. No PowerShell, CMD, or WSL fallback is attempted.
 * 3. Because the interpreter is chosen per tool call and not confined to a directory, this
 *    binding says nothing about sandboxing. See {@link KILO_SHELL_FACTS} for what is and is
 *    not claimed.
 *
 * The environment still carries `SHELL` and `KILO_GIT_BASH_PATH` pointing at the same
 * verified executable. Neither is load-bearing on the pinned release; they are set so the
 * legacy selector — which does produce the tool description the model reads — describes the
 * shell that will actually run, instead of contradicting it.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, isAbsolute, win32 } from 'node:path'
import { resolveGitBashPath } from '../../../../shell/host/git-bash.ts'
import { HarnessConfigurationError } from '../../acp.ts'

const exec = promisify(execFile)

/** Root config key the pinned CLI's bash tool actually reads. */
export const KILO_SHELL_CONFIG_KEY = 'shell'
/** Legacy V1 variable, read only by the selector that writes the tool description. */
export const KILO_GIT_BASH_VARIABLE = 'KILO_GIT_BASH_PATH'
/** Legacy V1 variable, same limited role. */
export const KILO_SHELL_VARIABLE = 'SHELL'
/** Prefix used by the launch probe so its output cannot be confused with a task's. */
const PROBE_PREFIX = 'OPL_KILO_BASH:'

/**
 * What the pinned CLI does and does not expose about its shell choice. Exported so
 * capabilities, diagnostics and tests all describe the same measured behaviour instead of
 * each asserting something slightly different.
 */
export const KILO_SHELL_FACTS = {
  /** The merged config root `shell` value is the only binding that selects the interpreter. */
  bindsFromMergedConfig: true,
  /** `KILO_GIT_BASH_PATH` and `SHELL` do not override a configured shell. */
  legacyEnvironmentIsSufficient: false,
  /** An unrunnable configured shell silently falls through to PowerShell. */
  invalidShellFallsBackToPowerShell: true,
  /** The ACP agent advertises no shell, so the choice cannot be read back over ACP. */
  advertisesShell: false,
  /** The ACP agent advertises no terminal capability. */
  advertisesTerminal: false,
  /** A bash tool call runs with host-user filesystem, process and network authority. */
  confinesToWorkingDirectory: false,
} as const

/** Options for {@link kiloShellBinding}, all injectable so failure paths are testable. */
export interface KiloShellOptions {
  readonly platform?: NodeJS.Platform
  /** Overrides Git Bash discovery; the default uses the suite's own resolver. */
  readonly resolve?: () => string
  /** Overrides the launch probe. Receives the candidate shell and returns its `uname`. */
  readonly probe?: (shell: string, env: NodeJS.ProcessEnv) => Promise<string>
}

const missingShell = (reason: string) =>
  new HarnessConfigurationError(
    `Kilo Git Bash 启动验证失败（${reason}）。请安装 Git for Windows，或将 OPL_GIT_BASH_PATH 指向可运行的 bash.exe。未启动 Kilo，未回退 PowerShell、CMD 或 WSL。`,
  )

/**
 * Verify the shell this suite selected really is a runnable Git Bash, by executing it.
 *
 * @returns the reported system name so callers can record what answered.
 * @throws when the candidate cannot be run or is not a Git Bash/MSYS runtime.
 */
export async function verifyKiloGitBash(shell: string, env: NodeJS.ProcessEnv): Promise<string> {
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
 * Check the shape the bash tool needs before it will run a command.
 *
 * The shell is handed to the process layer as the interpreter, so a bare `bash` that only
 * resolves through `PATH` can resolve to something else by the time the tool runs. Rooting
 * the path and requiring a `bash` executable name is refused here rather than handed over
 * as a value that may be reinterpreted — and then, silently, not be Git Bash.
 *
 * @returns true when the value will be used unchanged as the interpreter.
 */
export function kiloShellSelectionAccepts(shell: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return true
  if (!isAbsolute(shell)) return false
  return /^bash(?:\.exe)?$/i.test(basename(shell))
}

export interface KiloShellBinding {
  /**
   * Root config fragment carrying the verified shell, to merge into the CLI config.
   * Empty on POSIX hosts, where the bash tool's own default is already a POSIX shell.
   */
  readonly config: Readonly<Partial<Record<typeof KILO_SHELL_CONFIG_KEY, string>>>
  /** Environment overrides for the child process. */
  readonly env: NodeJS.ProcessEnv
  /** The runtime identifier the verified executable reported, for diagnostics only. */
  readonly uname: string
}

/**
 * Resolve, execute, and describe the one shell binding the pinned CLI actually honours.
 *
 * POSIX hosts keep their own default shell and inject nothing: the Windows fall-through
 * this guards against does not exist there, and overriding a POSIX host's shell would be
 * an unrequested change to the user's environment.
 *
 * @throws when Git Bash is missing, unusable, or unusable as a configured shell value.
 */
export async function kiloShellBinding(
  env: NodeJS.ProcessEnv,
  options: KiloShellOptions = {},
): Promise<KiloShellBinding> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32')
    return { config: {}, env, uname: platform === 'darwin' ? '/bin/zsh' : '/bin/sh' }
  let shell: string
  try {
    shell = (options.resolve ?? (() => resolveGitBashPath()))()
  } catch (cause) {
    throw missingShell(cause instanceof Error ? cause.message : '未找到 Git Bash')
  }
  if (!kiloShellSelectionAccepts(shell, platform))
    throw missingShell(`所选路径不是 Kilo 会直接采用的 bash.exe：${shell}`)
  const uname = await (options.probe ?? ((target, source) => verifyKiloGitBash(target, source)))(
    shell,
    env,
  )
  if (!uname) throw missingShell('未获得 shell 运行时标识')
  return {
    config: { [KILO_SHELL_CONFIG_KEY]: shell },
    env: { ...env, [KILO_SHELL_VARIABLE]: shell, [KILO_GIT_BASH_VARIABLE]: shell },
    uname,
  }
}

/**
 * Merge the verified shell into a serialised CLI configuration document.
 *
 * The document is produced by this suite in `buildKiloRouteConfig`, so parsing and
 * re-serialising it here cannot lose or reorder the owner's route. The `shell` key is a root
 * key, exactly where the bash tool reads it, and it is written last so a provider entry can
 * never shadow it.
 *
 * @throws when the document is not the JSON this suite produced.
 */
export function withKiloShell(content: string, binding: KiloShellBinding): string {
  let document: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('not an object')
    document = parsed as Record<string, unknown>
  } catch {
    throw new HarnessConfigurationError('模型来源的 Kilo 配置无法解析，已停止，未启动 Kilo。')
  }
  if (Object.keys(binding.config).length === 0) return content
  return JSON.stringify({ ...document, ...binding.config })
}

/**
 * Compare two Windows paths the way the shell selector does, so a drive-letter or
 * separator difference never turns a correct shell into a false mismatch.
 */
export function sameShellFile(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
}
