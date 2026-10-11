/** Bounded JSON-RPC stdio transport for the ACP v1 surface Grok advertises. */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
export const object = (value: unknown): Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}
/**
 * Map a JSON-RPC error to a controlled, actionable message.
 *
 * Only the error *code* is interpreted. The agent's own `message` and `data.details`
 * are never reflected: an arbitrary provider string could carry credentials or account
 * identifiers, and a length- or pattern-based scrub cannot prove otherwise. The codes
 * below are the only provider-controlled input that reaches the user, and the
 * `HARNESS_*` families belong to this suite's own native bridge rather than to an
 * official CLI account, so a MiniMax login problem can never surface Gateway advice.
 */
const harnessFailure = (code: unknown) => {
  switch (code) {
    case 'HARNESS_AUTH':
      return '所选渠道认证失败，请在 OPL Gateway 刷新账号后重试。原任务未自动重发。'
    case 'HARNESS_RATE_LIMIT':
      return '所选渠道当前限流，请稍后重试。原任务未自动重发。'
    case 'HARNESS_MODEL':
      return '所选模型未被当前渠道接受，请检查模型配置。原任务未自动重发。'
    case 'HARNESS_TIMEOUT':
      return '所选渠道长时间没有返回首个响应，已停止本轮请求。请检查渠道状态后再手动发起新指令；原任务未自动重发。'
    case 'HARNESS_NETWORK':
      return '所选渠道连接中断，重试后仍未收到响应，已停止本轮请求。请检查网络或切换已配置的渠道；原任务未自动重发。'
    case -32700:
    case -32600:
    case -32601:
      return '官方 Harness 不支持本次请求的协议方法，请检查套件与官方 CLI 的版本是否匹配。原任务未自动重发。'
    case -32602:
      return '官方 Harness 拒绝了本次请求参数，请检查所选模型与固定组合是否匹配。原任务未自动重发。'
    case -32603:
      return '官方 Harness 处理本次请求时返回内部错误。若使用官方账号登录的 CLI，请确认已登录且模型可用。原任务未自动重发。'
    default:
      return 'Harness 执行未完成，请检查官方 CLI 的安装、登录与模型配置。原任务未自动重发。'
  }
}
export class HarnessTransportError extends Error {}
/**
 * The agent accepted the ACP session but refused to honor the combination's pinned
 * model or reasoning parameters. Carried separately so the precise reason survives
 * the turn-level error mapping instead of collapsing into a generic message.
 */
export class HarnessConfigurationError extends Error {}
export class AcpProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private sequence = 0
  closed = false
  private disposing?: Promise<void>
  constructor(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly update: (value: unknown) => void,
    private readonly permission: (id: string | number, value: unknown) => void,
    private readonly onExit: () => void,
    verbatimArguments = false,
    /** 扩展通知：官方 ACP 只定义 `session/update`，其余通知必须由使用方自行取用。 */
    private readonly notification?: (method: string, params: unknown) => void,
  ) {
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Needed for `cmd.exe` wrappers: see AdapterLaunch.windowsVerbatimArguments.
      ...(verbatimArguments ? { windowsVerbatimArguments: true } : {}),
    })
    // Always drain stderr; it may contain provider diagnostics and is never reflected into the UI.
    this.child.stderr.resume()
    this.child.stdin.on('error', () => this.fail('Harness ACP 输入通道关闭'))
    this.child.on('error', () => this.fail('无法启动 Harness，请检查官方程序与执行路径'))
    this.child.on('exit', () => this.fail('Harness 进程已结束'))
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let m: Record<string, any>
      try {
        m = object(JSON.parse(line))
      } catch {
        return
      }
      if (m.jsonrpc !== '2.0') return
      if (typeof m.id === 'number' && m.method === undefined) {
        const p = this.pending.get(m.id)
        if (!p) return
        clearTimeout(p.timer)
        this.pending.delete(m.id)
        if (m.error) {
          p.reject(new HarnessTransportError(harnessFailure(object(m.error).code)))
        } else p.resolve(m.result)
      } else if (m.method === 'session/update') this.update(m.params)
      else if (typeof m.id === 'string' || typeof m.id === 'number') {
        // 带 id 的是发往本方的请求，必须照常回应；扩展通知永远不会走到这里。
        if (m.method === 'session/request_permission') this.permission(m.id, m.params)
        else
          this.send({
            id: m.id,
            error: { code: -32601, message: 'Unsupported ACP client request' },
          })
      } else if (this.notification !== undefined) this.notification(m.method, m.params)
    })
  }
  private fail(message: string) {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(message))
    }
    this.pending.clear()
    this.onExit()
  }
  private send(value: object) {
    if (this.closed) throw new Error('Harness ACP 通道已关闭')
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
  }
  request(method: string, params: object, timeoutMs = 30000): Promise<unknown> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Harness ACP 请求超时'))
        void this.dispose()
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      }
    })
  }
  cancel(sessionId: string) {
    if (!this.closed) this.send({ method: 'session/cancel', params: { sessionId } })
  }
  answer(id: string | number, optionId?: string) {
    if (!this.closed)
      this.send({
        id,
        result: {
          outcome:
            optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId },
        },
      })
  }
  dispose(): Promise<void> {
    return (this.disposing ??= this.stop())
  }
  private async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) return
    const exit = new Promise<void>((resolve) => this.child.once('exit', () => resolve()))
    if (process.platform === 'win32') {
      // Kill descendants while the owned root still exists. Killing cmd.exe first
      // loses the ancestry needed to reach its CLI and MCP children.
      await new Promise<void>((resolve, reject) => {
        execFile(
          process.env.SystemRoot
            ? join(process.env.SystemRoot, 'System32', 'taskkill.exe')
            : 'taskkill.exe',
          ['/PID', String(this.child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 5000 },
          (error) => {
            if (error && this.child.exitCode === null && this.child.signalCode === null)
              reject(new Error('无法结束自有 Harness 进程树'))
            else resolve()
          },
        )
      })
      await exit
      return
    }
    this.child.kill('SIGTERM')
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1500)
    await exit
    clearTimeout(timer)
  }
}
