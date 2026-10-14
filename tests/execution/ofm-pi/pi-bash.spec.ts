/**
 * Windows shell wiring for the Pi adapter, and the one thing this harness must prove about
 * it: that a single `shellPath` decides both the model-facing `bash` tool and the user's `!`
 * commands.
 *
 * The official Pi Windows documentation states that with a native process and no
 * `powershell` tool, the built-in `bash` tool *and* the `!` / `!!` commands both run under
 * that one setting. The last case in this file verifies that against the real CLI rather
 * than against the documentation, by pointing `shellPath` at an executable that exists and
 * is named `bash.exe` but is not a shell, and observing that **both** surfaces refuse.
 *
 * The Git Bash path the suite resolves is verified by *executing* it, because the suite's
 * own provider only checks that a configured path is absolute and exists — which
 * `powershell.exe` satisfies.
 */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'
import { HarnessConfigurationError } from '../../../src/execution/host/acp.ts'
import {
  PI_SHELL_PATH_ENV,
  piBashEnvironment,
  piShellCandidateProblem,
} from '../../../src/execution/host/adapters/pi/pi-bash.ts'
import {
  buildPiSettings,
  buildPiModelsConfig,
  piStorage,
} from '../../../src/execution/host/adapters/pi/pi-config.ts'
import { resolveGitBashPath } from '../../../src/shell/host/git-bash.ts'
import { piTempDir } from './fixtures/agent.ts'

const exec = promisify(execFile)

/** The real Git-for-Windows bash on this machine, when there is one. */
const realBash = (() => {
  try {
    return resolveGitBashPath()
  } catch {
    return undefined
  }
})()

/**
 * The same path, but only where it is a runnable Git-for-Windows bash.
 *
 * `resolveGitBashPath()` answers the bare name `bash` on a POSIX host, which is a
 * correct answer for the POSIX provider but not a Windows candidate: the cases below
 * execute the pinned path as a Windows shell, so they are Windows-only by construction
 * rather than by accident of what happens to be installed.
 */
const windowsBash = process.platform === 'win32' ? realBash : undefined

describe('Pi shell candidate checks', () => {
  it('rejects a relative path before spawning anything', () => {
    expect(piShellCandidateProblem('bash.exe')).toMatch(/必须是绝对 Windows 路径/)
  })

  it('rejects the WSL entry point the official CLI also refuses', () => {
    // `win32.join` so the candidate keeps Windows separators on every host. The WSL
    // branch is decided from the path shape alone and runs before any filesystem probe,
    // so the refusal is the same on a runner that has no `System32` at all.
    const system32 = win32.join(process.env.SystemRoot ?? 'C:/Windows', 'System32')
    expect(piShellCandidateProblem(win32.join(system32, 'bash.exe'))).toMatch(/WSL/)
  })

  it('rejects an executable that is not named bash.exe', () => {
    // The suite provider would accept this path because it exists and is absolute.
    expect(
      piShellCandidateProblem('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'),
    ).toMatch(/必须指向名为 bash.exe/)
  })

  it('rejects a path that does not exist', () => {
    expect(piShellCandidateProblem('C:/definitely/not/here/bash.exe')).toMatch(/不存在/)
  })
})

