/** Copilot is a text writer only: isolated home, no tools, no repository write token. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execute = promisify(execFile)
export async function runCopilotReleaseNotes(prompt, token) {
  const home = await mkdtemp(join(tmpdir(), 'opl-dsh-copilot-notes-'))
  try {
    const env = { HOME: home, XDG_CONFIG_HOME: home, GITHUB_TOKEN: token }
    for (const name of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'LANG', 'NODE_EXTRA_CA_CERTS'])
      if (process.env[name]) env[name] = process.env[name]
    const result = await execute(
      'copilot',
      [
        '--model',
        'auto',
        '--prompt',
        prompt,
        '--silent',
        '--deny-tool=*',
        '--disable-builtin-mcps',
        '--no-custom-instructions',
        '--no-ask-user',
        '--no-auto-update',
        '--no-remote',
        '--no-remote-export',
        '--log-level',
        'none',
        '--max-ai-credits',
        '1',
      ],
      { cwd: home, env, timeout: 90000, maxBuffer: 128 * 1024, killSignal: 'SIGKILL' },
    )
    return result.stdout.trim()
  } catch (error) {
    const diagnostic = String(error.stderr ?? '')
    const code = error.killed
      ? 'copilot_timeout'
      : /quota|rate.limit|credits.*exhaust|insufficient.*credits/i.test(diagnostic)
        ? 'copilot_quota'
        : /max.ai.credits|session.*limit|budget/i.test(diagnostic)
          ? 'copilot_session_budget'
          : /authenticat|sign.in|log.in|invalid.token|unauthorized|403/i.test(diagnostic)
            ? 'copilot_authentication'
            : error.code === 'ENOENT'
              ? 'copilot_not_installed'
              : 'copilot_transport_or_cli'
    const failure = new Error(code)
    failure.code = code
    throw failure
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
