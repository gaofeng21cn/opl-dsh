import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { OplFlowAvailability } from '../contracts/index.ts'

export interface ProbeOplFlowOptions {
  configPath?: string | undefined
  scriptPath?: string | undefined
  homeDir?: string | undefined
  pythonBin?: string | undefined
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Pure filesystem probe for local OPL Flow instance and contribution CLI.
 * Never spawns child processes or reads deleted v1 package CLI surfaces.
 */
export async function probeOplFlowControlPlane(
  options: ProbeOplFlowOptions = {},
): Promise<OplFlowAvailability> {
  const home = options.homeDir ?? homedir()
  const configPath =
    options.configPath ??
    asNonEmptyString(process.env.OPL_FLOW_CONFIG_PATH) ??
    join(home, '.config', 'opl-flow', 'instance.json')

  if (!(await isRegularFile(configPath))) {
    return { available: false, reason: 'instance.json not found' }
  }

  let parsedConfig: Record<string, unknown>
  try {
    const raw = await readFile(configPath, 'utf8')
    const decoded = JSON.parse(raw) as unknown
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return { available: false, reason: 'invalid instance.json format' }
    }
    parsedConfig = decoded as Record<string, unknown>
  } catch {
    return { available: false, reason: 'failed to read instance.json' }
  }

  const ledgerRoot =
    asNonEmptyString(parsedConfig.instance_root) ?? asNonEmptyString(parsedConfig.ledger_repo)
  if (!ledgerRoot || !(await isDirectory(ledgerRoot))) {
    return { available: false, reason: 'bound ledger directory does not exist' }
  }

  const defaultStateDirForHome = (homeRoot: string): string => {
    if (process.platform === 'darwin') {
      return join(homeRoot, 'Library', 'Application Support', 'OPL', 'state')
    }
    if (process.platform === 'win32') {
      const localAppData =
        asNonEmptyString(process.env.LOCALAPPDATA) ?? join(homeRoot, 'AppData', 'Local')
      return join(localAppData, 'OPL', 'state')
    }
    const xdgState =
      asNonEmptyString(process.env.XDG_STATE_HOME) ?? join(homeRoot, '.local', 'state')
    return join(xdgState, 'opl')
  }

  const envStateDir = asNonEmptyString(process.env.OPL_STATE_DIR)
  const envDataDir = asNonEmptyString(process.env.OPL_DATA_DIR)
  const v2StateDirs = [
    ...(envStateDir ? [resolve(envStateDir)] : []),
    ...(envDataDir ? [join(resolve(envDataDir), 'opl', 'state')] : []),
    defaultStateDirForHome(home),
  ]
  const v2ScriptCandidates: string[] = []
  const seenStateDirs = new Set<string>()
  for (const stateDir of v2StateDirs) {
    if (seenStateDirs.has(stateDir)) continue
    seenStateDirs.add(stateDir)
    const flowRoot = join(stateDir, 'packages', 'opl-flow')
    v2ScriptCandidates.push(join(flowRoot, 'current', 'scripts', 'opl_app_contribution.py'))
    if (await isDirectory(flowRoot)) {
      try {
        const entries = (await readdir(flowRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && entry.name !== 'current')
          .map((entry) => entry.name)
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        for (const versionDir of entries) {
          v2ScriptCandidates.push(join(flowRoot, versionDir, 'scripts', 'opl_app_contribution.py'))
        }
      } catch {
        // ignore unreadable package directory
      }
    }
  }

  const sourceRoot = asNonEmptyString(parsedConfig.source_root)
  const scriptCandidates = [
    options.scriptPath,
    asNonEmptyString(process.env.OPL_FLOW_CONTRIBUTION_SCRIPT),
    asNonEmptyString(parsedConfig.contribution_script),
    sourceRoot ? join(sourceRoot, 'scripts', 'opl_app_contribution.py') : undefined,
    ...v2ScriptCandidates,
    join(home, '.opl', 'packages', 'opl-flow', 'current', 'scripts', 'opl_app_contribution.py'),
    join(
      home,
      '.local',
      'share',
      'one-person-lab',
      'packages',
      'opl-flow',
      'current',
      'scripts',
      'opl_app_contribution.py',
    ),
    join(home, 'workspace', 'opl-flow', 'scripts', 'opl_app_contribution.py'),
  ].filter((candidate): candidate is string => Boolean(candidate))

  let resolvedScript: string | undefined
  for (const candidate of scriptCandidates) {
    if (await isRegularFile(candidate)) {
      resolvedScript = candidate
      break
    }
  }
  if (!resolvedScript) {
    return { available: false, reason: 'opl_app_contribution.py not found' }
  }

  const instanceName = asNonEmptyString(parsedConfig.instance_name)
  return {
    available: true,
    configPath,
    scriptPath: resolvedScript,
    ...(instanceName ? { instanceName } : {}),
  }
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export async function runOplFlowContribution<T = Record<string, unknown>>(
  command: 'dashboard' | 'send' | 'approve' | 'tick' | 'service',
  payload: object,
  options: ProbeOplFlowOptions = {},
): Promise<T> {
  const avail = await probeOplFlowControlPlane(options)
  if (!avail.available || !avail.scriptPath) {
    throw new Error(avail.reason ?? 'OPL Flow control plane is unavailable')
  }
  const pythonBin = options.pythonBin ?? process.env.OPL_FLOW_PYTHON ?? 'python3'
  const stdoutText = await new Promise<string>((resolve, reject) => {
    const child = spawn(pythonBin, [avail.scriptPath!, command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(avail.configPath ? { OPL_FLOW_CONFIG_PATH: avail.configPath } : {}),
      },
    })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`OPL Flow command '${command}' timed out`))
    }, 15_000)

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        let msg = stderr.trim()
        if (!msg && stdout.trim()) {
          try {
            const errJson = JSON.parse(stdout) as { error?: { message?: string } }
            if (errJson?.error?.message) msg = errJson.error.message
          } catch {
            // ignore non-JSON stdout
          }
        }
        reject(new Error(msg || `OPL Flow command '${command}' failed (exit ${code})`))
        return
      }
      resolve(stdout)
    })
    child.stdin.end(JSON.stringify(payload))
  })

  const parsed = JSON.parse(stdoutText) as Record<string, unknown>
  const envelope = parsed.opl_app_contribution as
    { response?: { ok?: boolean; error?: { message?: string }; result?: unknown } } | undefined
  if (envelope?.response) {
    if (envelope.response.ok === false) {
      throw new Error(envelope.response.error?.message ?? `OPL Flow '${command}' returned error`)
    }
    if ('result' in envelope.response) {
      return envelope.response.result as T
    }
  }
  return parsed as T
}
