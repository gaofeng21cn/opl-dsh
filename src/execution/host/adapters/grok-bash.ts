/**
 * Windows tool-shell selection for the official Grok Build CLI.
 *
 * Evidence, all taken from the installed Grok Build 1.0.46 (`grok --version`
 * reports `grok 1.0.46 (2765805b9442)`, binary `~/.grok/bin/grok.exe`):
 *
 *  - The CLI reads `GROK_SHELL` in `xai_grok_config::shell`
 *    (`crates/codegen/xai-grok-config/src/shell.rs`, tracing events at lines
 *    34, 38, 43, 49, 54, 58, 77, 86, 92 and 96).
 *  - Accepted values are `bash`, `pwsh`, `powershell` and `cmd`; anything else
 *    logs `<value> is not recognized (expected pwsh|powershell|bash|cmd);
 *    falling through to auto-detect` and is ignored.
 *  - `bash` selects Git Bash, and the CLI reports it as
 *    `Windows shell (GROK_SHELL override): Git Bash`. When Git Bash is absent
 *    it logs `GROK_SHELL=bash but Git Bash not found; falling through to
 *    auto-detect` and continues on the auto-detected shell.
 *  - On Windows the auto-detect order is `pwsh`, then
 *    `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, then Git
 *    Bash, then `powershell.exe` as a last resort. PowerShell is therefore
 *    chosen even on a machine that has Git for Windows installed, which is the
 *    behaviour this module exists to correct.
 *  - Git Bash is a first-class backend rather than a naming convention: the CLI
 *    exports `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8:surrogateescape`,
 *    `MSYS_NO_PATHCONV` and `MSYS2_ARG_CONV_EXCL=*&&;` when it runs it.
 *  - `shell` is not a `config.toml` key. The official configuration reference
 *    (`~/.grok/docs/user-guide/26-config-reference.md`) documents only
 *    `[shell_environment_policy]`, which filters environment variables and does
 *    not choose an executable, and a `shell = ...` entry in `config.toml` is
 *    silently ignored. `GROK_SHELL` is therefore the only supported control,
 *    which also keeps the suite-owned `config.toml` byte-stable across upgrades.
 *
 * Two consequences shape this module. The override accepts a shell *name*, not
 * a path, so the executable is chosen by the CLI's own discovery and cannot be
 * pinned to an arbitrary location. And both failure paths — an unknown value and
 * `bash` without Git Bash — fall back silently instead of failing, so this
 * module has to prove the CLI will really find Git Bash before it starts.
 */
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import { resolveGitBashPath } from '../../../shell/host/git-bash.ts'
import { HarnessConfigurationError } from '../acp.ts'

const exec = promisify(execFile)

/** The variable the official CLI reads to choose its tool shell. */
export const GROK_SHELL_VARIABLE = 'GROK_SHELL'
/** The only accepted value that selects Git Bash instead of a PowerShell. */
export const GROK_GIT_BASH = 'bash'

/**
 * Installation roots the official CLI consults before it gives up on Git Bash.
 * It appends `\Git\bin\bash.exe` and `\Programs\Git\bin\bash.exe` to each of
 * `ProgramFiles`, `ProgramFiles(x86)` and `LOCALAPPDATA`, and never scans `PATH`.
 * @param env - environment handed to the CLI process.
 * @returns the Git Bash locations the CLI itself would consider, in its order.
 */
export function grokGitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(
    (value): value is string => Boolean(value),
  )
  return roots.flatMap((root) => [
    win32.join(root, 'Git', 'bin', 'bash.exe'),
    win32.join(root, 'Programs', 'Git', 'bin', 'bash.exe'),
  ])
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The executable the official CLI would actually run: the first candidate that
 * exists, in the CLI's own order.
 *
 * Finding a matching installation *somewhere* in the list is not enough. The CLI
 * stops at the first hit, so when an earlier candidate belongs to a different
 * Git installation that is the one it runs — and the suite must refuse rather
 * than assume it got the one it resolved.
 * @param env - environment handed to the CLI process.
 * @param exists - filesystem probe, overridable for tests.
 * @returns the path the CLI would select, or `undefined` when it sees no Git Bash.
 */
export function grokGitBashSelection(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = isFile,
): string | undefined {
  return grokGitBashCandidates(env).find(exists)
}

/**
 * Decide whether the CLI and the suite agree on the Git Bash to run.
 * @param env - environment handed to the CLI process.
 * @param installation - installation root the suite resolved.
 * @param exists - filesystem probe, overridable for tests.
 * @returns the CLI's own selection and whether it contradicts the suite's.
 */
export function grokBashSelection(
  env: NodeJS.ProcessEnv,
  installation: string,
  exists: (path: string) => boolean = isFile,
): { selected: string | undefined; mismatch: boolean } {
  const selected = grokGitBashSelection(env, exists)
  return {
    selected,
    mismatch: selected !== undefined && gitInstallationRoot(selected) !== installation,
  }
}

/**
 * Program Files root an installation sits directly under, when it really is one.
 * A Git Bash shell erases `ProgramFiles` before handing the environment to child
 * processes, which leaves the CLI without the root it would look under, so the
 * root is rebuilt from the installation and only accepted once the directory
 * carries the `Common Files` marker every real Program Files directory has. A
 * Git installed anywhere else yields no root and no override.
 */
