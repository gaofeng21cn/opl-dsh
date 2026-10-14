/**
 * Interpreter pin for the official Poolside Agent CLI shell tool.
 *
 * The official shell tool chooses its interpreter per call: `ShellRunArgs`
 * carries `shell`, `shell_args`, `shell_id`, `mode`, `cwd` and `env`, and the
 * `shell` field is documented as "'bash', 'pwsh', or 'powershell' (defaults to
 * system default). Can be a full path to a binary". There is no `pool.shell`,
 * `default_shell` or `shell_path` setting, and the 1.0.16 binary carries no
 * environment variable for one either, so the interpreter is only ever decided
 * by whoever supplies that field. Letting the model supply it, or letting the
 * host's `SHELL`/`PATH` supply it, would make the suite's shell contract depend
 * on the conversation and on the user's environment.
 *
 * The measured consequences on this host, all against the official 1.0.16
 * Windows package, with `SHELL` pointed at PowerShell and every Git/Bash
 * directory removed from `PATH`:
 *
 * - Without the pin, the shell tool ran PowerShell.
 * - With the `--settings` `PreToolUse` pin, the same call ran Git Bash 5.3.15
 *   (`MINGW64_NT-10.0-26300`), executed real `git version 2.55.0.windows.3`,
 *   and wrote and read back a `中文 空格.txt` file in a `workspace 中文 空格`
 *   working directory.
 * - With the pin pointing at a path that does not exist, the tool call failed
 *   with the hook's own message and no other interpreter ran.
 * - A project-level `PreToolUse` hook that set the shell back to PowerShell ran
 *   first; the `--settings` hook then rewrote it, and Git Bash executed.
 * - While the hook blocked the call, the CLI emitted no `session/request_permission`
 *   at all, so the pin is in force before any human approval is requested.
 *
 * Hooks fail open by official design ("Hooks fail open and are not a security
 * boundary"), so the pin is not trusted on the CLI's word: every launch runs
 * this exact hook the way the CLI runs it and refuses to start when it does not
 * return the pinned decision.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveGitBashPath } from '../../../../shell/host/git-bash.ts'
import { HarnessConfigurationError } from '../../acp.ts'
import {
  POOL_GIT_BASH_ARGS,
  POOL_HOOK_COMMAND_NAME,
  POOL_HOOK_FILE,
  POOL_NODE_ENV,
  POOL_SETTINGS_FILE,
  POOL_SHELL_ARGS_VARIABLE,
  POOL_SHELL_AUDIT_VARIABLE,
  POOL_SHELL_VARIABLE,
  poolHookCommand,
  poolSettings,
  poolSettingsLayouts,
  poolShellHookSource,
  poolShellPath,
} from './pool-shell-hook.ts'

const exec = promisify(execFile)

/** Absolute interpreter used on POSIX hosts, where the suite pins one fixed path too. */
export const POOL_POSIX_SHELL = '/bin/bash'

/** Marker the pinned interpreter must print, proving which shell actually ran. */
const PROBE_COMMAND = 'printf "OPL_POOL_BASH:"; /usr/bin/uname -s 2>/dev/null || uname -s'

export interface PoolShellOptions {
  /** Suite-owned harness home for this session. */
  readonly home: string
  /** Overrides for tests. */
  readonly platform?: NodeJS.Platform
  readonly nodePath?: string
  readonly env?: NodeJS.ProcessEnv
}

/** Directory holding the hook program, its launcher, and the settings that registers it. */
export function poolHookDirectory(home: string): string {
  return home
}

/** Settings file passed to the CLI with `--settings`. */
export function poolSettingsPath(home: string): string {
  return join(poolHookDirectory(home), POOL_SETTINGS_FILE)
}

/**
 * Resolve the interpreter this host pins.
 *
 * @param options - platform, environment, and a filesystem probe override.
 * @returns an absolute interpreter path.
 * @throws HarnessConfigurationError when no interpreter exists. The caller is
 * never started in that case and PowerShell, CMD and WSL are never substituted.
 */
