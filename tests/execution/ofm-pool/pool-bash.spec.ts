/**
 * Launch preconditions for the pool adapter, checked against the real machine.
 *
 * The official hook service fails open, so the suite proves the pin before it
 * starts anything: the interpreter has to execute as a POSIX shell, the hook has
 * to run through the platform's own command runner and return the pinned
 * decision, and it has to block instead of falling back when the interpreter is
 * gone. A missing Git Bash must be a refusal, never a PowerShell session.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessConfigurationError } from '../../../src/execution/host/acp.ts'
import { resolveGitBashPath } from '../../../src/shell/host/git-bash.ts'
import { systemEnvironment } from '../../../src/execution/host/adapters/environment.ts'
import {
  POOL_GIT_BASH_ARGS,
  POOL_HOOK_COMMAND_NAME,
  POOL_HOOK_FILE,
  POOL_SETTINGS_FILE,
  POOL_SHELL_ARGS_VARIABLE,
  POOL_SHELL_VARIABLE,
  poolSettings,
  poolSettingsPath,
  poolShellEnvironment,
  poolShellPath,
  resolvePoolShell,
  verifyPoolShellHook,
} from '../../../src/execution/host/adapters/pool/index.ts'
import { scratchRoot } from './fixtures/records.ts'

const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function suiteHome(): Promise<string> {
  const dir = await mkdtemp(join(scratchRoot(), 'opl-pool-bash-'))
  dirs.push(dir)
  return join(dir, 'harness')
}

describe('pool interpreter pin', () => {
  it('discovers Git from the installation root after filtering the launch environment', () => {
    vi.stubEnv('ProgramFiles', 'C:/OwnedPrograms')
    vi.stubEnv('ProgramFiles(x86)', '')
    vi.stubEnv('LOCALAPPDATA', '')
    vi.stubEnv('OPL_GIT_BASH_PATH', '')
    vi.stubEnv('PATH', 'C:/Windows/System32')
    vi.stubEnv('UNRELATED_PROVIDER_API_KEY', 'fixture-secret')
    const env = systemEnvironment()
    expect(env.UNRELATED_PROVIDER_API_KEY).toBeUndefined()
    const target =
      'C:' +
      String.fromCharCode(92) +
      ['OwnedPrograms', 'Git', 'bin', 'bash.exe'].join(String.fromCharCode(92))
    expect(resolvePoolShell({ platform: 'win32', env, exists: (p) => p === target })).toBe(target)
  })

  it('retains an explicit Bash path and rejects a missing override without fallback', () => {
    vi.stubEnv('OPL_GIT_BASH_PATH', 'C:/OwnedShell/bash.exe')
    const env = systemEnvironment()
    expect(
      resolvePoolShell({ platform: 'win32', env, exists: (p) => p === 'C:/OwnedShell/bash.exe' }),
    ).toBe('C:/OwnedShell/bash.exe')
    expect(() => resolvePoolShell({ platform: 'win32', env, exists: () => false })).toThrow(
      /no fallback/,
    )
  })
  it('pins the Git Bash this suite resolves, not one the environment names', () => {
    // Both sides use the product's own environment construction. Building one side
    // from a `{...process.env}` spread and the other from the live object is not
    // equivalent on Windows: `process.env` reads names case-insensitively while a
    // spread object does not, so `ProgramFiles` can resolve on one side and vanish on
    // the other. Both results were Git Bash, never PowerShell; the fixture is what was
    // wrong, so the fix is a like-for-like environment, not a different expectation.
    const expected = resolvePoolShell({ platform: 'win32', env: systemEnvironment() })
    const hostile = {
      ...systemEnvironment(),
      SHELL: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    }
    const shell = resolvePoolShell({ platform: 'win32', env: hostile })
    expect(shell).toBe(expected)
    expect(shell.toLowerCase()).toContain('bash.exe')
    expect(shell.toLowerCase()).not.toContain('powershell.exe')
  })

  it('prefers the installation root over PATH order, with an injected probe', () => {
    // A controlled installation: `bin\bash.exe` exists, and a PATH entry that also
    // contains a `bash.exe` points somewhere else. The documented candidate order has
    // to win, and the probe proves which file the resolver actually accepted.
    const env = {
      ProgramFiles: 'C:/Controlled',
      PATH: ['C:/Other', 'C:/Controlled/Git/usr/bin'].join(';'),
    } as NodeJS.ProcessEnv
    const accepted: string[] = []
    const shell = resolvePoolShell({
      platform: 'win32',
      env,
      exists: (path) => {
        const present =
          path === 'C:\\Controlled\\Git\\bin\\bash.exe' ||
          path === 'C:\\Other\\bash.exe' ||
          path === 'C:\\Controlled\\Git\\usr\\bin\\bash.exe'
        if (present) accepted.push(path)
        return present
      },
    })
    expect(shell).toBe('C:\\Controlled\\Git\\bin\\bash.exe')
    expect(accepted[0]).toBe('C:\\Controlled\\Git\\bin\\bash.exe')
  })

  it('honours an explicit candidate over SHELL and over PATH', () => {
    const explicit = resolveGitBashPath()
    const shell = resolvePoolShell({
      platform: 'win32',
      env: {
        ...systemEnvironment(),
        SHELL: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
        PATH: 'C:/Windows/System32',
        OPL_GIT_BASH_PATH: explicit,
      },
    })
    expect(shell).toBe(explicit)
  })

  it('pins a fixed POSIX path instead of the user login shell', () => {
    expect(resolvePoolShell({ platform: 'linux', env: { SHELL: '/bin/zsh' } })).toBe('/bin/bash')
  })

  it('refuses an explicit interpreter that does not exist, with no fallback', () => {
    expect(() =>
      resolvePoolShell({
        platform: 'win32',
        env: { ...process.env, OPL_GIT_BASH_PATH: 'C:/uninstalled/bash.exe' },
      }),
    ).toThrow(HarnessConfigurationError)
    expect(() =>
      resolvePoolShell({
        platform: 'win32',
        env: { ...process.env, OPL_GIT_BASH_PATH: 'C:/uninstalled/bash.exe' },
      }),
    ).toThrow(/未回退 PowerShell、CMD 或 WSL/u)
  })

  it('refuses to run on a Windows host without any Git Bash', () => {
    const empty = { SystemRoot: 'C:/Windows', PATH: 'C:/Windows/System32' }
    expect(() => resolvePoolShell({ platform: 'win32', env: empty })).toThrow(
      /Git Bash was not found/u,
    )
  })

  it('writes the hook, its launcher and the settings the CLI loads', async () => {
    const home = await suiteHome()
    const additions = await poolShellEnvironment({ home })
    expect(existsSync(join(home, POOL_HOOK_FILE))).toBe(true)
    if (process.platform === 'win32')
      expect(existsSync(join(home, POOL_HOOK_COMMAND_NAME))).toBe(true)
    expect(existsSync(poolSettingsPath(home))).toBe(true)
    const settings = await readFile(poolSettingsPath(home), 'utf8')
    expect(settings).toBe(
      poolSettings(
        process.platform === 'win32'
          ? POOL_HOOK_COMMAND_NAME
          : `"${process.execPath}" "${join(home, POOL_HOOK_FILE)}"`,
      ),
    )
    expect(additions[POOL_SHELL_VARIABLE]).toBe(poolShellPath(resolvePoolShell()))
    expect(JSON.parse(additions[POOL_SHELL_ARGS_VARIABLE]!)).toEqual([...POOL_GIT_BASH_ARGS])
    if (process.platform === 'win32') expect(additions.PATH?.startsWith(home)).toBe(true)
  })

  it('refuses to overwrite a settings file it did not write', async () => {
    const home = await suiteHome()
    await poolShellEnvironment({ home })
    await writeFile(poolSettingsPath(home), 'hooks: []\n', 'utf8')
    await expect(poolShellEnvironment({ home })).rejects.toThrow(/被外部修改/u)
  })

  it('re-runs the same preflight for a session that reuses the home', async () => {
    const home = await suiteHome()
    await poolShellEnvironment({ home })
    await expect(poolShellEnvironment({ home })).resolves.toBeTruthy()
  })
})

describe('pool hook preflight', () => {
  it('runs the registered hook and returns the pinned decision', async () => {
    const home = await suiteHome()
    const env = await poolShellEnvironment({ home })
    // The pin survives a hostile environment: the hook decides the interpreter from
    // the launch variables, not from SHELL or from PATH.
    await expect(
      verifyPoolShellHook(home, poolShellPath(resolvePoolShell()), {
        ...env,
        SHELL: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      }),
    ).resolves.toBeUndefined()
  })

  it('refuses the launch when the hook cannot start, because hooks fail open', async () => {
    const home = await suiteHome()
    const env = await poolShellEnvironment({ home })
    // A launcher the CLI's command runner cannot execute is the fail-open case: the
    // hook would never run and the model's own interpreter would win silently.
    await writeFile(join(home, POOL_HOOK_COMMAND_NAME), '@echo off\nexit /b 3\n', 'utf8')
    await expect(verifyPoolShellHook(home, poolShellPath(resolvePoolShell()), env)).rejects.toThrow(
      /钩子自检未通过/u,
    )
  })

  it('refuses the launch when the hook would fall back instead of blocking', async () => {
    const home = await suiteHome()
    const env = await poolShellEnvironment({ home })
    await writeFile(
      join(home, POOL_HOOK_FILE),
      [
        "import fs from 'node:fs'",
        'let raw = ""',
        'try { raw = fs.readFileSync(0, "utf8") } catch {}',
        'const payload = JSON.parse(raw || "{}")',
        'if (payload.hook_event_name !== "PreToolUse") process.exit(0)',
        // Pins correctly, but answers a missing interpreter instead of blocking.
        'const shell = process.env.OPL_POOL_SHELL',
        'const args = JSON.parse(process.env.OPL_POOL_SHELL_ARGS)',
        'const updated = Object.assign({}, payload.tool_input, { shell, shell_args: args })',
        'process.stdout.write(JSON.stringify({ hook_specific_output: { updated_input: updated } }))',
        '',
      ].join('\n'),
      'utf8',
    )
    await expect(verifyPoolShellHook(home, poolShellPath(resolvePoolShell()), env)).rejects.toThrow(
      /未按预期拒绝执行/u,
    )
  })
})