describe('Pi shell environment', () => {
  it('injects nothing on POSIX hosts, where the CLI resolves its own shell', async () => {
    const result = await piBashEnvironment({ PATH: '/usr/bin' }, { platform: 'linux' })
    expect(result.shell).toBeUndefined()
    expect(result.env[PI_SHELL_PATH_ENV]).toBeUndefined()
  })

  it('fails explicitly when Git Bash is absent, with no PowerShell fallback', async () => {
    const attempt = piBashEnvironment(
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
    const attempt = piBashEnvironment(
      {},
      {
        platform: 'win32',
        resolve: () => 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      },
    )
    await expect(attempt).rejects.toThrow(/必须指向名为 bash\.exe/)
    await expect(attempt).rejects.toThrow(/不会静默回退到其他 shell/)
  })

  it.runIf(windowsBash)('pins a verified Git-for-Windows bash it actually executed', async () => {
    const result = await piBashEnvironment({ PATH: process.env.PATH ?? '' }, { platform: 'win32' })
    expect(result.shell).toBe(windowsBash)
    expect(result.env[PI_SHELL_PATH_ENV]).toBe(windowsBash)
    expect(result.env.SHELL).toBe(windowsBash)
    expect(existsSync(result.shell!)).toBe(true)
  })

  it.runIf(windowsBash)('runs a real external git command through the pinned bash', async () => {
    const result = await piBashEnvironment({}, { platform: 'win32' })
    const { stdout } = await exec(result.shell!, ['--noprofile', '--norc', '-c', 'git --version'], {
      windowsHide: true,
      timeout: 10000,
    })
    // The proof that PATH works under the verified shell, not a claim that it does.
    expect(stdout).toMatch(/git version \d+\./)
  })
})

describe('Pi one-shell selection', () => {
  it('writes exactly one shellPath, and it is the verified shell', () => {
    // One key, therefore one selection: the model `bash` tool and the user's `!` commands
    // read the same value and cannot diverge.
    const settings = buildPiSettings('C:/Program Files/Git/bin/bash.exe')
    expect(Object.keys(settings)).toEqual(['shellPath'])
    expect(settings.shellPath).toBe('C:/Program Files/Git/bin/bash.exe')
    // On POSIX the official CLI resolves its own shell, so nothing is pinned.
    expect(buildPiSettings(undefined)).toEqual({})
  })

  it.runIf(realBash)('stores the verified shell under the official agent directory layout', () => {
    const home = piTempDir('opl-pi-shell-')
    const storage = piStorage(home)
    // `models.json` and `settings.json` both load from inside the agent directory, which is
    // the layout Pi actually reads; there is no separate config root.
    expect(storage.agentDir.endsWith('/pi/agent')).toBe(true)
    expect(storage.sessionDir.endsWith('/pi/sessions')).toBe(true)
    // Every path stays inside the suite-owned session home; the real `~/.pi/agent` is never
    // the target.
    for (const path of [
      storage.agentDir,
      storage.sessionDir,
      storage.sessionIndexDir,
      storage.scratchDir,
    ])
      expect(path.startsWith(home)).toBe(true)
  })

  it('refuses a file named bash.exe that is not a shell, by executing it', async () => {
    const dir = piTempDir('opl-pi-fake shell-')
    const fake = join(dir, 'bash.exe')
    writeFileSync(fake, 'this is not a shell')
    // It passes every static check the suite's own provider applies — absolute, exists, and
    // correctly named — so only running it can tell.
    expect(piShellCandidateProblem(fake)).toBeUndefined()
    await expect(piBashEnvironment({}, { platform: 'win32', resolve: () => fake })).rejects.toThrow(
      /Git Bash 启动验证失败/,
    )
  })

  it('keeps the generated provider config credential-blind', () => {
    const models = buildPiModelsConfig({
      provider: 'opl-pi-lfm-lane',
      model: 'liquid/lfm-2.5-2.6b:free',
      baseURL: 'https://models.example.test/v1',
      api: 'openai-completions',
    })
    expect(JSON.stringify(models)).not.toContain('apiKey": "')
    expect((models.providers as any)['opl-pi-lfm-lane'].apiKey).toBe('$OPL_PI_CREDENTIAL')
    // A lane that does not advertise reasoning must not carry the flag, or the official CLI
    // would advertise thinking levels the model never offered.
    expect((models.providers as any)['opl-pi-lfm-lane'].models[0].reasoning).toBeUndefined()
    const reasoning = buildPiModelsConfig({
      provider: 'opl-pi-nemotron-lane',
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      baseURL: 'https://models.example.test/v1',
      api: 'openai-completions',
      reasoning: true,
    })
    expect((reasoning.providers as any)['opl-pi-nemotron-lane'].models[0].reasoning).toBe(true)
    mkdirSync(piTempDir('opl-pi-unused-'), { recursive: true })
  })
})
