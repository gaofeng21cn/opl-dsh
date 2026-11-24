import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { commandLaunch, executablePath } from './harness-registry.ts'

const exec = promisify(execFile)

/** The configured CLI reports the levels for each exact model without starting a conversation. */
export class CodexEfforts {
  private cached?: { key: string; until: number; levels: Promise<Map<string, string[]>> }
  async read(command: string, prefix: readonly string[]): Promise<Map<string, string[]>> {
    const key = JSON.stringify([command, prefix])
    if (this.cached?.key === key && this.cached.until > Date.now()) return this.cached.levels
    const levels = this.query(command, prefix).catch(() => new Map<string, string[]>())
    const entry = { key, until: Date.now() + 300_000, levels }
    this.cached = entry
    if (!(await levels).size) entry.until = Date.now() + 10_000
    return levels
  }
  private async query(command: string, prefix: readonly string[]) {
    const path = await executablePath(command, 'codex')
    const levels = new Map<string, string[]>()
    if (!path) return levels
    const launch = commandLaunch(path, [...prefix, 'debug', 'models'])
    const { stdout } = await exec(launch.command, launch.args, {
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments ?? false,
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    })
    const { models } = JSON.parse(stdout)
    if (!Array.isArray(models)) return levels
    for (const model of models) {
      if (typeof model?.slug !== 'string' || !Array.isArray(model.supported_reasoning_levels))
        continue
      const ids: string[] = []
      for (const row of model.supported_reasoning_levels)
        if (
          typeof row?.effort === 'string' &&
          row.effort !== 'default' &&
          !ids.includes(row.effort)
        )
          ids.push(row.effort)
      levels.set(model.slug, ids)
    }
    return levels
  }
}
