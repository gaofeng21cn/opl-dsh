/**
 * The official Grok Build CLI pins its Windows tool shell through `GROK_SHELL`.
 * These tests cover the adapter's half of that contract: refusing to launch when
 * the CLI would silently fall back to PowerShell, pinning the override into the
 * real launch environment, and keeping the suite-owned `config.toml` byte-stable
 * so an upgrade does not invalidate an existing profile.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GROK_GIT_BASH,
  GROK_SHELL_VARIABLE,
  gitInstallationRoot,
  grokBashEnvironment,
  grokBashSelection,
  grokGitBashCandidates,
  grokGitBashSelection,
} from '../../src/execution/host/adapters/grok-bash.ts'
import {
  grokConfigLayouts,
  grokConfiguration,
  grokConfigurationWithCliMarker,
  grokLegacyConfiguration,
} from '../../src/execution/host/adapters/grok.ts'
import { systemEnvironment } from '../../src/execution/host/adapters/environment.ts'
import { resolveGitBashPath } from '../../src/shell/host/git-bash.ts'
import { HarnessConfigurationError } from '../../src/execution/host/acp.ts'

const fixture = fileURLToPath(new URL('../fixtures/grok-bash-agent.mjs', import.meta.url))
const windows = process.platform === 'win32'
const ROOTS = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'] as const

/**
 * Git Bash erases `ProgramFiles` from the environment it hands to child
 * processes, which is not what the Desktop itself runs under. Put back the real
 * root that actually contains the resolved Git Bash so the scenario under test
 * is the one a Windows Desktop launch produces.
 */
/**
 * Git Bash erases `ProgramFiles` from the environment it hands to child
 * processes, which is not what the Desktop itself runs under. Name the real root
 * that actually contains the resolved Git Bash, so the scenario under test is
 * the one a Windows Desktop launch produces.
 */
function realDiscoveryRoot(): { name: string; value: string } | undefined {
  const installation = gitInstallationRoot(resolveGitBashPath())
  for (const name of ROOTS) {
    const value = process.env[name]
    if (!value) continue
    const base = value
      .replace(/\//gu, '\\')
      .replace(/[\\/]+$/u, '')
      .toLowerCase()
    if (
      installation === base ||
      installation === `${base}\\git` ||
      installation === `${base}\\programs\\git`
    )
      return { name, value: base }
  }
  for (const leaf of ['\\programs\\git', '\\git'])
    if (installation.endsWith(leaf))
      return { name: 'ProgramFiles', value: installation.slice(0, -leaf.length) }
  return undefined
}

const conventionalInstall = windows ? realDiscoveryRoot() : undefined

afterEach(() => vi.unstubAllEnvs())
beforeEach(() => {
  if (conventionalInstall) vi.stubEnv(conventionalInstall.name, conventionalInstall.value)
})

describe.skipIf(!windows)('Grok Windows Git Bash backend', () => {
  it.skipIf(!conventionalInstall)(
    'pins the official override and the shared Git Bash in the launch environment',
    async () => {
      vi.stubEnv('GROK_SHELL', 'cmd')
      vi.stubEnv('MINIMAX_API_KEY', 'must-not-copy')
      const env = await grokBashEnvironment(systemEnvironment())
      const shell = resolveGitBashPath()
      expect(env[GROK_SHELL_VARIABLE]).toBe(GROK_GIT_BASH)
      expect(env.SHELL).toBe(shell)
      // The CLI resolves the executable itself, so the pinned shell has to belong
      // to an installation the CLI can actually reach; `SHELL` never selects it.
      const reachable = grokGitBashCandidates(env).filter((path) => existsSync(path))
      expect(reachable.map(gitInstallationRoot)).toContain(gitInstallationRoot(shell))
      expect(env.MINIMAX_API_KEY).toBeUndefined()
    },
  )

  it.skipIf(!conventionalInstall)(
    'rebuilds the discovery root a Git Bash launcher stripped',
    async () => {
      // A Git Bash launcher erases ProgramFiles before the Desktop ever starts.
      vi.stubEnv('ProgramFiles', '')
      const env = await grokBashEnvironment(systemEnvironment())
      expect(env.ProgramFiles).toBeTruthy()
      const reachable = grokGitBashCandidates(env).filter((path) => existsSync(path))
      expect(reachable.map(gitInstallationRoot)).toContain(
        gitInstallationRoot(resolveGitBashPath()),
      )
    },
  )

  it('refuses a bad explicit override instead of falling back to a default Git install', async () => {
    vi.stubEnv('OPL_GIT_BASH_PATH', 'C:/not-installed/bash.exe')
    await expect(grokBashEnvironment(systemEnvironment())).rejects.toThrow(
      HarnessConfigurationError,
    )
    await expect(grokBashEnvironment(systemEnvironment())).rejects.toThrow(/OPL_GIT_BASH_PATH/)
  })

  it('refuses a shell the official CLI would not run, and names both installations', async () => {
    const real = resolveGitBashPath()
    const fake = join(tmpdir(), 'opl grok bash.exe')
    await writeFile(fake, 'not an MSYS shell')
    vi.stubEnv('OPL_GIT_BASH_PATH', fake)
    const failure = await grokBashEnvironment(systemEnvironment()).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HarnessConfigurationError)
    const message = (failure as Error).message
    // The suite resolved the fake path; the CLI would run its own first hit, so
    // the refusal names both instead of claiming the resolved one was used.
    expect(message).toContain(fake)
    expect(message.toLowerCase()).toContain(gitInstallationRoot(real))
    expect(message).toMatch(/未启动 Grok，未回退 PowerShell、CMD 或 WSL/)
  })
})

