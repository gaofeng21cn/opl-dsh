/** Shared `--mode rpc` child process & ACP stdio lifecycle base for Pi and Step bridges. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import {
  AcpJsonRpcChannel,
  attachLfLineReader,
  type AcpWireMessage,
  type LineReaderHandle,
} from '../acp-stdio.ts'

/** Typed bridge error mapped onto the host ACP transport failure vocabulary. */
export class RpcBridgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message)
  }
}

/** Construct a configuration refusal that maps onto standard JSON-RPC `-32602`. */
export function rpcConfigurationError(message: string): RpcBridgeError {
  return new RpcBridgeError(message, 'HARNESS_CONFIG')
}

/**
 * Classify a bridge failure into the error code the host's ACP transport understands.
 *
 * Configuration refusals use standard JSON-RPC `-32602`; provider and timeout failures
 * preserve their typed `HARNESS_*` codes so `src/execution/host/acp.ts` surfaces the
 * right user-facing failure category.
 */
export function rpcAcpErrorCode(error: unknown): string | number {
  if (!(error instanceof RpcBridgeError)) return -32603
  switch (error.code) {
    case 'HARNESS_CONFIG':
      return -32602
    case 'HARNESS_TIMEOUT':
      return 'HARNESS_TIMEOUT'
    case 'HARNESS_PROVIDER':
    case 'HARNESS_PROVIDER_CLIENT_REQUIRED':
    case 'HARNESS_PROVIDER_AUTH':
    case 'HARNESS_PROVIDER_MODEL':
    case 'HARNESS_PROVIDER_RATE_LIMIT':
    case 'HARNESS_PROVIDER_RETIRED':
    case 'HARNESS_PROVIDER_ROUTE':
    case 'HARNESS_PROVIDER_TIMEOUT':
    case 'HARNESS_PROVIDER_NETWORK':
      return error.code
    case 'HARNESS_TRANSPORT':
      return 'HARNESS_NETWORK'
    default:
      return -32603
  }
}

/** Remove an owned credential from any text that can reach the host, a log, or an error. */
export function redactCredential(text: string, credential: string): string {
  return credential ? text.split(credential).join('[redacted]') : text
}

/** Configuration for spawning and driving a Pi/Step `--mode rpc` CLI child process. */
export interface RpcModeProcessOptions {
  readonly label: string
  readonly onLine: (line: string) => void
  readonly onExit: (reason: string) => void
  readonly onStderr?: (text: string) => void
}

/** Correlated `--mode rpc` child-process transport using strict LF-only framing. */
export class RpcModeProcess {
  private child: ChildProcessWithoutNullStreams | undefined
  private lineReader: LineReaderHandle | undefined
  private seq = 0
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()

  constructor(private readonly options: RpcModeProcessOptions) {}

