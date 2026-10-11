import { describe, expect, it, afterEach, vi } from 'vitest'
import {
  minimaxBashEnvironment,
  verifyMinimaxBash,
} from '../../src/execution/host/adapters/minimax-bash.ts'
import { systemEnvironment } from '../../src/execution/host/adapters/environment.ts'
import { resolveGitBashPath } from '../../src/shell/host/git-bash.ts'

afterEach(() => vi.unstubAllEnvs())

describe.skipIf(process.platform !== 'win32')('MiniMax Windows Bash backend', () => {
  it('pins the runnable Git Bash path in the CLI environment without copying credentials', async () => {
    vi.stubEnv('MCODE_SHELL_PATH', 'C:/untrusted/powershell.exe')
    vi.stubEnv('MINIMAX_API_KEY', 'must-not-copy')
    const env = await minimaxBashEnvironment(systemEnvironment())
    expect(env.MCODE_SHELL_PATH).toBe(resolveGitBashPath())
    expect(env.SHELL).toBe(env.MCODE_SHELL_PATH)
    expect(env.MINIMAX_API_KEY).toBeUndefined()
    expect(() =>
      verifyMinimaxBash({
        agent: {
          _meta: {
            'minimax-code/shell': {
              version: 1,
              shell: env.MCODE_SHELL_PATH,
              type: 'bash',
              args: ['-c'],
            },
          },
        },
        session: {},
        configOptions: [],
      }),
    ).not.toThrow()
  })

  it('rejects a bad explicit shell even when a default Git installation exists', async () => {
    vi.stubEnv('OPL_GIT_BASH_PATH', 'C:/not-installed/bash.exe')
    await expect(minimaxBashEnvironment(systemEnvironment())).rejects.toThrow(/no fallback/)
  })

  it('rejects missing or mismatching shell readback', () => {
    for (const shell of [
      undefined,
      { version: 1, type: 'bash', shell: 'C:/different/bash.exe', args: ['-c'] },
    ]) {
      expect(() =>
        verifyMinimaxBash({
          agent: { _meta: { 'minimax-code/shell': shell } },
          session: {},
          configOptions: [],
        }),
      ).toThrow(/未确认/)
    }
  })
})
