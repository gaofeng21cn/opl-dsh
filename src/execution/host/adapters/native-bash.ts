/**
 * Windows Git Bash wiring for the official Codex and Claude Code harnesses.
 *
 * This module only selects and validates a Bash executable and exports it through a
 * harness' own supported variable. The Bash tool stays the harness' own tool: nothing here
 * proxies a harness call to a local shell service, and no task is made to look successful by
 * only setting `SHELL`.
 *
 * Two very different support levels, kept strictly apart:
 *
 * - Claude Code 2.1.292 — `CLAUDE_CODE_GIT_BASH_PATH` is a real Claude Code interface. The
 *   installed binary reads it, requires the basename to be a bash/sh binary that exists, sets
 *   `process.env.SHELL` itself, and otherwise only warns and falls back to auto-detection.
 *   Verified on this machine by driving the real CLI and observing its own Bash tool output.
 *
 * - Codex — upstream Codex has **no** documented way to choose a Bash executable. The official
 *   config reference (developers.openai.com/codex/config-reference) exposes `sandbox_mode`,
 *   `windows.sandbox`, `allow_login_shell` and `shell_environment_policy`, and nothing that
 *   names a shell binary; upstream issues #3159 and #7298 treat choosing one as a feature
 *   request. The `CODEX_NATIVE_GIT_BASH_PATH` found on this machine belongs to a local patch
 *   build stored under a `repair-<date>/isolation/gitbash-<version>` tree, so it is **not** an official
 *   release capability here. It is therefore opt-in only, and the caller must confirm the real
 *   shell with {@link codexShellProbeCommand} before claiming the task is running under Bash.
 *
 * Kept free of runtime imports so the standalone bridge bundle stays self-contained.
 */
import { statSync } from 'node:fs'
import { basename, delimiter, join, win32 } from 'node:path'

/** Permission profiles the suite can authorize for a native harness task. */
export type NativePermission = 'read-only' | 'workspace' | 'full-access'

/** Codex sandbox modes from the official app-server v2 `SandboxMode` enum. */
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** The official native harness identity a session was launched with. */
export type NativeHarnessKind = 'codex' | 'claude'

export interface NativeBashOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
  /**
   * A Git Bash path already resolved by the Host, which sees the full environment. The
   * bridge child only receives the reduced suite environment, so the Host resolves once and
   * hands the result down rather than letting the child search a narrower PATH.
   */
  bash?: string
}

const fileExists = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Windows locations checked before PATH, matching the suite's Git Bash provider so the
 * native harnesses and the local shell never disagree about which bash is in use.
 * @param env - environment values used to build the installation roots.
 * @returns candidate executable paths in preference order.
 */
export function gitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(
    (value): value is string => Boolean(value),
  )
  return roots.flatMap((root) => [
    join(root, 'Git', 'bin', 'bash.exe'),
    join(root, 'Git', 'usr', 'bin', 'bash.exe'),
  ])
}

/**
 * Resolve the Git for Windows Bash used by the native harnesses.
 *
 * An explicit `OPL_GIT_BASH_PATH` is honored or rejected outright: a configured path that is
 * not an existing absolute file is an error rather than a silent fallback, because both
 * harnesses would otherwise quietly substitute a different shell.
 * @param options - platform, environment, and filesystem probe overrides.
 * @returns the executable path, or `undefined` when no Git Bash is installed.
 * @throws when `OPL_GIT_BASH_PATH` is set but unusable.
 */
export function resolveNativeGitBash(options: NativeBashOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return undefined
  if (options.bash) return options.bash
  const env = options.env ?? process.env
  const exists = options.exists ?? fileExists
  if (env.OPL_GIT_BASH_PATH !== undefined) {
    const explicit = env.OPL_GIT_BASH_PATH
    if (!win32.isAbsolute(explicit) || !exists(explicit))
      throw new Error(
        'OPL_GIT_BASH_PATH must name an existing absolute bash.exe; no fallback was used.',
      )
    return explicit
  }
  const candidates = [
    ...gitBashCandidates(env),
    ...(env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, 'bash.exe')),
  ]
  return [...new Set(candidates)].find((candidate) => exists(candidate))
}

