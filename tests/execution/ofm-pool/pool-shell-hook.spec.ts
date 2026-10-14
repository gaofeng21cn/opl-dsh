/**
 * The shipped hook program, executed for real.
 *
 * These tests run the exact file content `poolShellHookSource()` produces with
 * this repository's Node runtime, because the official hook service fails open:
 * a hook that cannot start, or that returns the wrong decision, silently leaves
 * the model's own interpreter in place. The property under test is therefore
 * behaviour, not shape.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveGitBashPath } from '../../../src/shell/host/git-bash.ts'
import { scratchRoot } from './fixtures/records.ts'
import {
  POOL_AUDIT_MAX_BYTES,
  POOL_GIT_BASH_ARGS,
  POOL_HOOK_COMMAND_NAME,
  POOL_SHELL_ARGS_VARIABLE,
  POOL_SHELL_AUDIT_VARIABLE,
  POOL_SHELL_HOOK_NAME,
  POOL_SHELL_VARIABLE,
  poolSettings,
  poolShellHookSource,
} from '../../../src/execution/host/adapters/pool/index.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function hookProgram(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(scratchRoot(), 'opl-pool-hook-'))
  dirs.push(dir)
  const file = join(dir, 'pool-shell-hook.mjs')
  await writeFile(file, poolShellHookSource(), 'utf8')
  return { dir, file }
}

interface HookResult {
  code: number
  stdout: string
  stderr: string
}

function runHook(file: string, env: NodeJS.ProcessEnv, payload: unknown): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, ...env },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.end(JSON.stringify(payload))
  })
}

const preToolUse = (toolInput: unknown) => ({
  hook_api_version: '1.0',
  hook_event_name: 'PreToolUse',
  event_id: 'event-1',
  session_id: 'session-1',
  tool_name: 'shell',
  tool_input: toolInput,
  tool_call_id: 'call-1',
})

const pinnedEnv = (over: NodeJS.ProcessEnv = {}) => ({
  [POOL_SHELL_VARIABLE]: resolveGitBashPath().replace(/\\/gu, '/'),
  [POOL_SHELL_ARGS_VARIABLE]: JSON.stringify(POOL_GIT_BASH_ARGS),
  ...over,
})

describe('pool PreToolUse interpreter pin', () => {
  it('rewrites the interpreter of a call that chose none', async () => {
    const { file } = await hookProgram()
    const result = await runHook(
      file,
      pinnedEnv(),
      preToolUse({ cmd: 'uname -s', mode: 'foreground' }),
    )
    expect(result.code).toBe(0)
    const decision = JSON.parse(result.stdout)
    expect(decision.hook_specific_output.updated_input).toEqual({
      cmd: 'uname -s',
      mode: 'foreground',
      shell: resolveGitBashPath().replace(/\\/gu, '/'),
      shell_args: [...POOL_GIT_BASH_ARGS],
    })
  })

  it('overrides an interpreter the model picked for itself', async () => {
    const { file } = await hookProgram()
    const result = await runHook(
      file,
      pinnedEnv(),
      preToolUse({
        cmd: 'echo hi',
        shell: 'powershell.exe',
        shell_args: ['-NoProfile', '-Command'],
      }),
    )
    const updated = JSON.parse(result.stdout).hook_specific_output.updated_input
    expect(updated.shell).not.toBe('powershell.exe')
    expect(updated.shell).toBe(resolveGitBashPath().replace(/\\/gu, '/'))
  })

  it('preserves the working directory, environment and mode the model asked for', async () => {
    const { file } = await hookProgram()
    const result = await runHook(
      file,
      pinnedEnv(),
      preToolUse({ cmd: 'pwd', cwd: 'C:/work 中文 空格', env: { A: '1' }, mode: 'background' }),
    )
    const updated = JSON.parse(result.stdout).hook_specific_output.updated_input
    expect(updated.cwd).toBe('C:/work 中文 空格')
    expect(updated.env).toEqual({ A: '1' })
    expect(updated.mode).toBe('background')
  })

  it('blocks instead of falling back when Git Bash is absent', async () => {
    const { file } = await hookProgram()
    const result = await runHook(
      file,
      pinnedEnv({ [POOL_SHELL_VARIABLE]: 'C:/uninstalled/opl-bash.exe' }),
      preToolUse({ cmd: 'echo hi' }),
    )
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('no fallback to PowerShell, CMD or WSL')
    expect(result.stderr).toContain('C:/uninstalled/opl-bash.exe')
  })

  it('blocks when the launch forgot to pin an interpreter at all', async () => {
    const { file } = await hookProgram()
    const result = await runHook(file, {}, preToolUse({ cmd: 'echo hi' }))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('refusing to run the tool on an unpinned interpreter')
  })

  it('blocks when the pinned argv is not a JSON string array', async () => {
    const { file } = await hookProgram()
    const result = await runHook(
      file,
      pinnedEnv({ [POOL_SHELL_ARGS_VARIABLE]: '{oops' }),
      preToolUse({ cmd: 'x' }),
    )
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('not a JSON string array')
  })

  it('stays silent for anything that is not a shell call', async () => {
    const { file } = await hookProgram()
    for (const payload of [
      { ...preToolUse({ cmd: 'echo hi' }), hook_event_name: 'PostToolUse' },
      preToolUse('not-an-object'),
      preToolUse([1, 2, 3]),
      { hook_event_name: 'PreToolUse' },
    ]) {
      const result = await runHook(file, pinnedEnv(), payload)
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('')
    }
  })

  it('leaves no decision behind for malformed input instead of guessing', async () => {
    const { file } = await hookProgram()
    const result = await new Promise<HookResult>((resolve) => {
      const child = spawn(process.execPath, [file], { env: pinnedEnv(), windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
      child.stdin.end('{not json')
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('records one bounded audit line per rewrite and never the command text', async () => {
    const { dir, file } = await hookProgram()
    const audit = join(dir, 'audit.ndjson')
    await runHook(
      file,
      pinnedEnv({ [POOL_SHELL_AUDIT_VARIABLE]: audit }),
      preToolUse({ cmd: 'curl -H "Authorization: Bearer secret"', shell: 'pwsh' }),
    )
    const line = JSON.parse((await readFile(audit, 'utf8')).trim())
    expect(line).toMatchObject({
      tool_call_id: 'call-1',
      shell: resolveGitBashPath().replace(/\\/gu, '/'),
      shell_args: [...POOL_GIT_BASH_ARGS],
      rewrote: true,
    })
    expect(JSON.stringify(line)).not.toContain('secret')

    await writeFile(audit, 'x'.repeat(POOL_AUDIT_MAX_BYTES + 1), 'utf8')
    await runHook(
      file,
      pinnedEnv({ [POOL_SHELL_AUDIT_VARIABLE]: audit }),
      preToolUse({ cmd: 'again' }),
    )
    const rotated = await readFile(audit, 'utf8')
    expect(rotated.length).toBeLessThan(POOL_AUDIT_MAX_BYTES)
  })

  it('never writes an audit trail when no audit path is configured', async () => {
    const { file } = await hookProgram()
    const result = await runHook(file, pinnedEnv(), preToolUse({ cmd: 'echo hi' }))
    expect(result.code).toBe(0)
  })
})

describe('pool settings file', () => {
  it('registers the shell matcher with a command cmd can start', () => {
    const settings = poolSettings(POOL_HOOK_COMMAND_NAME)
    expect(settings).toContain('hooks:')
    expect(settings).toContain('PreToolUse:')
    expect(settings).toContain(`name: ${POOL_SHELL_HOOK_NAME}`)
    expect(settings).toContain('matcher: shell')
    // A quoted path is what the official `cmd /c` runner cannot start; the bare
    // name is resolved through the PATH this adapter owns.
    expect(settings).toContain(`command: '${POOL_HOOK_COMMAND_NAME}'`)
    expect(settings).not.toContain('\\\\')
  })

  it('keeps backslashes literal in a POSIX command path', () => {
    expect(poolSettings('"/opt/opl/pool-shell-hook.mjs"')).toContain(
      `command: '"/opt/opl/pool-shell-hook.mjs"'`,
    )
  })

  it('escapes an embedded quote so the YAML value survives the parser', () => {
    expect(poolSettings("it's")).toContain(`command: 'it''s'`)
  })
})