export function resolvePoolShell(
  options: {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    exists?: (path: string) => boolean
  } = {},
): string {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return POOL_POSIX_SHELL
  try {
    return resolveGitBashPath({
      platform,
      env: options.env ?? process.env,
      ...(options.exists ? { exists: options.exists } : {}),
    })
  } catch (error) {
    throw new HarnessConfigurationError(
      `pool Git Bash 后端无法解析：${error instanceof Error ? error.message : String(error)}。` +
        '请安装 Git for Windows，或将 OPL_GIT_BASH_PATH 指向一个存在的绝对路径 bash.exe；' +
        '未启动 pool，未回退 PowerShell、CMD 或 WSL。',
    )
  }
}

/**
 * Execute the pinned interpreter and require the shell it actually is.
 *
 * @param shell - the resolved interpreter path.
 * @param env - the environment the CLI process will receive.
 * @param platform - host platform override for tests.
 * @throws HarnessConfigurationError when the path does not run as a POSIX shell.
 */
export async function verifyPoolShell(
  shell: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  try {
    const { stdout } = await exec(shell, [...POOL_GIT_BASH_ARGS, PROBE_COMMAND], {
      env,
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 4096,
    })
    const marker = stdout.trim()
    if (platform === 'win32') {
      if (!/^OPL_POOL_BASH:(?:MINGW(?:32|64)|MSYS)_NT-/u.test(marker))
        throw Error('Unexpected shell')
    } else if (!marker.startsWith('OPL_POOL_BASH:') || marker === 'OPL_POOL_BASH:') {
      throw Error('Unexpected shell')
    }
  } catch {
    throw new HarnessConfigurationError(
      `pool Git Bash 启动验证失败（${shell}）。请确认 Git for Windows 安装完整且 bash.exe 可执行；` +
        '未启动 pool，未回退 PowerShell、CMD 或 WSL。',
    )
  }
}

/** Write a suite-owned file, refusing to overwrite bytes this adapter did not produce. */
async function writeSuiteFile(
  path: string,
  contents: string,
  layouts: readonly string[],
): Promise<void> {
  const existing = await readFile(path, 'utf8').catch(() => undefined)
  if (existing !== undefined && !layouts.includes(existing))
    throw new HarnessConfigurationError(
      `pool 套件目录中的文件被外部修改：${path}。已停止，未覆盖该文件，未静默修复。`,
    )
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 })
}

interface HookRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run the hook exactly the way the official CLI runs it. */
async function runHook(
  platform: NodeJS.Platform,
  command: string,
  env: NodeJS.ProcessEnv,
  home: string,
  stdin: string,
): Promise<HookRun> {
  const payload = JSON.stringify({
    hook_api_version: '1.0',
    hook_event_name: 'PreToolUse',
    event_id: 'opl-pool-preflight',
    session_id: 'opl-pool-preflight',
    tool_name: 'shell',
    tool_input: { cmd: 'printf OPL_POOL_PREFLIGHT', mode: 'foreground' },
    tool_call_id: 'opl-pool-preflight',
  })
  return new Promise<HookRun>((resolve) => {
    const child = spawn(
      platform === 'win32' ? (env.ComSpec ?? env.COMSPEC ?? 'cmd.exe') : '/bin/sh',
      platform === 'win32' ? ['/d', '/c', command] : ['-c', command],
      { env, cwd: home, windowsHide: true },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    const timer = setTimeout(() => child.kill(), 10_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr })
    })
    child.stdin.end(payload)
  })
}

/**
 * Prove the pin is in force before the CLI starts.
 *
 * The official hook service fails open, so a hook that cannot start would leave
 * the model's own interpreter in place. This runs the registered hook through
 * the platform's own command runner with a synthetic `PreToolUse` payload and
 * requires the pinned decision, then runs it once more with a deliberately
 * missing interpreter and requires a block.
 *
 * @throws HarnessConfigurationError when the hook does not behave as pinned.
 */
