import { realpathSync } from 'node:fs'
import { normalize } from 'node:path'
import { createHash } from 'node:crypto'
import type { AcpProcess } from './acp.ts'
import type { AdapterLaunch } from './adapters/types.ts'
import type { ExternalEditHistory } from './message-edit-driver.ts'
import type { HarnessExternalAsk } from './external-binding.ts'
import type { ProgressWatchdog } from './progress-watchdog.ts'
import type { VibeTurnUsageTracker } from './usage-vibe.ts'
import type { QwenTurnUsage } from './adapters/qwen/usage.ts'
import type { HarnessApproval, HarnessTurn } from '../contracts/sessions.ts'

export const asSessionId = <T extends string>(value: string) => value as T
export const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const now = () => new Date().toISOString()
export const required = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200000)
    throw Error(`无效的 ${label}`)
  return value
}

export interface HarnessPromptRequest {
  sessionId: string
  text: string
  operationId: string
  writeScope?: string[]
}

export interface Active {
  provisional?: boolean
  editLaunch?: AdapterLaunch
  editHistory?: ExternalEditHistory
  mcpServers?: unknown[]
  createdSession?: boolean
  contextUsage?: import('../contracts/usage.ts').HarnessContextUsage
  contextWindowRecorded?: number
  vibeUsage?: VibeTurnUsageTracker
  qwenUsage?: QwenTurnUsage
  watchdog?: ProgressWatchdog
  deadlineError?: string
  deadlineCleanup?: Promise<void>

  acp?: AcpProcess
  turn: HarnessTurn | undefined
  done: Promise<void> | undefined
  cancelled: boolean
  /**
   * Monotonic generation of this connection, assigned when the connection is
   * opened. A reconnected Harness gets a new generation, so an approval binding
   * taken on one connection can never authorize an action on another.
   */
  generation: number
  bridgeStop?: (() => Promise<void>) | undefined
  approvals: Map<
    string,
    HarnessApproval & {
      rpcId: string | number
      external?: HarnessExternalAsk
      reviewCallId?: string
    }
  >
  /** `initialize` result, kept for adapter capability and version diagnostics. */
  agentInfo?: Record<string, any>
  /** Actual `session/new` or `session/load` response owned by this connection. */
  sessionInfo?: Record<string, any>
  /** Latest config options the agent advertised for this ACP session. */
  configOptions?: unknown
  /** Catalog launch settings used by this connection, compared before the next turn. */
  launchSettings?: string
}

export interface SelectionChangeState {
  promise: Promise<void>
  failed: boolean
  error?: unknown
}

const workingDirectoryKey = (path: string) => {
  const normalized = normalize(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function sameWorkingDirectory(left: string, right: string): boolean {
  if (workingDirectoryKey(left) === workingDirectoryKey(right)) return true
  // Harness records store the resolved path, while the official projection
  // can retain a symlink or junction to that same directory.
  try {
    return (
      workingDirectoryKey(realpathSync.native(left)) ===
      workingDirectoryKey(realpathSync.native(right))
    )
  } catch {
    return false
  }
}