/** Directory prefixes the local Codex patch build treats as a WSL entry point. */
const WSL_DIRECTORY_MARKERS = ['\\windows\\system32', '\\windows\\sysnative']

/**
 * Apply the local Codex patch build's rules for `CODEX_NATIVE_GIT_BASH_PATH`.
 *
 * These are that build's rules, not upstream Codex configuration. They are checked before
 * injection so an unusable path is reported with a reason instead of aborting a thread later
 * with a raw harness error.
 * @param path - candidate absolute bash path.
 * @param options - filesystem probe overrides.
 * @returns a diagnostic reason, or `undefined` when the path would be accepted.
 */
export function codexGitBashProblem(
  path: string,
  options: NativeBashOptions = {},
): string | undefined {
  const exists = options.exists ?? fileExists
  if (!win32.isAbsolute(path) || /^[\\/]/.test(path))
    return `${path} 必须是绝对 Windows 路径，例如 C:\\Program Files\\Git\\bin\\bash.exe`
  const normalized = path.toLowerCase()
  const leaf = normalized.slice(normalized.lastIndexOf('\\') + 1)
  if (
    leaf === 'wsl.exe' ||
    (leaf === 'bash.exe' && WSL_DIRECTORY_MARKERS.some((m) => normalized.includes(m)))
  )
    return `${path} 是 WSL 入口；该 Codex 补丁构建要求 Git for Windows Bash`
  if (leaf !== 'bash.exe') return `${path} 必须指向名为 bash.exe 的可执行文件`
  if (!exists(path)) return `${path} 不存在`
  // The build requires the Git for Windows layout marker, at the installation root for both
  // the `bin` and the `usr\bin` layouts.
  let root = win32.dirname(path)
  while (root.length > 1) {
    if (exists(join(root, 'cmd', 'git.exe'))) return undefined
    const parent = win32.dirname(root)
    if (parent === root) break
    root = parent
  }
  return `${path} 不属于完整的 Git for Windows 安装（缺少 cmd\\git.exe）`
}

/**
 * Apply Claude Code's own rules for `CLAUDE_CODE_GIT_BASH_PATH`.
 *
 * Claude Code only warns and falls back to auto-detection when the value is unusable, which
 * would leave the task running on a shell the user did not choose.
 * @param path - candidate absolute bash path.
 * @param options - filesystem probe overrides.
 * @returns a diagnostic reason, or `undefined` when Claude Code will accept the path.
 */
export function claudeGitBashProblem(
  path: string,
  options: NativeBashOptions = {},
): string | undefined {
  const exists = options.exists ?? fileExists
  if (!['bash.exe', 'sh.exe', 'bash', 'sh'].includes(basename(path).toLowerCase()))
    return `${path} 不是 bash/sh 可执行文件`
  if (!exists(path)) return `${path} 不存在`
  return undefined
}

/**
 * Translate an authorized permission into the Codex sandbox mode.
 *
 * Matches the suite's official preset mapping (`src/execution/host/permissions.ts`).
 * @param permission - authorized permission profile.
 * @returns the Codex sandbox mode for the thread.
 */
export function codexSandboxMode(permission: NativePermission): CodexSandboxMode {
  switch (permission) {
    case 'full-access':
      return 'danger-full-access'
    case 'workspace':
      return 'workspace-write'
    case 'read-only':
      return 'read-only'
  }
}

/**
 * Whether the local Codex patch build accepts a Git Bash path under this profile.
 *
 * That build refuses to start a thread when the path is set under a restricted profile, so
 * the variable must stay unset rather than be set and left to fail.
 * @param permission - authorized permission profile.
 * @returns true only for `full-access`.
 */
export function codexAllowsGitBash(permission: NativePermission): boolean {
  return permission === 'full-access'
}

