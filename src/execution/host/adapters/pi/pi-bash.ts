/**
 * Windows shell wiring for the official Pi Coding Agent CLI.
 *
 * **Which official interface selects the shell, and for whom.** Pi resolves its shell in
 * one place, and the official Windows documentation states the consequence directly: with
 * a native Windows process and no `powershell` tool, that one shell serves both the
 * built-in model-facing `bash` tool *and* the user's `!` / `!!` commands
 * (`docs/windows.md`: "Git Bash for the built-in `bash` tool and `!` commands"). The
 * resolution order is `shellPath` from the agent directory's `settings.json`, then Git
 * Bash under Program Files, then `bash.exe` on `PATH`. This module pins the *first* of
 * those, so the verified bash is the only shell either surface can reach — the two are
 * not configured separately and cannot drift apart.
 *
 * That single-selection claim is the reason this module writes the value rather than
 * merely exporting it: `piShellEnvironment` returns the one path that is written into
 * `settings.json`, and `./pi-bridge.ts` writes that exact string, so the model tool and
 * the `!` path provably resolve to the same executable.
 *
 * **Why the path is verified by execution rather than by the variable.** The suite's own
 * provider (`src/shell/host/git-bash.ts`) only checks that a configured path is absolute
 * and exists, which `powershell.exe` satisfies. Setting `shellPath` is not evidence. This
 * module runs the candidate and only accepts a real MINGW/MSYS bash, which rejects a
 * `OPL_GIT_BASH_PATH` pointing at PowerShell, at CMD, and at the WSL entry point in
 * `System32` — none of which the official product accepts either.
 *
 * **Shell and permission are separate concerns.** Nothing here reads or widens a permission
 * tier, and `pi-permissions.ts` never chooses a shell.
 */
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import { resolveGitBashPath } from '../../../../shell/host/git-bash.ts'
import { HarnessConfigurationError } from '../../acp.ts'

const exec = promisify(execFile)

/** Marker the probe prints; proves the answering shell really is Git-for-Windows bash. */
const PROBE_PREFIX = 'OPL_PI_BASH:'

/**
 * The `settings.json` key the official runtime reads for an explicit shell.
 *
 * Kept named so the bridge and the adapter agree on one spelling and the value is written
 * to exactly one place — which is what makes the model `bash` tool and the user's `!`
 * commands share one selection rather than two.
 */
export const PI_SHELL_PATH_ENV = 'PI_SHELL_PATH'

export interface PiShell {
  /** Absolute path to the verified bash, or `undefined` on POSIX hosts. */
  readonly shell?: string
  /** Environment overrides the launch must carry. */
  readonly env: NodeJS.ProcessEnv
}

const fileExists = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Reject an obviously wrong candidate before spawning it, so the failure names the real
 * problem instead of a generic spawn error.
 *
 * @param path - candidate absolute executable path.
 * @returns a diagnostic reason, or `undefined` when the candidate is plausible.
 */
export function piShellCandidateProblem(path: string): string | undefined {
  if (!win32.isAbsolute(path)) return `${path} 必须是绝对 Windows 路径`
  const normalized = path.toLowerCase()
  // `win32.basename` so a forward-slash path is split correctly; a manual backslash scan
  // would return the whole string as the "name" and reject every POSIX-style path.
  const leaf = win32.basename(normalized)
  if (leaf === 'wsl.exe' || (leaf === 'bash.exe' && normalized.includes('\\system32\\')))
    return `${path} 是 WSL 入口；官方 Pi 在 Windows 上只使用 Git for Windows Bash`
  if (leaf !== 'bash.exe') return `${path} 必须指向名为 bash.exe 的可执行文件`
  if (!fileExists(path)) return `${path} 不存在`
  return undefined
}

/**
 * Run the candidate and require a real Git-for-Windows bash to answer.
 *
 * This is the only step that distinguishes a genuine MINGW/MSYS bash from an unrelated
 * executable that happens to exist at the configured path — including a file that is named
 * `bash.exe` but is not a shell at all.
 */
async function runShellProbe(shell: string): Promise<string> {
  const { stdout } = await exec(
    shell,
    ['--noprofile', '--norc', '-c', `printf "${PROBE_PREFIX}"; /usr/bin/uname -s`],
    { windowsHide: true, timeout: 5000, maxBuffer: 4096 },
  )
  return stdout.trim()
}

/**
 * Resolve, execute, and pin the Git Bash this harness will run under.
 *
 * On POSIX hosts the official CLI resolves its own shell from `PATH` and this key is not
 * consulted for the same purpose, so nothing is pinned there.
 *
 * @param env - the reduced suite environment for the child process.
 * @param options - platform override and path resolver, for tests.
 * @returns the verified shell plus the environment the launch must carry.
 * @throws HarnessConfigurationError when Git Bash is absent, or when the selected
 * candidate is not a runnable Git-for-Windows bash. There is no PowerShell, CMD, or WSL
 * fallback, and no permission is widened to obtain a shell.
 */
export async function piBashEnvironment(
  env: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; resolve?: () => string } = {},
): Promise<PiShell> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return { env }
  let shell: string
  try {
    shell = (options.resolve ?? (() => resolveGitBashPath()))()
  } catch {
    throw new HarnessConfigurationError(
      '本机没有找到 Git for Windows Bash。官方 Pi 在 Windows 上只使用 Git Bash，不会回退到 PowerShell；' +
        '请安装 Git for Windows 或将 OPL_GIT_BASH_PATH 指向可运行的 bash.exe。未启动 pi，未发送任务。',
    )
  }
  const problem = piShellCandidateProblem(shell)
  if (problem)
    throw new HarnessConfigurationError(
      `Pi 无法使用所选 Git Bash：${problem}。不会静默回退到其他 shell。未启动 pi，未发送任务。`,
    )
  try {
    const stdout = await runShellProbe(shell)
    if (!new RegExp(`^${PROBE_PREFIX}(?:MINGW(?:32|64)|MSYS)_NT-`).test(stdout))
      throw Error('Unexpected shell')
  } catch {
    throw new HarnessConfigurationError(
      `Git Bash 启动验证失败：${shell}。官方 Pi 在 Windows 上只使用 Git Bash，不会回退到 PowerShell 或 WSL；` +
        '已停止，未启动 pi，未发送任务。',
    )
  }
  return { shell, env: { ...env, [PI_SHELL_PATH_ENV]: shell, SHELL: shell } }
}