const programFilesFor = (installation: string): string | undefined => {
  const suffix = '\\git'
  if (!installation.endsWith(suffix)) return undefined
  const root = installation.slice(0, -suffix.length)
  return isDirectory(win32.join(root, 'Common Files')) ? root : undefined
}

/**
 * Root of the Git for Windows installation a `bash.exe` belongs to.
 *
 * The suite resolver and the CLI can land on different executables of the very
 * same installation — `<root>\Git\usr\bin\bash.exe` against
 * `<root>\Git\bin\bash.exe` — so the installation, not the exact file, is what
 * decides whether both agree on the backend.
 * @param path - a `bash.exe` path.
 * @returns the installation root, or the path itself when it is not a Git Bash.
 */
export function gitInstallationRoot(path: string): string {
  const normalized = win32
    .normalize(path)
    .toLowerCase()
    .replace(/[\\/]+$/u, '')
  for (const suffix of ['\\usr\\bin\\bash.exe', '\\bin\\bash.exe'])
    if (normalized.endsWith(suffix)) return normalized.slice(0, -suffix.length)
  return normalized
}

/**
 * The suite environment allowlist carries no `ProgramFiles`, but the CLI needs
 * those roots to locate Git Bash, so they are restored from the ambient process
 * without loosening anything else the allowlist decides.
 */
const withDiscoveryRoots = (
  env: NodeJS.ProcessEnv,
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const restored: NodeJS.ProcessEnv = { ...env }
  for (const name of ['ProgramFiles', 'ProgramFiles(x86)'])
    if (!restored[name] && ambient[name]) restored[name] = ambient[name]
  return restored
}

/**
 * Resolve the Git Bash the official CLI will actually run, prove it starts as an
 * MSYS shell, and export the official override. POSIX hosts keep the CLI's own
 * platform default, so macOS and Linux behaviour is unchanged.
 *
 * Nothing here bypasses a sandbox or an approval: the caller keeps its own
 * `--sandbox` and `--permission-mode` arguments, and this only decides which
 * executable the agent runs its commands with.
 * @param env - the environment the suite built for the CLI process.
 * @returns the same environment with the shell backend pinned.
 * @throws HarnessConfigurationError when Git Bash cannot be resolved, is not
 * reachable through the CLI's own discovery, or does not run as an MSYS shell.
 * The CLI is never started in that case, and PowerShell, CMD and WSL are never
 * substituted for the requested backend.
 */
export async function grokBashEnvironment(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== 'win32') return env
  const restored = withDiscoveryRoots(env)
  let shell: string
  try {
    shell = resolveGitBashPath()
  } catch (error) {
    throw new HarnessConfigurationError(
      `Grok Git Bash 后端无法解析：${error instanceof Error ? error.message : String(error)}。请安装 Git for Windows，或将 OPL_GIT_BASH_PATH 指向一个存在的绝对路径 bash.exe；未启动 Grok，未回退 PowerShell、CMD 或 WSL。`,
    )
  }
  const installation = gitInstallationRoot(shell)
  let selected = grokGitBashSelection(restored, isFile)
  if (!selected) {
    // The CLI can see no Git Bash at all. Rebuilding the Program Files root is
    // the only case where the suite may add one, and only from the installation
    // that was actually resolved.
    const root = programFilesFor(installation)
    if (root) {
      restored.ProgramFiles = root
      selected = grokGitBashSelection(restored, isFile)
    }
  }
  if (!selected)
    throw new HarnessConfigurationError(
      `Grok 无法在官方位置找到所选 Git Bash：安装目录 ${installation}（${shell}），而官方 1.0.46 只在 ProgramFiles、ProgramFiles(x86)、LOCALAPPDATA 下的 Git\\bin\\bash.exe 与 Programs\\Git\\bin\\bash.exe 中按顺序查找，不读取 SHELL 也不扫描 PATH。请把 Git for Windows 安装到上述默认位置；未启动 Grok，未回退 PowerShell、CMD 或 WSL。`,
    )
  if (grokBashSelection(restored, installation, isFile).mismatch)
    throw new HarnessConfigurationError(
      `Grok 会运行的不是所选 Git Bash：官方按顺序命中的第一个是 ${selected}（${gitInstallationRoot(selected)}），而套件解析到的是 ${shell}（${installation}）。存在优先级更高的另一套 Git 安装，套件不会声称选对；请卸载或调整优先级更高的一套，或用 OPL_GIT_BASH_PATH 指向官方会命中的那套。未启动 Grok，未回退 PowerShell、CMD 或 WSL。`,
    )
  try {
    const { stdout } = await exec(
      shell,
      ['--noprofile', '--norc', '-c', 'printf "OPL_GROK_BASH:"; /usr/bin/uname -s'],
      { env: restored, windowsHide: true, timeout: 5000, maxBuffer: 4096 },
    )
    if (!/^OPL_GROK_BASH:(?:MINGW(?:32|64)|MSYS)_NT-/.test(stdout.trim()))
      throw Error('Unexpected shell')
  } catch {
    throw new HarnessConfigurationError(
      `Grok Git Bash 启动验证失败（${shell}）。请确认 Git for Windows 安装完整且 bash.exe 可执行；未启动 Grok，未回退 PowerShell、CMD 或 WSL。`,
    )
  }
  return { ...restored, [GROK_SHELL_VARIABLE]: GROK_GIT_BASH, SHELL: shell }
}