  get running(): boolean {
    return this.child !== undefined
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  spawn(
    command: string,
    args: readonly string[],
    spawnOptions: {
      cwd: string
      env: NodeJS.ProcessEnv
      windowsVerbatimArguments?: boolean
    },
  ): ChildProcessWithoutNullStreams {
    const child = spawn(command, [...args], {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(spawnOptions.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    })
    this.child = child
    this.lineReader = attachLfLineReader(child.stdout, (line) => this.options.onLine(line))
    child.stderr.on('data', (chunk: Buffer) => {
      this.options.onStderr?.(chunk.toString('utf8'))
    })
    child.stdin.on('error', () => {
      if (this.child === child) this.closeHandle(`${this.options.label} 输入通道已关闭`)
    })
    child.on('error', () => {
      if (this.child === child) this.closeHandle(`无法启动${this.options.label}`)
    })
    child.on('exit', () => {
      if (this.child === child) this.closeHandle(`${this.options.label}进程已退出`)
    })
    return child
  }

  /** Match a `response` frame back to its awaiting {@link request} call. */
  resolveResponse(frame: { id?: unknown }): boolean {
    const id = typeof frame.id === 'number' ? frame.id : Number(frame.id)
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    entry.resolve(frame)
    return true
  }

  /** Send one official RPC command and await its correlated `response`. */
  request(type: string, extra: Record<string, unknown> = {}, timeoutMs = 60000): Promise<any> {
    if (!this.child) throw rpcConfigurationError(`${this.options.label}进程未启动`)
    const id = ++this.seq
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id))
          reject(
            new RpcBridgeError(
              `${this.options.label}未在 ${timeoutMs}ms 内回应 ${type}`,
              'HARNESS_TIMEOUT',
            ),
          )
      }, timeoutMs)
      this.pending.set(id, {
        timer,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.child!.stdin.write(JSON.stringify({ id, type, ...extra }) + '\n')
    })
  }

  /** Issue a command that must be accepted (`success: true`). */
  async command(
    type: string,
    extra: Record<string, unknown> = {},
    timeoutMs = 60000,
  ): Promise<any> {
    const response = await this.request(type, extra, timeoutMs)
    if (response?.success !== true)
      throw rpcConfigurationError(`${this.options.label}拒绝了 ${type}，已停止，未继续会话。`)
    return response.data
  }

  /** Write a raw JSON frame (such as `extension_ui_response`) to child stdin. */
  writeFrame(frame: Record<string, unknown>): void {
    this.child?.stdin.write(JSON.stringify(frame) + '\n')
  }

  failPending(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new RpcBridgeError(reason, 'HARNESS_TRANSPORT'))
    }
    this.pending.clear()
  }

  /** Release the child handle synchronously without awaiting exit. */
  release(reason: string): void {
    this.lineReader?.close()
    this.lineReader = undefined
    const previous = this.child
    this.child = undefined
    this.failPending(reason)
    previous?.kill('SIGTERM')
  }

  /** Terminate the child process and await exit up to `timeoutMs`. */
  async shutdown(reason: string, timeoutMs = 5000): Promise<void> {
    this.lineReader?.close()
    this.lineReader = undefined
    const running = this.child
    this.child = undefined
    this.failPending(reason)
    if (!running || running.exitCode !== null || running.signalCode !== null) return
    const exited = new Promise<void>((done) => running.once('exit', () => done()))
    running.kill('SIGTERM')
    await Promise.race([exited, new Promise<void>((done) => setTimeout(done, timeoutMs))])
  }

  private closeHandle(reason: string): void {
    this.lineReader?.close()
    this.lineReader = undefined
    this.child = undefined
    this.failPending(reason)
    this.options.onExit(reason)
  }
}

/** Run the shared ACP stdio loop over `AcpJsonRpcChannel` for a Pi or Step bridge. */
export function startRpcModeAcpServer(options: {
  readonly invoke: (method: string, params: Record<string, unknown>) => Promise<unknown>
  readonly onPermissionResponse: (id: string, outcome: unknown) => void
  readonly onInputEnd?: () => void
  readonly redact: (text: string) => string
  readonly defaultErrorMessage: string
  readonly diagnosticsEnv?: string
  readonly diagnosticsFileEnv?: string
}): AcpJsonRpcChannel {
  const channel = new AcpJsonRpcChannel(process.stdin, process.stdout, {
    ignoreNonJson: true,
    onClose: () => options.onInputEnd?.(),
    onMessage: (message: AcpWireMessage) => {
      const method = typeof message.method === 'string' ? message.method : undefined
      const id = message.id
      if (!method && typeof id === 'string') {
        const result =
          message.result && typeof message.result === 'object'
            ? (message.result as { outcome?: unknown })
            : undefined
        options.onPermissionResponse(id, result?.outcome)
        return
      }
      if (!method) return
      const params =
        message.params && typeof message.params === 'object' && !Array.isArray(message.params)
          ? (message.params as Record<string, unknown>)
          : {}
      void (async () => {
        try {
          const result = await options.invoke(method, params)
          if (id !== undefined) channel.respond(id as string | number | null, result)
        } catch (error) {
          const code = rpcAcpErrorCode(error)
          const redactedMessage = options.redact(
            error instanceof Error ? error.message : options.defaultErrorMessage,
          )
          if (id !== undefined) {
            channel.respondError(
              id as string | number | null,
              code,
              redactedMessage,
              error instanceof RpcBridgeError ? error.data : undefined,
            )
          }
          if (options.diagnosticsEnv && process.env[options.diagnosticsEnv] === '1') {
            const entry = JSON.stringify({
              method,
              error: options.redact(error instanceof Error ? error.message : 'failure'),
            })
            process.stderr.write(entry + '\n')
            const sink = options.diagnosticsFileEnv
              ? process.env[options.diagnosticsFileEnv]
              : undefined
            if (sink) {
              try {
                appendFileSync(sink, entry + '\n')
              } catch {
                // Diagnostics must never fail a call.
              }
            }
          }
        }
      })()
    },
  })
  return channel
}
