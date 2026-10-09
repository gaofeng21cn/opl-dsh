import type { Context } from '@deepseek-ai/cordis'
import type { HarnessSession } from '../../contracts/sessions.ts'
import type { ModelRef } from '../../contracts/catalog.ts'
export interface AdapterOptions {
  home: string
  command?: string
  prefix?: string[]
  resolveKey?: () => Promise<string | undefined>
  grokCommand: string
  nativeBridgePath: string
  /** Dedicated ACP projection for the official ZCode app-server protocol. */
  zcodeBridgePath?: string
}
export interface AdapterLaunch {
  home: string
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  /**
   * Hand the argument vector to the OS verbatim. Required for `cmd.exe` wrappers:
   * Node's default Windows escaping turns the quotes around a script path into
   * `\"`, which cmd.exe reads as literal backslashes and never resolves.
   */
  windowsVerbatimArguments?: boolean
}
/** The subset of the ACP transport an adapter may drive to pin its session. */
export interface AcpRequestSurface {
  request(method: string, params: object, timeoutMs?: number): Promise<unknown>
}
export interface AcpSessionSnapshot {
  /** Result of `initialize`, used for capability and version diagnostics. */
  readonly agent: Record<string, any>
  /** Result of `session/new` or `session/load`. */
  readonly session: Record<string, any>
  /** Most recently advertised config options, including `config_option_update`. */
  readonly configOptions: unknown
}
export interface AcpSessionConfigureResult {
  /** Config options advertised after pinning; the caller keeps them for later checks. */
  configOptions?: unknown
}
export interface HarnessAdapter {
  id: string
  transport: 'dsh' | 'acp'
  matches(ref: ModelRef): boolean
  available(ctx: Context, options: AdapterOptions): Promise<{ available: boolean; reason?: string }>
  prepare?(ctx: Context, record: HarnessSession, options: AdapterOptions): Promise<AdapterLaunch>
  /**
   * Pin the combination's fixed model and reasoning parameters over ACP. Runs after
   * `session/new` or `session/load` and before any prompt is sent. An adapter must
   * throw when the agent does not advertise the required values: a silent downgrade
   * to a different model or effort is never acceptable.
   */
  configureSession?(
    acp: AcpRequestSurface,
    record: HarnessSession,
    snapshot: AcpSessionSnapshot,
  ): Promise<AcpSessionConfigureResult | void>
  /**
   * Re-check the pinned parameters against the latest advertised options without
   * writing. Runs before every prompt so a session that drifted fails closed.
   */
  verifySession?(record: HarnessSession, snapshot: AcpSessionSnapshot): void
}
