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
  // Every assertion in this block is about the Windows path rules the official CLI applies
  // (`win32.isAbsolute`, the `bash.exe` name rule, the System32/WSL exclusion). Those are
  // string rules, so they are asserted on every host; only the cases that have to execute a
  // real Git-for-Windows bash are limited to Windows.
  it.skipIf(process.platform !== 'win32')(
    'pins the runnable Git Bash through the variable kimi-code actually reads',
    async () => {
      vi.stubEnv(KIMI_SHELL_PATH_ENV, 'C:/untrusted/powershell.exe')
      const env = await kimiBashEnvironment({ PATH: 'C:/Windows' })
      const shell = resolveGitBashPath()
      // The inherited value is overridden, not honored: kimi-code silently falls through
      // to auto-detection when the variable names a missing file, which would hand the
      // task a different bash than the one verified here.
      expect(env[KIMI_SHELL_PATH_ENV]).toBe(shell)
      expect(env.SHELL).toBe(shell)
      expect(existsSync(shell)).toBe(true)
    },
  )

  it('继承的 shell 变量不被信任：所选 shell 不可用时拒绝启动，而不是原样传下去', async () => {
    vi.stubEnv(KIMI_SHELL_PATH_ENV, 'C:/untrusted/powershell.exe')
    // An inherited value is never passed through just because it is already set: kimi-code
    // would silently switch to auto-detection instead of failing, handing the task a bash
    // this suite never verified.
    await expect(
      kimiBashEnvironment(
        { PATH: 'C:/Windows' },
        { platform: 'win32', resolve: () => 'C:\\opl-test\\missing\\bash.exe' },
      ),
    ).rejects.toThrow(/Kimi Code 无法使用所选 Git Bash/)
  })

  it('never sets the archived Python CLI variable', async () => {
    const env = await kimiBashEnvironment({ PATH: 'C:/Windows' })
    // KIMI_CLI_GIT_BASH_PATH belongs to MoonshotAI/kimi-cli, which kimi-code ignores.
    expect(env).not.toHaveProperty(KIMI_LEGACY_GIT_BASH_ENV)
    expect(env).not.toHaveProperty('MCODE_SHELL_PATH')
  })

  it('rejects a candidate that is not bash.exe, including PowerShell and WSL', () => {
    // These candidates are the spellings the suite's own provider hands over: a backslash
    // path, which is what the name rule and the WSL exclusion are written against. Each one
    // is refused for the reason it actually fails, so the WSL entry point cannot be
    // "passing" merely because some other rule happened to reject it first.
    expect(kimiShellCandidateProblem('C:\\Windows\\System32\\wsl.exe')).toMatch(/WSL 入口/)
    expect(kimiShellCandidateProblem('C:\\Windows\\System32\\bash.exe')).toMatch(/WSL 入口/)
    expect(
      kimiShellCandidateProblem('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    ).toMatch(/必须指向名为 bash\.exe/)
    expect(kimiShellCandidateProblem('C:\\uninstalled\\other.exe')).toMatch(
      /必须指向名为 bash\.exe/,
    )
    expect(kimiShellCandidateProblem('relative\\bash.exe')).toMatch(/必须是绝对 Windows 路径/)
    // A real Git for Windows bash passes — only answerable where one is installed.
    if (process.platform === 'win32')
      expect(kimiShellCandidateProblem(resolveGitBashPath())).toBeUndefined()
  })

  it('rejects an absolute path that is not named bash.exe', async () => {
    // Absolute, and on Windows existing as well — both checks the suite's own provider
    // makes — yet plainly not a shell. The name rule is applied before the file is looked
    // at, so the same refusal holds wherever the test runs.
    await expect(
      kimiBashEnvironment(
        {},
        { platform: 'win32', resolve: () => 'C:\\Windows\\System32\\where.exe' },
      ),
    ).rejects.toThrow(/必须指向名为 bash\.exe 的可执行文件/)
  })

  // Needs a real file at a path the Windows rules accept, so it only runs on Windows. The
  // donor is this Node binary rather than a System32 tool, so the fixture does not depend
  // on any particular tool being installed.
  it.skipIf(process.platform !== 'win32')(
    'fails closed when a file named bash.exe cannot execute as Git Bash',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'opl-kimi-bash-'))
      const stub = join(root, 'bash.exe')
      await copyFile(process.execPath, stub)
      try {
        await expect(
          kimiBashEnvironment({}, { platform: 'win32', resolve: () => stub }),
        ).rejects.toThrow(/Git Bash 启动验证失败/)
        await expect(
          kimiBashEnvironment({}, { platform: 'win32', resolve: () => stub }),
        ).rejects.toThrow(/不会回退到 PowerShell 或 WSL/)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('reports a missing Git Bash instead of falling back to another shell', async () => {
    // Named `bash.exe` and absolute, so only the file lookup can refuse it — the refusal
    // must name the missing shell rather than quietly hand back a different one.
    await expect(
      kimiBashEnvironment(
        {},
        { platform: 'win32', resolve: () => 'C:\\does\\not\\exist\\bash.exe' },
      ),
    ).rejects.toThrow(/Kimi Code 无法使用所选 Git Bash/)
    await expect(
      kimiBashEnvironment(
        {},
        { platform: 'win32', resolve: () => 'C:\\does\\not\\exist\\bash.exe' },
      ),
    ).rejects.toThrow(/不存在/)
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
