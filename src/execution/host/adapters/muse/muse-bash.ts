/**
 * Shell and MCP wiring for the official Muse Code CLI.
 *
 * The interpreter and the tool are separate decisions on purpose:
 *
 *  - The interpreter is Git Bash, resolved with the suite's own resolver and pinned
 *    into the environment as `OPL_MUSE_GIT_BASH`. A missing or unusable bash raises a
 *    `HarnessConfigurationError`; PowerShell, CMD and WSL are never substituted.
 *  - The command tool is a separate MCP server (`./muse-bash-mcp.mjs`), because the
 *    built-in shell cannot be turned into a POSIX shell: `--enable-shell-tool` still
 *    hands PowerShell argv to the executable and a `-c` string fails with exit `2`
 *    and `-N: invalid option`.
 *
 * The owned settings file registers the MCP server and limits run.toolset to its
 * Bash tool. The MSP host reads that file on each fresh process.
 */
import { execFile } from 'node:child_process'
import { access, constants, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveGitBashPath } from '../../../../shell/host/git-bash.ts'
import { HarnessConfigurationError } from '../../acp.ts'

const exec = promisify(execFile)

/** Environment variable the adapter uses to pin the interpreter for the tool. */
export const MUSE_BASH_ENV = 'OPL_MUSE_GIT_BASH'
/** MCP server key. The model-visible tool is `mcp__<key>__run`. */
export const MUSE_MCP_SERVER = 'opl_muse_git_bash'
/** The tool the CLI advertises under that server. */
export const MUSE_MCP_TOOL = `mcp__${MUSE_MCP_SERVER}__run`

/**
 * Resolve Git Bash and prove it runs as an MSYS shell before any process starts.
 *
 * POSIX hosts keep their platform shell, which is what the official CLI uses there.
 * @param env - the environment the suite built for the CLI process.
 * @returns the same environment with the interpreter pinned, plus the resolved path.
 * @throws HarnessConfigurationError when Git Bash cannot be resolved or does not run
 * as an MSYS shell. The CLI is never started in that case.
 */
export async function museBashEnvironment(
  env: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv; shell: string }> {
  if (process.platform !== 'win32')
    return { env: { ...env, [MUSE_BASH_ENV]: 'bash' }, shell: 'bash' }
  let shell: string
  try {
    shell = resolveGitBashPath()
  } catch (error) {
    throw new HarnessConfigurationError(
      `Muse Git Bash 无法解析：${error instanceof Error ? error.message : String(error)}。请安装 Git for Windows，或将 OPL_GIT_BASH_PATH 指向一个存在的绝对路径 bash.exe；未启动 Muse Code，未回退 PowerShell、CMD 或 WSL。`,
    )
  }
  try {
    const { stdout } = await exec(
      shell,
      ['--noprofile', '--norc', '-c', 'printf "OPL_MUSE_BASH:"; /usr/bin/uname -s'],
      {
        env: { ...env, MSYS_NO_PATHCONV: '1' },
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 4096,
      },
    )
    if (!/^OPL_MUSE_BASH:(?:MINGW(?:32|64)|MSYS)_NT-/.test(stdout.trim()))
      throw Error('unexpected shell identity')
  } catch {
    throw new HarnessConfigurationError(
      `Muse Git Bash 启动验证失败（${shell}）。请确认 Git for Windows 安装完整且 bash.exe 可执行；未启动 Muse Code，未回退 PowerShell、CMD 或 WSL。`,
    )
  }
  return { env: { ...env, [MUSE_BASH_ENV]: shell, SHELL: shell }, shell }
}

/** The MCP server entry the official settings schema accepts. */
export interface MuseMcpServerEntry {
  transport: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  mode: 'required'
}

/**
 * Build the stdio MCP server entry for the Bash tool.
 * @param commandPath - the node executable the CLI will run the server with.
 * @param serverPath - absolute path to `muse-bash-mcp.mjs`.
 * @param env - the environment the tool's own shell is pinned in.
 * @param shell - the Git Bash path the tool must use.
 * @returns the server entry, with the interpreter passed through as its own input.
 */
export function museMcpServer(
  commandPath: string,
  serverPath: string,
  env: NodeJS.ProcessEnv,
  shell: string,
): MuseMcpServerEntry {
  return {
    transport: 'stdio',
    command: commandPath,
    args: [serverPath],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      [MUSE_BASH_ENV]: shell,
      // A tool process must not inherit a user's ambient profile; the CLI already
      // runs it inside the session's own directories, and the tool only needs the
      // interpreter plus a stable encoding.
      MSYS_NO_PATHCONV: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      ...Object.fromEntries(
        ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'].flatMap((key) =>
          env[key] ? [[key, String(env[key])]] : [],
        ),
      ),
    },
    mode: 'required',
  }
}

/** Build the owned settings file; credentials remain in the child environment. */
export function museSettingsDocument(
  server: MuseMcpServerEntry,
  baseURL?: string,
): Record<string, unknown> {
  return {
    schema_version: 1,
    ...(baseURL ? { endpoint_transport: { base_url: baseURL, auth: 'bearer' } } : {}),
    mcpServers: { [MUSE_MCP_SERVER]: server },
    run: { toolset: [MUSE_MCP_TOOL] },
  }
}

/**
 * Write the suite-owned settings document under the session's own config home.
 * @param configHome - absolute `XDG_CONFIG_HOME` for this session.
 * @param server - the stdio server entry.
 * @param baseURL - exact endpoint selected by the model source.
 * @returns the settings file path.
 */
export async function writeMuseSettings(
  configHome: string,
  server: MuseMcpServerEntry,
  baseURL: string,
): Promise<string> {
  const directory = join(configHome, 'muse')
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'settings.json')
  await writeFile(
    file,
    `${JSON.stringify(museSettingsDocument(server, baseURL), null, 2)}\n`,
    'utf8',
  )
  return file
}

/**
 * Prove the tool server exists and starts before the CLI is asked to run it.
 *
 * `required: true` already makes the CLI refuse the run when the server cannot
 * start; this moves that failure to the suite's own preflight, where it can name the
 * interpreter instead of surfacing as an empty toolset.
 * @param serverPath - absolute path to `muse-bash-mcp.mjs`.
 * @param commandPath - the node executable that will run it.
 * @returns nothing; a resolved promise means the server is startable.
 * @throws HarnessConfigurationError when the server file or interpreter is unusable.
 */
export async function assertBashToolUsable(serverPath: string, commandPath: string): Promise<void> {
  if (!isAbsolute(serverPath))
    throw new HarnessConfigurationError(
      `Muse Bash 工具脚本路径不是绝对路径（${serverPath}）；未启动 Muse Code。`,
    )
  const present = await access(serverPath, constants.R_OK).then(
    () => true,
    () => false,
  )
  if (!present)
    throw new HarnessConfigurationError(
      `未找到 Muse Bash 工具脚本（${serverPath}）；未启动 Muse Code，未回退到内置 PowerShell 命令工具。`,
    )
  const node = await access(commandPath, constants.X_OK).then(
    () => true,
    () => false,
  )
  if (!node)
    throw new HarnessConfigurationError(
      `未找到可用于启动 Muse Bash 工具的运行时（${commandPath}）；未启动 Muse Code。`,
    )
}
