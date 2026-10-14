/**
 * Types for the Bash MCP server.
 *
 * The server is a hand-shipped ESM process rather than a TypeScript module, because the
 * official CLI spawns it directly and compiling it would add a shared build entry for
 * no gain. These declarations give the tests and any future TypeScript caller the same
 * typed surface the runtime actually exports.
 */

/** One executed command, as the tool reports it. */
export interface MuseBashResult {
  /** Present instead of the outcome fields when the call was refused before spawning. */
  refused?: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  cancelled: boolean
  /**
   * Whether the awaited kill sequence completed without error. Only meaningful when
   * `timedOut` or `cancelled` is set; read after awaiting the call, never before.
   */
  killConfirmed: boolean
  command: string
  cwd: string
  shell: string
  stdout: string
  stderr: string
  truncatedBytes: number
}

/** Inputs the tool accepts; every field but `command` is optional. */
export interface MuseBashParams {
  command: string
  cwd?: string
  timeoutMs?: number
  stdin?: string
  maxOutputBytes?: number
}

/**
 * Cancellation handle for one tool call.
 *
 * `cancel()` kills that call's process tree; the call's promise only settles once the
 * child has closed, so awaiting the result is itself the proof the command is gone.
 */
export class CancellationControl {
  cancelled: boolean
  attach(child: unknown): void
  detach(): void
  isCancelled(): boolean
  onCancel(listener: () => void): void
  cancel(): void
}

/** The interpreter ran as an MSYS shell. */
export const EXIT_OK = 0
/** No usable interpreter was configured; the server served nothing. */
export const EXIT_NO_BASH = 3
/** The stdio stream carried something that was not JSON-RPC. */
export const EXIT_PROTOCOL = 4

export function runBashCommand(
  params: MuseBashParams,
  env?: NodeJS.ProcessEnv,
  control?: CancellationControl,
): Promise<MuseBashResult>
export function main(): Promise<void>
