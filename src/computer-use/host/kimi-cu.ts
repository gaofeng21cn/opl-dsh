/** KimiCU stdio MCP bridge for native DSH Agent tools. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { windowsKimiCuLaunch, windowsKimiCuCall, type WinCuAction } from './windows.ts'

const LooseToolsListResultSchema = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })),
})

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

export type KimiCuAction = (typeof KIMI_CU_TOOLS)[number] | WinCuAction

/** One JSON-RPC response frame from KimiCU. */
export interface KimiCuResponse {
  readonly id?: number
  readonly result?: unknown
  readonly error?: { readonly code?: number; readonly message?: string }
}

function compactEnv(source: NodeJS.ProcessEnv, electronRunAsNode: boolean): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) result[key] = value
  }
  if (electronRunAsNode) result.ELECTRON_RUN_AS_NODE = '1'
  else delete result.ELECTRON_RUN_AS_NODE
  return result
}

/** One MCP client attached to a single KimiCU process. */
export class KimiCuClient {
  private client: Client | undefined
  private transport: StdioClientTransport | undefined
  private exitError: Error | undefined
  private starting: Promise<void> | undefined
  private closed = false
  private readonly launch: {
    executable: string
    args: readonly string[]
    cwd?: string
    env?: NodeJS.ProcessEnv
    codeMode?: boolean
  }

  constructor(
    executable?: string,
    args: readonly string[] = KIMI_CU_MCP_ARGS,
    options: { cwd?: string; env?: NodeJS.ProcessEnv; codeMode?: boolean } = {},
  ) {
    this.launch =
      executable === undefined && process.platform === 'win32'
        ? windowsKimiCuLaunch()
        : { executable: executable ?? KIMI_CU_EXECUTABLE, args, ...options }
  }

  /** Start the process and negotiate the protocol before accepting a tool call. */
  async start(): Promise<void> {
    if (this.closed) throw Error('KimiCU MCP 已关闭')
    if (!this.starting) this.starting = this.initialize()
    return this.starting
  }

  private async initialize(): Promise<void> {
    if (this.exitError !== undefined) throw this.exitError
    const { executable, args, cwd, env } = this.launch
    if (!existsSync(executable))
      throw Error(`KimiCU 未安装或不可执行：${executable}。请先安装 KimiCU。`)
    const script = executable.endsWith('.mjs')
    const transport = new StdioClientTransport({
      command: script ? process.execPath : executable,
      args: script ? [executable, ...args] : [...args],
      ...(cwd ? { cwd } : {}),
      env: compactEnv(env ?? process.env, script),
      stderr: 'pipe',
    })
    transport.stderr?.on('data', () => {})
    const client = new Client({ name: 'opl-dsh', version: suiteVersion })
    transport.onclose = () => {
      if (!this.closed && this.exitError === undefined) {
        this.exitError = Error('KimiCU MCP 已退出。请重启 KimiCU 服务后重试。')
      }
      this.client = undefined
      this.transport = undefined
    }
    transport.onerror = (error) => {
      if (this.exitError === undefined) this.exitError = error
    }
    this.transport = transport
    this.client = client
    try {
      await client.connect(transport, { timeout: 10_000 })
      if (this.launch.codeMode) {
        const listed = await client.request(
          { method: 'tools/list', params: {} },
          LooseToolsListResultSchema,
          { timeout: 10_000 },
        )
        if (!listed.tools.some((tool) => tool.name === 'js')) {
          await this.close()
          throw Error('Windows KimiCU 未广告已验证的 js 工具，未执行操作。')
        }
      }
    } catch (error) {
      await this.close().catch(() => {})
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        throw Error('KimiCU initialize 超时')
      }
      throw error
    }
  }

  /** Close the owned MCP process and settle every pending request. */
  async close(): Promise<void> {
    this.closed = true
    const client = this.client
    const transport = this.transport
    this.client = undefined
    this.transport = undefined
    try {
      if (client) await client.close()
      else if (transport) await transport.close()
    } catch {
      // Closing an already exited transport is a no-op.
    }
  }

  /** Call one original KimiCU tool and return its unmodified result. */
  async call(action: KimiCuAction, args: unknown, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw Error('KimiCU 调用已取消')
    await this.start()
    if (signal.aborted) throw Error('KimiCU 调用已取消')
    const client = this.client
    if (client === undefined) throw this.exitError ?? Error('KimiCU MCP 尚未启动')
    const payload = this.launch.codeMode
      ? windowsKimiCuCall(action, args)
      : {
          name: action,
          arguments: isRecord(args) ? args : {},
        }
    let result: unknown
    try {
      result = await client.callTool(payload, undefined, {
        timeout: KIMI_CU_CALL_TIMEOUT_MS,
        signal,
      })
    } catch (error) {
      if (signal.aborted) {
        void this.close()
        throw Error('KimiCU 调用已取消')
      }
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        void this.close()
        throw Error(
          `KimiCU 操作在 ${String(KIMI_CU_CALL_TIMEOUT_MS / 1000)} 秒内没有响应；请检查 KimiCU 服务和系统权限，修复后重新观察，不要自动重试。`,
        )
      }
      throw error
    }
    if (isRecord(result) && result.isError === true) {
      const failure = kimiCuResult(result)
      throw Error(failure.text || 'KimiCU 操作失败')
    }
    return result
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
  if (
    process.platform === 'win32' ||
    !/service unavailable|invalidated from this process|EX_CONFIG/iu.test(message)
  )
    return message
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

