/**
 * Windows shell wiring for the StepCode adapter.
 *
 * The Git Bash path the suite resolves is verified by *executing* it, because the suite's
 * own provider only checks that a configured path is absolute and exists — which
 * `powershell.exe` satisfies. These cases therefore run real processes and assert on
 * their output, not on a claimed setting.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HarnessConfigurationError } from '../../../src/execution/host/acp.ts'
import {
  STEP_SHELL_PATH_ENV,
  stepBashEnvironment,
  stepShellCandidateProblem,
} from '../../../src/execution/host/adapters/step/step-bash.ts'
import { resolveGitBashPath } from '../../../src/shell/host/git-bash.ts'

/** The real Git-for-Windows bash on this machine, when there is one. */
const realBash = (() => {
  try {
    return resolveGitBashPath()
  } catch {
    return undefined
  }
})()

describe('StepCode shell candidate checks', () => {
  it('rejects a relative path before spawning anything', () => {
    expect(stepShellCandidateProblem('bash.exe')).toMatch(/必须是绝对 Windows 路径/)
  })

  it('rejects the WSL entry point the official CLI also refuses', () => {
    const system32 = join(process.env.SystemRoot ?? 'C:/Windows', 'System32')
    expect(stepShellCandidateProblem(join(system32, 'bash.exe'))).toMatch(/WSQL|WSL|WSL 入口/)
  })

  it('rejects an executable that is not named bash.exe', () => {
    // The suite provider would accept this path because it exists and is absolute.
    expect(
      stepShellCandidateProblem('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'),
    ).toMatch(/必须指向名为 bash.exe/)
  })

  it('rejects a path that does not exist', () => {
    expect(stepShellCandidateProblem('C:/definitely/not/here/bash.exe')).toMatch(/不存在/)
  })
})

describe('StepCode shell environment', () => {
  it('injects nothing on POSIX hosts, where the CLI resolves its own shell', async () => {
    const result = await stepBashEnvironment({ PATH: '/usr/bin' }, { platform: 'linux' })
    expect(result.shell).toBeUndefined()
    expect(result.env[STEP_SHELL_PATH_ENV]).toBeUndefined()
  })

  it('fails explicitly when Git Bash is absent, with no PowerShell fallback', async () => {
    const attempt = stepBashEnvironment(
      { PATH: '' },
      {
        platform: 'win32',
        resolve: () => {
          throw Error('absent')
        },
      },
    )
    await expect(attempt).rejects.toThrow(HarnessConfigurationError)
    await expect(attempt).rejects.toThrow(/只使用 Git Bash，不会回退到 PowerShell/)
  })

  it('refuses a wrong candidate by name without spawning it', async () => {
    const attempt = stepBashEnvironment(
      {},
      {
        platform: 'win32',
        resolve: () => 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      },
    )
    await expect(attempt).rejects.toThrow(/必须指向名为 bash\.exe/)
    await expect(attempt).rejects.toThrow(/不会静默回退到其他 shell/)
  })

  it.runIf(realBash)('pins a verified Git-for-Windows bash it actually executed', async () => {
    const result = await stepBashEnvironment(
      { PATH: process.env.PATH ?? '' },
      { platform: 'win32' },
    )
    expect(result.shell).toBe(realBash)
    expect(result.env[STEP_SHELL_PATH_ENV]).toBe(realBash)
    expect(result.env.SHELL).toBe(realBash)
    expect(existsSync(result.shell!)).toBe(true)
  })

  it.runIf(realBash)('runs a real external git command through the pinned bash', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const result = await stepBashEnvironment({}, { platform: 'win32' })
    const { stdout } = await exec(result.shell!, ['--noprofile', '--norc', '-c', 'git --version'], {
      windowsHide: true,
      timeout: 10000,
    })
    // The proof that PATH works under the verified shell, not a claim that it does.
    expect(stdout).toMatch(/git version \d+\./)
  })
})
