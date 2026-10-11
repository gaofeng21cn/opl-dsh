/**
 * Executable ACP fixture reproducing the official Grok Build CLI 1.0.46 shell
 * selection exactly as it behaves on the wire, so the adapter is exercised over
 * the real stdio transport instead of against its own constants.
 *
 * Reproduced behavior, all confirmed against the installed binary at
 * `~/.grok/bin/grok.exe`:
 *  - `GROK_SHELL` is read from `xai_grok_config::shell`
 *    (`crates/codegen/xai-grok-config/src/shell.rs`) and accepts `bash`, `pwsh`,
 *    `powershell` and `cmd`.
 *  - Any other value is ignored: `... is not recognized (expected
 *    pwsh|powershell|bash|cmd); falling through to auto-detect`.
 *  - `bash` selects Git Bash and reports `Windows shell (GROK_SHELL override):
 *    Git Bash`, but when Git Bash is absent it logs `GROK_SHELL=bash but Git
 *    Bash not found; falling through to auto-detect` and keeps going. Both
 *    fallbacks are silent, which is why the adapter refuses to launch instead.
 *  - Auto-detect on Windows is `pwsh`, then
 *    `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, then Git Bash,
 *    then `powershell.exe` as a last resort. PowerShell therefore wins on a
 *    machine that has Git for Windows installed, which is the defect the adapter
 *    has to prevent.
 *  - Git Bash is only looked for under `ProgramFiles`, `ProgramFiles(x86)` and
 *    `LOCALAPPDATA`, as `Git\bin\bash.exe` and `Programs\Git\bin\bash.exe`.
 *    `PATH` and the `SHELL` variable are never consulted.
 *  - `initialize` advertises `_meta.grokShell`, but never reports which shell
 *    was chosen. There is no ACP readback to verify a session against, so the
 *    fixture does not invent one and the adapter does not wait for it.
 *
 * The resolution it computed is written to the state directory, which lets a
 * test assert that the shell the official CLI would really use is Git Bash.
 */
import { createInterface } from 'node:readline'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, win32 } from 'node:path'

const argv = process.argv.slice(2)
const argValue = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const state = argValue('--state', process.env.GROK_FIXTURE_STATE ?? process.cwd())
const journal = join(state, 'journal.ndjson')
const shellFile = join(state, 'shell.json')
const overrides = {
  pwsh: 'pwsh.exe',
  powershell: 'powershell.exe',
  bash: 'bash.exe',
  cmd: 'cmd.exe',
}

const gitBashCandidates = () =>
  [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter(Boolean)
    .flatMap((root) => [
      win32.join(root, 'Git', 'bin', 'bash.exe'),
      win32.join(root, 'Programs', 'Git', 'bin', 'bash.exe'),
    ])

/** Mirror of the official auto-detect order, used whenever the override fails. */
const autoDetect = () => {
  const gitBash = gitBashCandidates().find((candidate) => existsSync(candidate))
  const systemPowershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  if (existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe')) return 'pwsh'
  if (existsSync(systemPowershell)) return systemPowershell
  if (gitBash) return gitBash
  return 'powershell.exe'
}

/** Mirror of `xai_grok_config::shell`, including both silent fallbacks. */
const resolveShell = () => {
  const requested = process.env.GROK_SHELL
  if (requested && Object.hasOwn(overrides, requested)) {
    if (requested !== 'bash')
      return { shell: overrides[requested], source: `override:${requested}` }
    const gitBash = gitBashCandidates().find((candidate) => existsSync(candidate))
    return gitBash
      ? { shell: gitBash, source: 'override:bash' }
      : { shell: autoDetect(), source: 'fallback:git-bash-missing' }
  }
  if (requested) return { shell: autoDetect(), source: 'fallback:unrecognized-value' }
  return { shell: autoDetect(), source: 'auto-detect' }
}

const send = (payload) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n')
const note = (entry) =>
  appendFile(journal, JSON.stringify({ at: Date.now(), ...entry }) + '\n').catch(() => {})

await mkdir(state, { recursive: true }).catch(() => {})
await writeFile(shellFile, JSON.stringify(resolveShell(), null, 2)).catch(() => {})

createInterface({ input: process.stdin }).on('line', async (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  await note({ method: message.method ?? 'response', id: message.id, params: message.params })
  if (message.method === 'initialize') {
    // The official `_meta` carries `grokShell: true` and no chosen shell, so the
    // fixture must not report one either.
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: 'grok-build', title: 'Grok Build', version: '1.0.46' },
        _meta: {
          grokShell: true,
          agentVersion: '1.0.46',
          'x.ai/mcp/sdk': true,
          currentWorkingDirectory: process.cwd(),
        },
      },
    })
  } else if (message.method === 'session/new' || message.method === 'session/load') {
    send({
      id: message.id,
      result: {
        sessionId: 'grok_bash_fixture',
        modes: { currentModeId: 'default', availableModes: [] },
        configOptions: [
          {
            id: 'reasoning_effort',
            type: 'select',
            name: 'Reasoning Effort',
            currentValue: 'high',
            options: ['low', 'medium', 'high', 'xhigh'].map((value) => ({ value, name: value })),
          },
          {
            type: 'select',
            id: 'model',
            name: 'Model',
            category: 'model',
            currentValue: 'grok-4.7',
            options: [{ value: 'grok-4.7', name: 'Grok 4.7' }],
          },
        ],
      },
    })
  } else if (message.method === 'session/prompt')
    send({ id: message.id, result: { stopReason: 'end_turn' } })
  else if (message.method === 'session/cancel') send({ id: message.id, result: {} })
  else if (message.id !== undefined && message.method === undefined)
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
})