export const KIMI_CU_PLUGIN_URL =
  'https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip'
export const KIMI_CU_INSTALL_COMMAND = `/plugins install ${KIMI_CU_PLUGIN_URL}`

export type KimiCuTool = never

export interface KimiCuQualification {
  supportedPlatform: boolean
  supportedArchitecture: boolean
  windowsVersionKnown: boolean
  supportedWindowsVersion: boolean
  pluginInstalled: boolean
  callable: false
  tools: readonly KimiCuTool[]
  status: 'unavailable' | 'installed-awaiting-handshake'
  reason: string
  installCommand: string
}

export interface KimiCuProbeOptions {
  platform?: NodeJS.Platform
  arch?: string
  windowsRelease?: string
  env?: NodeJS.ProcessEnv
}

/** Check local files only; a successful MCP handshake and actual desktop call are separate evidence. */
export function qualifyKimiCu(options: KimiCuProbeOptions = {}): KimiCuQualification {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const windowsRelease = options.windowsRelease ?? os.release()
  const build = Number(windowsRelease.split('.')[2])
  const windowsVersionKnown = platform === 'win32' && Number.isInteger(build) && build > 0
  const supportedWindowsVersion = windowsVersionKnown && build >= 18362
  let pluginInstalled = false
  let reason = 'Windows KimiCU 文件已就绪；调用时验证官方 code-mode MCP 及原生服务。'
  if (platform !== 'win32') reason = 'KimiCU WinCU 仅支持 Windows。'
  else if (arch !== 'x64') reason = 'KimiCU WinCU 仅支持 x64 Windows。'
  else if (!supportedWindowsVersion) reason = '需要 Windows 10 1903 或更新版本（含 Windows 11）。'
  else {
    try {
      windowsKimiCuLaunch(options.env)
      pluginInstalled = true
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
    }
  }
  return {
    supportedPlatform: platform === 'win32',
    supportedArchitecture: arch === 'x64',
    windowsVersionKnown,
    supportedWindowsVersion,
    pluginInstalled,
    callable: false,
    tools: [],
    status:
      platform === 'win32' && arch === 'x64' && pluginInstalled
        ? 'installed-awaiting-handshake'
        : 'unavailable',
    reason,
    installCommand: KIMI_CU_INSTALL_COMMAND,
  }
}

export function assertKimiCuPermission(allowed: boolean): void {
  if (!allowed) throw new Error('KimiCU WinCU requires explicit computer-use permission.')
}
