import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SandboxBashExecutor, type Config as LocalBashConfig } from '@deepseek-ai/dsh-bash-sandbox'
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'

export interface GitBashPathOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
}

/**
 * Return the Windows locations checked before consulting PATH.
 * @param env - environment values used to construct installation roots.
 * @returns candidate executable paths in preference order.
 */
export function gitBashCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(
    (value): value is string => Boolean(value),
  )
  return [
    ...roots.flatMap((root) => [
      join(root, 'Git', 'bin', 'bash.exe'),
      join(root, 'Git', 'usr', 'bin', 'bash.exe'),
    ]),
    ...(env.OPL_GIT_BASH_PATH ? [env.OPL_GIT_BASH_PATH] : []),
  ]
}

/**
 * Resolve the Git for Windows executable used by the native shell provider.
 * @param options - platform, environment, and filesystem probe overrides.
 * @returns an executable path, or `bash` on POSIX hosts.
 * @throws when Windows has no discoverable Git Bash executable.
 */
export function resolveGitBashPath(options: GitBashPathOptions = {}): string {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return 'bash'
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const candidates = [
    ...(env.OPL_GIT_BASH_PATH ? [env.OPL_GIT_BASH_PATH] : []),
    ...gitBashCandidates(env),
    ...(env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, 'bash.exe')),
  ]
  const path = [...new Set(candidates)].find((candidate) => exists(candidate))
  if (path) return path
  throw new Error(
    'Git Bash was not found. Install Git for Windows or set OPL_GIT_BASH_PATH to bash.exe.',
  )
}

/** Local Bash provider that keeps the official sandbox and uses Git Bash on Windows. */
export class GitBashExecutor extends SandboxBashExecutor {
  private readonly gitBashPath: string

  constructor(ctx: Context, config: LocalBashConfig) {
    super(ctx, config)
    this.gitBashPath = resolveGitBashPath()
  }

  protected override executeArgv(
    spec: ShellExecSpec,
    argvOrPrepare: readonly string[] | ((signal: AbortSignal) => Promise<readonly string[]>),
    onStarted?: (process: ShellExecution) => void,
  ): Promise<ShellExecution> {
    const replaceBash = (argv: readonly string[]): readonly string[] => {
      if (argv[0] === 'bash') return [this.gitBashPath, ...argv.slice(1)]
      const separator = argv.indexOf('--')
      if (separator >= 0 && argv[separator + 1] === 'bash') {
        return [...argv.slice(0, separator + 1), this.gitBashPath, ...argv.slice(separator + 2)]
      }
      return argv
    }
    const prepared =
      typeof argvOrPrepare === 'function'
        ? async (signal: AbortSignal) => replaceBash(await argvOrPrepare(signal))
        : replaceBash(argvOrPrepare)
    return super.executeArgv(spec, prepared, onStarted)
  }
}

export const inject = ['subprocess', 'sandbox', 'sandboxPolicy']
export const Config = SandboxBashExecutor.Config
export type Config = LocalBashConfig

/**
 * Install the Git Bash shell service on Windows; POSIX hosts keep the official provider.
 * @param ctx - official Host context.
 * @param config - inherited local Bash budgets and defaults.
 */
export function apply(ctx: Context, config: Config): void {
  if (process.platform === 'win32') new GitBashExecutor(ctx, config)
}
