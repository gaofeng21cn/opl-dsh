/** KimiCU stdio MCP bridge for native DSH Agent tools. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Fixed executable and MCP arguments verified by the OPL Framework contract. */
export const KIMI_CU_EXECUTABLE = '/Applications/KimiCU.app/Contents/MacOS/kimi-cu'
export const KIMI_CU_MCP_ARGS = ['mcp', '-s', 'user'] as const
declare const __OPL_SUITE_VERSION__: string
const suiteVersion =
  typeof __OPL_SUITE_VERSION__ === 'string' ? __OPL_SUITE_VERSION__ : 'development'
/** Bound a stalled companion call so the Agent can report it instead of waiting indefinitely. */
export const KIMI_CU_CALL_TIMEOUT_MS = 30_000

/** The original KimiCU tool vocabulary; the DSH bridge does not invent actions. */
export const KIMI_CU_TOOLS = [
  'list_apps',
  'list_windows',
  'get_window',
  'launch_app',
  'get_app_state',
  'get_window_state',
  'activate_window',
  'click',
  'type_text',
  'paste',
  'press_key',
  'scroll',
  'set_value',
  'perform_secondary_action',
  'select_text',
  'drag',
  'drag_paths',
  'debug_tap',
] as const

export type KimiCuAction = (typeof KIMI_CU_TOOLS)[number]

/** One JSON-RPC response frame from KimiCU. */
export interface KimiCuResponse {
  readonly id?: number
  readonly result?: unknown
  readonly error?: { readonly code?: number; readonly message?: string }
}

/** One MCP client attached to a single KimiCU process. */
export class KimiCuClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private exitError: Error | undefined
  private nextId = 1
  private buffer = ''
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
      signal?: AbortSignal
      abort?: () => void
    }
  >()

  constructor(
    private readonly executable = KIMI_CU_EXECUTABLE,
    private readonly args: readonly string[] = KIMI_CU_MCP_ARGS,
  ) {}

  /** Start the process and negotiate the protocol before accepting a tool call. */
  async start(): Promise<void> {
    if (this.child !== undefined) return
    if (this.exitError !== undefined) throw this.exitError
    if (!existsSync(this.executable))
      throw Error(`KimiCU 未安装或不可执行：${this.executable}。请先安装 KimiCU。`)
    const child = spawn(this.executable, [...this.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.read(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {})
    child.once('error', (error) => this.failAll(error))
    child.once('exit', (code, signal) => {
      this.exitError = Error(
        `KimiCU MCP 已退出（${signal === null ? `code ${String(code)}` : signal}）。请重启 KimiCU 服务后重试。`,
      )
      this.failAll(this.exitError)
      this.child = undefined
    })
    await this.request(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'opl-dsh', version: suiteVersion },
      },
      10_000,
    )
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
  }

  /** Close the owned MCP process and settle every pending request. */
  async close(): Promise<void> {
    this.failAll(Error('KimiCU MCP 已关闭'))
    const child = this.child
    this.child = undefined
    if (child === undefined || child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** Call one original KimiCU tool and return its unmodified result. */
  async call(action: KimiCuAction, args: unknown, signal: AbortSignal): Promise<unknown> {
    await this.start()
    if (signal.aborted) throw Error('KimiCU 调用已取消')
    let result: unknown
    try {
      result = await this.request(
        'tools/call',
        { name: action, arguments: args },
        KIMI_CU_CALL_TIMEOUT_MS,
        signal,
      )
    } catch (error) {
      if (signal.aborted) throw Error('KimiCU 调用已取消')
      throw error
    }
    if (isRecord(result) && result.isError === true) {
      const failure = kimiCuResult(result)
      throw Error(failure.text || 'KimiCU 操作失败')
    }
    return result
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.child === undefined) return Promise.reject(Error('KimiCU MCP 尚未启动'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.write({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason: 'timeout' },
        })
        reject(
          Error(
            method === 'tools/call'
              ? `KimiCU 操作在 ${String(KIMI_CU_CALL_TIMEOUT_MS / 1000)} 秒内没有响应；请检查 KimiCU 服务和系统权限，修复后重新观察，不要自动重试。`
              : `KimiCU ${method} 超时`,
          ),
        )
      }, timeoutMs)
      const abort = (): void => {
        const entry = this.pending.get(id)
        if (entry === undefined) return
        clearTimeout(entry.timer)
        this.pending.delete(id)
        this.write({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason: 'cancelled' },
        })
        reject(Error('KimiCU 调用已取消'))
      }
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        ...(signal === undefined ? {} : { signal }),
        ...(signal === undefined ? {} : { abort }),
      })
      signal?.addEventListener('abort', abort, { once: true })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private write(value: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private read(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line === '') continue
      let response: KimiCuResponse
      try {
        response = JSON.parse(line) as KimiCuResponse
      } catch {
        continue
      }
      if (typeof response.id !== 'number') continue
      const pending = this.pending.get(response.id)
      if (pending === undefined) continue
      clearTimeout(pending.timer)
      pending.signal?.removeEventListener('abort', pending.abort!)
      this.pending.delete(response.id)
      if (response.error !== undefined)
        pending.reject(Error(response.error.message ?? 'KimiCU MCP 请求失败'))
      else pending.resolve(response.result)
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.signal?.removeEventListener('abort', pending.abort!)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

/** Stable, user-facing description of a KimiCU MCP result. */
export function kimiCuResult(value: unknown): {
  text: string
  isError: boolean
  images: readonly { mediaType: 'image/png' | 'image/jpeg'; data: Uint8Array; name?: string }[]
} {
  const result = isRecord(value) ? value : {}
  const images: { mediaType: 'image/png' | 'image/jpeg'; data: Uint8Array; name?: string }[] = []
  const text: string[] = []
  const content = Array.isArray(result.content) ? result.content : []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text)
    if (block.type === 'image') {
      const data = typeof block.data === 'string' ? block.data : undefined
      const mediaType = block.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
      if (data !== undefined)
        images.push({
          mediaType,
          data: Uint8Array.from(Buffer.from(data, 'base64')),
          name: `kimi-cu-${images.length + 1}.${mediaType === 'image/png' ? 'png' : 'jpg'}`,
        })
    }
  }
  if (text.length === 0 && result.structuredContent !== undefined)
    text.push(JSON.stringify(result.structuredContent))
  if (text.length === 0 && result.isError !== true) text.push(JSON.stringify(result))
  return { text: text.join('\n'), isError: result.isError === true, images }
}

/** Append local service diagnosis without hiding the companion's own error. */
export function kimiCuFailure(value: unknown, executable = KIMI_CU_EXECUTABLE): string {
  const result = kimiCuResult(value)
  const message = result.text || 'KimiCU 操作失败'
  if (!/service unavailable|invalidated from this process|EX_CONFIG/iu.test(message)) return message
  const status = spawnSync(executable, ['service-status'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  })
  const detail = `${status.stdout ?? ''}\n${status.stderr ?? ''}`.trim()
  return detail === '' ? message : `${message}\n\nKimiCU service-status：${detail}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
