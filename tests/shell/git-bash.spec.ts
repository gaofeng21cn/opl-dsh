import { describe, expect, it } from 'vitest'
import { resolveGitBashPath } from '../../src/shell/host/git-bash.ts'

describe('Git Bash path resolution', () => {
  it('accepts an explicit executable path containing spaces', () => {
    const path = resolveGitBashPath({
      platform: 'win32',
      env: { OPL_GIT_BASH_PATH: 'C:/Program Files/Git/bin/bash.exe' },
      exists: (candidate) => candidate.includes('Program Files'),
    })
    expect(path).toBe('C:/Program Files/Git/bin/bash.exe')
  })

  it('reports an actionable error when Git Bash is unavailable', () => {
    expect(() =>
      resolveGitBashPath({ platform: 'win32', env: { PATH: '' }, exists: () => false }),
    ).toThrow(/OPL_GIT_BASH_PATH/)
  })

  it('does not fall back when an explicit override is invalid', () => {
    expect(() =>
      resolveGitBashPath({
        platform: 'win32',
        env: { OPL_GIT_BASH_PATH: 'C:/missing/bash.exe', ProgramFiles: 'C:/Program Files' },
        exists: (candidate) => candidate.includes('Program Files'),
      }),
    ).toThrow(/no fallback/)
    expect(() =>
      resolveGitBashPath({
        platform: 'win32',
        env: { OPL_GIT_BASH_PATH: 'bash.exe' },
        exists: () => true,
      }),
    ).toThrow(/absolute/)
  })
})