export async function verifyPoolShellHook(
  home: string,
  shell: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  nodePath: string = process.execPath,
): Promise<void> {
  const command = poolHookCommand(platform, nodePath, join(poolHookDirectory(home), POOL_HOOK_FILE))
  const applied = await runHook(platform, command, env, home, '')
  let decision: { hook_specific_output?: { updated_input?: Record<string, unknown> } } | undefined
  try {
    decision = JSON.parse(applied.stdout)
  } catch {
    decision = undefined
  }
  const updated = decision?.hook_specific_output?.updated_input
  const args = Array.isArray(updated?.shell_args) ? updated.shell_args : undefined
  if (
    applied.code !== 0 ||
    updated?.shell !== shell ||
    !args ||
    args.length !== POOL_GIT_BASH_ARGS.length ||
    args.some((value, index) => value !== POOL_GIT_BASH_ARGS[index])
  )
    throw new HarnessConfigurationError(
      `pool 解释器固定钩子自检未通过（退出码 ${applied.code}）。官方钩子失败即放行，` +
        '未启动 pool，未回退 PowerShell、CMD 或 WSL。',
    )
  const blocked = await runHook(
    platform,
    command,
    { ...env, [POOL_SHELL_VARIABLE]: join(home, 'opl-missing-shell-for-preflight') },
    home,
    '',
  )
  if (blocked.code !== 2 || !blocked.stderr.includes('no fallback to PowerShell'))
    throw new HarnessConfigurationError(
      `pool 解释器固定钩子在缺少 Git Bash 时未按预期拒绝执行（退出码 ${blocked.code}）。` +
        '官方钩子失败即放行，未启动 pool，未回退 PowerShell、CMD 或 WSL。',
    )
}

/** Environment variables that carry the pin into the CLI and its hooks. */
export function poolShellVariables(home: string, shell: string): Record<string, string> {
  return {
    [POOL_SHELL_VARIABLE]: shell,
    [POOL_SHELL_ARGS_VARIABLE]: JSON.stringify(POOL_GIT_BASH_ARGS),
    [POOL_SHELL_AUDIT_VARIABLE]: join(home, 'shell-hook-audit.ndjson'),
    // The CLI runs hooks in its own environment; this is what lets the packaged
    // Host runtime execute the hook file the way a Node CLI would.
    [POOL_NODE_ENV]: '1',
  }
}

/**
 * Resolve the interpreter, write the hook and its settings, verify both, and
 * return the environment the CLI process must receive.
 *
 * @param options - the suite-owned home plus platform overrides for tests.
 * @returns the full launch environment, including the pinned interpreter, the
 * hook audit path and the PATH entry the bare hook command resolves through.
 * @throws HarnessConfigurationError when the interpreter or the pin cannot be proven.
 */
export async function poolShellEnvironment(options: PoolShellOptions): Promise<NodeJS.ProcessEnv> {
  const platform = options.platform ?? process.platform
  const nodePath = options.nodePath ?? process.execPath
  const base = options.env ?? process.env
  const shell = resolvePoolShell({ platform, env: base })
  await verifyPoolShell(shell, base, platform)
  const home = poolHookDirectory(options.home)
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeFile(join(home, POOL_HOOK_FILE), poolShellHookSource(), {
    encoding: 'utf8',
    mode: 0o600,
  })
  if (platform === 'win32')
    await writeFile(join(home, POOL_HOOK_COMMAND_NAME), hookLauncher(nodePath), {
      encoding: 'utf8',
      mode: 0o600,
    })
  const command = poolHookCommand(platform, nodePath, join(home, POOL_HOOK_FILE))
  await writeSuiteFile(poolSettingsPath(home), poolSettings(command), poolSettingsLayouts(command))
  // The bare Windows command name is resolved through PATH, so the hook launcher
  // directory has to precede it for the CLI's own command runner.
  const path = platform === 'win32' ? [home, base.PATH].filter(Boolean).join(delimiter) : base.PATH
  const env: NodeJS.ProcessEnv = {
    ...base,
    PATH: path,
    ...poolShellVariables(home, poolShellPath(shell)),
  }
  await verifyPoolShellHook(home, poolShellPath(shell), env, platform, nodePath)
  return env
}

/** Windows launcher body for the hook program. */
function hookLauncher(nodePath: string): string {
  return '@echo off\r\n' + `"${nodePath}" "%~dp0${POOL_HOOK_FILE}"\r\n`
}