/**
 * Whether the caller opted into the non-upstream Codex Git Bash variable.
 *
 * Off by default: an unmodified official Codex build does not document this interface, so
 * injecting it unconditionally would both misdescribe the product and do nothing useful.
 * @param env - environment to read the opt-in from.
 * @returns true only when `OPL_NATIVE_CODEX_GIT_BASH=1` is set.
 */
export function codexGitBashOptIn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPL_NATIVE_CODEX_GIT_BASH === '1'
}

/**
 * Build the environment patch that puts a harness' own Bash tool on Git Bash.
 *
 * Returns an empty patch on POSIX hosts and whenever no Git Bash is installed *and nothing was
 * requested*, so macOS and Linux keep the official behaviour and a machine without Git for
 * Windows is not blocked. An explicit request is never silently dropped: a requested Git Bash
 * that cannot be honoured fails here, before any model call, and never by widening the task's
 * permissions.
 * @param kind - official native harness identity.
 * @param permission - authorized permission profile.
 * @param options - platform, environment, and filesystem probe overrides.
 * @returns environment variables to merge into the harness child process.
 * @throws when an explicitly requested Git Bash cannot be applied.
 */
export function nativeGitBashEnv(
  kind: NativeHarnessKind,
  permission: NativePermission,
  options: NativeBashOptions = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return {}
  const env = options.env ?? process.env
  if (kind === 'codex') {
    // Not an upstream Codex interface, so it is never applied unless explicitly requested.
    if (!codexGitBashOptIn(env)) return {}
    if (!codexAllowsGitBash(permission))
      throw new Error(
        `已显式请求 Codex 使用 Git Bash，但当前任务权限为 ${permission}。` +
          '该 Codex 构建只在 danger-full-access 下接受 Git Bash，且本套件不会为 Bash 扩大受限任务的权限。',
      )
    const bash = resolveNativeGitBash({ ...options, env })
    if (!bash)
      throw new Error(
        '已显式请求 Codex 使用 Git Bash，但本机没有找到可用的 Git for Windows Bash；不会静默回退到其他 shell。',
      )
    const problem = codexGitBashProblem(bash, options)
    if (problem) throw new Error(`Codex 无法使用 Git Bash：${problem}`)
    return { CODEX_NATIVE_GIT_BASH_PATH: bash }
  }
  const explicit = env.OPL_GIT_BASH_PATH !== undefined
  const bash = resolveNativeGitBash({ ...options, env })
  if (!bash) {
    if (explicit)
      throw new Error('已显式指定 Git Bash 路径，但该路径不可用；不会静默回退到其他 shell。')
    return {}
  }
  const problem = claudeGitBashProblem(bash, options)
  if (problem) throw new Error(`Claude Code 无法使用 Git Bash：${problem}`)
  return { CLAUDE_CODE_GIT_BASH_PATH: bash }
}

/**
 * A side-effect-free command that prints which shell is really executing it.
 *
 * Run through Codex's own `thread/shellCommand`, this needs no model call and no credentials,
 * so the bridge can confirm the real shell before any model request instead of assuming the
 * requested Bash path took effect.
 * @returns a command whose output identifies the executing shell.
 */
export function codexShellProbeCommand(): string {
  return 'echo "OPL_SHELL_NAME=$0"; echo "OPL_SHELL_BASH_VERSION=${BASH_VERSION:-none}"'
}

/**
 * Read the shell identity out of {@link codexShellProbeCommand} output.
 * @param output - combined stdout of the probe command.
 * @returns the detected shell, or `undefined` when the output cannot be read.
 */
export function readShellProbe(
  output: string,
): { name?: string; bashVersion?: string } | undefined {
  const name = output.match(/OPL_SHELL_NAME=(\S*)/)?.[1]
  const bashVersion = output.match(/OPL_SHELL_BASH_VERSION=(\S*)/)?.[1]
  if (name === undefined && bashVersion === undefined) return undefined
  return name === undefined || bashVersion === undefined
    ? {
        ...(name === undefined ? {} : { name }),
        ...(bashVersion === undefined ? {} : { bashVersion }),
      }
    : { name, bashVersion }
}
