/**
 * Windows shell wiring for the official Kimi Code CLI.
 *
 * `kimi-code` picks its tool shell in `locateWindowsGitBash()`, which reads
 * `KIMI_SHELL_PATH` and on Windows only ever returns a Git-for-Windows bash, raising
 * `ProbeShellNotFoundError` rather than degrading. `KIMI_CLI_GIT_BASH_PATH` belongs to the
 * archived Python `MoonshotAI/kimi-cli` and is never set here.
 *
 * An unusable `KIMI_SHELL_PATH` does not make the CLI fail: it records the candidate and
 * keeps auto-detecting, so a bad value silently yields a different bash than the one this
 * suite verified. The candidate is therefore executed here, which also rejects an
 * `OPL_GIT_BASH_PATH` pointing at `powershell.exe` — the suite provider only checks that
 * the path is absolute and exists — and at the WSL entry point.
 *
 * ACP advertises no shell readback, so this claims only that the child receives a verified
 * Git-for-Windows bash and that the official CLI cannot use anything else on Windows.
 */
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import { resolveGitBashPath } from '../../../../shell/host/git-bash.ts'
import { HarnessConfigurationError } from '../../acp.ts'
import type { AcpSessionSnapshot } from '../types.ts'

const exec = promisify(execFile)

/** The variable `kimi-code` actually reads to choose its Windows tool shell. */
export const KIMI_SHELL_PATH_ENV = 'KIMI_SHELL_PATH'
/** The archived Python CLI's variable, kept named so it is never set by mistake. */
export const KIMI_LEGACY_GIT_BASH_ENV = 'KIMI_CLI_GIT_BASH_PATH'

/** Lowest `kimi-code` release whose ACP server ships in the published binary. */
export const KIMI_MIN_VERSION = '2.0.0'
/** CLI version whose `kimi acp` surface this adapter was written against. */
export const KIMI_VERIFIED_VERSION = '2.1.1'

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
 * @param path - candidate absolute executable path.
 * @returns a diagnostic reason, or `undefined` when the candidate is plausible.
 */
export function kimiShellCandidateProblem(path: string): string | undefined {
  if (!win32.isAbsolute(path)) return `${path} 必须是绝对 Windows 路径`
  const normalized = path.toLowerCase()
  const leaf = normalized.slice(normalized.lastIndexOf('\\') + 1)
  if (leaf === 'wsl.exe' || (leaf === 'bash.exe' && normalized.includes('\\system32\\')))
    return `${path} 是 WSL 入口；官方 Kimi Code 在 Windows 上只使用 Git for Windows Bash`
  if (leaf !== 'bash.exe') return `${path} 必须指向名为 bash.exe 的可执行文件`
  if (!fileExists(path)) return `${path} 不存在`
  return undefined
}

/**
 * Run the candidate and require a real Git-for-Windows bash to answer. Executing it is the
 * only step that distinguishes a genuine MINGW/MSYS bash from an unrelated executable that
 * happens to exist at the configured path.
 */
async function runShellProbe(shell: string): Promise<string> {
  const { stdout } = await exec(
    shell,
    ['--noprofile', '--norc', '-c', 'printf "OPL_KIMI_BASH:"; /usr/bin/uname -s'],
    { windowsHide: true, timeout: 5000, maxBuffer: 4096 },
  )
  return stdout.trim()
}

/**
 * Resolve, execute, and pin the Git Bash this harness will run under.
 *
 * On POSIX the CLI resolves `/bin/bash` itself and never reads `KIMI_SHELL_PATH`, so
 * nothing is injected there. On Windows the value is always set explicitly, overriding any
 * inherited one.
 *
 * @throws HarnessConfigurationError when Git Bash is absent or the candidate is not a
 * runnable Git-for-Windows bash. No PowerShell, CMD, or WSL fallback.
 */
export async function kimiBashEnvironment(
  env: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; resolve?: () => string } = {},
): Promise<NodeJS.ProcessEnv> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return env
  let shell: string
  try {
    shell = (options.resolve ?? (() => resolveGitBashPath()))()
  } catch {
    throw new HarnessConfigurationError(
      '本机没有找到 Git for Windows Bash。官方 Kimi Code 在 Windows 上只使用 Git Bash，不会回退到 PowerShell；' +
        '请安装 Git for Windows 或将 OPL_GIT_BASH_PATH 指向可运行的 bash.exe。未启动 kimi，未发送任务。',
    )
  }
  const problem = kimiShellCandidateProblem(shell)
  if (problem)
    throw new HarnessConfigurationError(
      `Kimi Code 无法使用所选 Git Bash：${problem}。不会静默回退到其他 shell。未启动 kimi，未发送任务。`,
    )
  try {
    const stdout = await runShellProbe(shell)
    if (!/^OPL_KIMI_BASH:(?:MINGW(?:32|64)|MSYS)_NT-/.test(stdout)) throw Error('Unexpected shell')
  } catch {
    throw new HarnessConfigurationError(
      `Git Bash 启动验证失败：${shell}。官方 Kimi Code 在 Windows 上只使用 Git Bash，不会回退到 PowerShell 或 WSL；` +
        '已停止，未启动 kimi，未发送任务。',
    )
  }
  return { ...env, [KIMI_SHELL_PATH_ENV]: shell, SHELL: shell }
}

/**
 * Fail closed when the running agent is older than the ACP surface this adapter pins.
 *
 * The pinned model and mode are written with the v1 config-option methods that ship
 * with the 2.x ACP server; an older or unrecognised binary is refused rather than
 * probed field by field. The agent's reported version string is used only after it
 * matches a strict numeric shape, so a hostile or malformed value cannot reach the
 * comparison.
 *
 * @param snapshot - the session snapshot carrying the `initialize` result.
 * @throws HarnessConfigurationError when no usable version can be read or it is below
 * {@link KIMI_MIN_VERSION}.
 */
export function assertKimiAcpVersion(snapshot: AcpSessionSnapshot): string {
  const info = snapshot.agent?.agentInfo
  const reported = info && typeof info === 'object' ? (info as Record<string, any>).version : ''
  if (typeof reported !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(reported))
    throw new HarnessConfigurationError(
      '官方 Kimi Code 未报告可识别的版本号，无法确认 ACP 接口已实现；已停止，未发送任务。',
    )
  const parse = (value: string): number[] =>
    value
      .split(/[-+]/, 1)[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10))
  const [major = 0, minor = 0, patch = 0] = parse(reported)
  const [minMajor = 0, minMinor = 0, minPatch = 0] = parse(KIMI_MIN_VERSION)
  const below =
    major < minMajor ||
    (major === minMajor && (minor < minMinor || (minor === minMinor && patch < minPatch)))
  if (below)
    throw new HarnessConfigurationError(
      `官方 Kimi Code ${reported} 低于本适配器所需的 ${KIMI_MIN_VERSION}；已停止，未发送任务，不会回退到其他模型或 Harness。`,
    )
  return reported
}
