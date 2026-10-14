import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  KIMI_LEGACY_GIT_BASH_ENV,
  KIMI_SHELL_PATH_ENV,
  assertKimiAcpVersion,
  kimiBashEnvironment,
  kimiShellCandidateProblem,
} from '../../../src/execution/host/adapters/kimi/kimi-bash.ts'
import { resolveGitBashPath } from '../../../src/shell/host/git-bash.ts'
import type { AcpSessionSnapshot } from '../../../src/execution/host/adapters/types.ts'

afterEach(() => vi.unstubAllEnvs())

const snapshot = (version: unknown): AcpSessionSnapshot =>
  ({
    agent: { agentInfo: { name: 'Kimi Code CLI', version } },
    session: {},
    configOptions: [],
  }) as AcpSessionSnapshot

describe('Kimi Code Windows shell wiring', () => {
  it('pins the runnable Git Bash through the variable kimi-code actually reads', async () => {
    vi.stubEnv(KIMI_SHELL_PATH_ENV, 'C:/untrusted/powershell.exe')
    const env = await kimiBashEnvironment({ PATH: 'C:/Windows' })
    const shell = resolveGitBashPath()
    // The inherited value is overridden, not honored: kimi-code silently falls through
    // to auto-detection when the variable names a missing file, which would hand the
    // task a different bash than the one verified here.
    expect(env[KIMI_SHELL_PATH_ENV]).toBe(shell)
    expect(env.SHELL).toBe(shell)
    expect(existsSync(shell)).toBe(true)
  })

  it('never sets the archived Python CLI variable', async () => {
    const env = await kimiBashEnvironment({ PATH: 'C:/Windows' })
    // KIMI_CLI_GIT_BASH_PATH belongs to MoonshotAI/kimi-cli, which kimi-code ignores.
    expect(env).not.toHaveProperty(KIMI_LEGACY_GIT_BASH_ENV)
    expect(env).not.toHaveProperty('MCODE_SHELL_PATH')
  })

  it('rejects a candidate that is not bash.exe, including PowerShell and WSL', () => {
    for (const bad of [
      'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      'C:/Windows/System32/bash.exe',
      'C:/Windows/System32/wsl.exe',
      'C:/uninstalled/other.exe',
      'relative/bash.exe',
    ])
      expect(kimiShellCandidateProblem(bad)).toBeTypeOf('string')
    // A real Git for Windows bash passes.
    expect(kimiShellCandidateProblem(resolveGitBashPath())).toBeUndefined()
  })

  it('rejects an existing executable that is not named bash.exe', async () => {
    const systemRoot = process.env.SystemRoot ?? 'C:/Windows'
    const real = `${systemRoot}/System32/where.exe`
    if (!existsSync(real)) return
    // Absolute and existing — both checks the suite's own provider makes — yet plainly
    // not a shell.
    await expect(kimiBashEnvironment({}, { resolve: () => real })).rejects.toThrow(
      /必须指向名为 bash\.exe 的可执行文件/,
    )
  })

  it('fails closed when a file named bash.exe cannot execute as Git Bash', async () => {
    const systemRoot = process.env.SystemRoot ?? 'C:/Windows'
    const donor = `${systemRoot}/System32/where.exe`
    if (!existsSync(donor)) return
    // Passes every static check, including the basename rule, so only executing it can
    // tell that this is not a Git-for-Windows bash. This is the case kimi-code would
    // never catch on its own, because it falls through to auto-detection.
    const root = await mkdtemp(join(tmpdir(), 'opl-kimi-bash-'))
    const stub = join(root, 'bash.exe')
    await copyFile(donor, stub)
    try {
      await expect(kimiBashEnvironment({}, { resolve: () => stub })).rejects.toThrow(
        /Git Bash 启动验证失败/,
      )
      await expect(kimiBashEnvironment({}, { resolve: () => stub })).rejects.toThrow(
        /不会回退到 PowerShell 或 WSL/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a missing Git Bash instead of falling back to another shell', async () => {
    await expect(
      kimiBashEnvironment({}, { resolve: () => 'C:/does/not/exist/bash.exe' }),
    ).rejects.toThrow(/Kimi Code 无法使用所选 Git Bash/)
  })

  it('leaves the environment untouched on POSIX hosts', async () => {
    const env = await kimiBashEnvironment({ PATH: '/usr/bin' }, { platform: 'linux' })
    expect(env).toEqual({ PATH: '/usr/bin' })
  })
})

describe('Kimi Code ACP version gate', () => {
  it('accepts the verified release and the supported floor', () => {
    expect(assertKimiAcpVersion(snapshot('2.1.1'))).toBe('2.1.1')
    expect(assertKimiAcpVersion(snapshot('2.0.0'))).toBe('2.0.0')
    expect(assertKimiAcpVersion(snapshot('3.0.0'))).toBe('3.0.0')
  })

  it('refuses an older binary rather than probing it field by field', () => {
    for (const version of ['1.52.0', '1.42.0', '0.43.1', '1.9.9'])
      expect(() => assertKimiAcpVersion(snapshot(version))).toThrow(/低于本适配器所需的/)
  })

  it('refuses a missing or malformed version without echoing it', () => {
    for (const version of [undefined, '', 'latest', 'v2.1.1', '2.1', 21, null, { evil: 'x' }]) {
      expect(() => assertKimiAcpVersion(snapshot(version))).toThrow(/未报告可识别的版本号/)
    }
  })
})