describe.skipIf(windows)('Grok shell backend off Windows', () => {
  it('keeps the CLI default shell on macOS and Linux', async () => {
    const env = { PATH: '/usr/bin' }
    expect(await grokBashEnvironment(env)).toEqual(env)
  })
})

describe('Grok official Git Bash selection', () => {
  const roots = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\LA' }

  it('scans the documented roots in the official order', () => {
    assert.deepEqual(grokGitBashCandidates(roots), [
      'C:\\PF\\Git\\bin\\bash.exe',
      'C:\\PF\\Programs\\Git\\bin\\bash.exe',
      'C:\\PF86\\Git\\bin\\bash.exe',
      'C:\\PF86\\Programs\\Git\\bin\\bash.exe',
      'C:\\LA\\Git\\bin\\bash.exe',
      'C:\\LA\\Programs\\Git\\bin\\bash.exe',
    ])
  })

  it('takes the first existing candidate, not a later match', () => {
    // Two installations are present. The CLI stops at Program Files, so that is
    // what it runs even though the local-app-data one is a valid Git Bash too.
    const exists = (path: string) =>
      path.startsWith('C:\\PF\\Git\\bin\\') || path.startsWith('C:\\LA\\Programs\\Git\\bin\\')
    assert.equal(grokGitBashSelection(roots, exists), 'C:\\PF\\Git\\bin\\bash.exe')
  })

  it('reports a mismatch when the first hit is a different installation', () => {
    const exists = (path: string) =>
      path.startsWith('C:\\PF\\Git\\bin\\') || path.startsWith('C:\\LA\\Programs\\Git\\bin\\')
    const chosen = 'C:\\LA\\Programs\\Git\\bin\\bash.exe'
    const verdict = grokBashSelection(roots, gitInstallationRoot(chosen), exists)
    assert.equal(verdict.selected, 'C:\\PF\\Git\\bin\\bash.exe')
    assert.equal(verdict.mismatch, true)
  })

  it('reports no mismatch when the first hit is the chosen installation', () => {
    const exists = (path: string) => path.startsWith('C:\\LA\\Programs\\Git\\bin\\')
    const chosen = 'C:\\LA\\Programs\\Git\\bin\\bash.exe'
    assert.equal(grokBashSelection(roots, gitInstallationRoot(chosen), exists).mismatch, false)
  })

  it('reports no mismatch when the CLI sees no Git Bash at all', () => {
    const verdict = grokBashSelection(roots, 'C:\\LA\\Programs\\Git', () => false)
    assert.equal(verdict.selected, undefined)
    assert.equal(verdict.mismatch, false)
  })
})

describe('Grok suite configuration', () => {
  it('keeps shell selection out of config.toml so existing profiles stay valid', () => {
    const config = grokConfiguration()
    expect(config).toContain('env_key = "OPL_GATEWAY_GROK_API_KEY"')
    expect(config).not.toContain('GROK_SHELL')
    expect(config).not.toMatch(/^\s*shell\s*=/mu)
    // The official CLI appends its own marker on first start, so the profile it
    // leaves behind is a second accepted layout, not an outside edit.
    expect(grokConfigurationWithCliMarker()).toBe(
      `${config}\n[marketplace]\ndefault_skills_installs_purged = true\n`,
    )
    expect(grokConfigLayouts()).toEqual([
      config,
      grokConfigurationWithCliMarker(),
      grokLegacyConfiguration(),
      `${grokLegacyConfiguration()}\n[marketplace]\ndefault_skills_installs_purged = true\n`,
    ])
  })
})

describe.skipIf(!windows || !conventionalInstall)('Grok Git Bash over the ACP transport', () => {
  it('makes the official CLI resolve Git Bash for the environment the adapter builds', async () => {
    const state = await mkdtemp(join(tmpdir(), 'opl-grok-bash-'))
    const env = {
      ...(await grokBashEnvironment(systemEnvironment())),
      GROK_HOME: join(state, 'grok-home'),
    }
    const child = spawn(process.execPath, [fixture, '--state', state], {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('fixture initialize timed out')), 20000)
        let out = ''
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk
          const line = out.split('\n').find((entry) => entry.includes('"id":1'))
          if (line) {
            clearTimeout(timer)
            resolve(line)
          }
        })
        child.on('error', reject)
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: 1, clientCapabilities: {} },
          }) + '\n',
        )
      })
      const initialize = JSON.parse(response).result
      // The official CLI advertises that it is a shell agent but never reports
      // which shell it picked, so nothing here may be treated as a readback.
      expect(initialize._meta.grokShell).toBe(true)
      expect(Object.keys(initialize._meta)).not.toContain('shell')

      const resolved = JSON.parse(await readFile(join(state, 'shell.json'), 'utf8'))
      expect(resolved.source).toBe(`override:${GROK_GIT_BASH}`)
      expect(existsSync(resolved.shell)).toBe(true)
      expect(gitInstallationRoot(resolved.shell)).toBe(gitInstallationRoot(resolveGitBashPath()))
    } finally {
      child.kill()
    }
  })
})
