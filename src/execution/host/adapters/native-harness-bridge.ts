/** ACP transport projection over the installed official Codex/Claude harnesses.
 * This file owns no agent loop, model requests, tool execution or session format.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import {
  getSessionMessages,
  query,
  type Query,
  type McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk'
import {
  codexSandboxMode,
  codexShellProbeCommand,
  nativeGitBashEnv,
  readShellProbe,
  type NativePermission,
} from './native-bash.ts'
import { acpUpdatesForClaudeEvent } from './claude-transcript.ts'
const kind = process.env.OPL_NATIVE_HARNESS!,
  command = process.env.OPL_NATIVE_COMMAND!
// The permission profile is a three-way authorization, not a boolean. Treating anything that
// is not `workspace` as read-only silently demoted an explicitly authorized `full-access`
// task, which also hid the only profile Codex accepts for Git Bash.
const taskPermission = (process.env.OPL_NATIVE_PERMISSION ?? 'read-only') as NativePermission,
  model = process.env.OPL_NATIVE_MODEL!,
  cwd = process.cwd(),
  readonly = taskPermission === 'read-only'
const send = (value: object) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const emit = (update: object) => send({ method: 'session/update', params: { sessionId, update } })
let sessionId = '',
  hasHistory = false,
  cancelled = false,
  claude: Query | undefined,
  turnId = ''
let servers: Record<string, McpServerConfig> = {}
let seq = 0
const asks = new Map<string, (allowed: boolean) => void>()
function permission(title: string): Promise<boolean> {
  const id = 'permission-' + ++seq
  return new Promise((resolve) => {
    asks.set(id, resolve)
    send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { title },
        options: [
          { optionId: 'allow', name: '允许本次', kind: 'allow_once' },
          { optionId: 'deny', name: '拒绝', kind: 'reject_once' },
        ],
      },
    })
  })
}
// Built on first use so a rejected Git Bash path is reported through the normal ACP error
// path with its reason attached, instead of crashing the bridge before it can answer.
let harnessEnvCache: NodeJS.ProcessEnv | undefined
/** Non-empty when this session actually asked Codex to use a Git Bash executable. */
let codexGitBashRequested = false
function harnessEnv(): NodeJS.ProcessEnv {
  if (harnessEnvCache) return harnessEnvCache
  const preResolved = process.env.OPL_NATIVE_GIT_BASH
  const patch = nativeGitBashEnv(kind === 'codex' ? 'codex' : 'claude', taskPermission, {
    ...(preResolved ? { bash: preResolved } : {}),
  })
  codexGitBashRequested = kind === 'codex' && Boolean(patch.CODEX_NATIVE_GIT_BASH_PATH)
  harnessEnvCache = { ...process.env, ...patch }
  delete harnessEnvCache.ELECTRON_RUN_AS_NODE
  return harnessEnvCache
}
let child: ReturnType<typeof spawn> | undefined
/** Collects the output of an in-flight, model-free shell probe. */
let shellProbe: { output: string; done?: () => void } | null = null
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
let resolveTurn: ((value: unknown) => void) | undefined,
  rejectTurn: ((e: Error) => void) | undefined
function codexRequest(method: string, params: object): Promise<any> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child!.stdin!.write(JSON.stringify({ id, method, params }) + '\n')
  })
}
async function openCodex() {
  const windowsScript = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
  child = spawn(
    windowsScript ? (process.env.ComSpec ?? 'cmd.exe') : command,
    windowsScript
      ? ['/d', '/s', '/c', `""${command}" app-server --stdio"`]
      : ['app-server', '--stdio'],
    {
      cwd,
      env: harnessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // cmd.exe with /S strips only the outermost quote pair, so the script path must
      // stay quoted inside a second pair, and the arguments must reach cmd verbatim:
      // Node's own Windows escaping would turn those inner quotes into \" which cmd
      // reads as literal backslashes and never resolves the script.
      ...(windowsScript ? { windowsVerbatimArguments: true } : {}),
    },
  )
  child.stderr!.resume()
  const fail = () => {
    for (const p of pending.values()) p.reject(Error('Codex 进程退出'))
    pending.clear()
    rejectTurn?.(Error('Codex 进程退出'))
  }
  child.on('error', fail)
  child.on('exit', fail)
  createInterface({ input: child.stdout! }).on('line', (line) => {
    void (async () => {
      let m: any
      try {
        m = JSON.parse(line)
      } catch {
        return
      }
      if (m.id !== undefined && !m.method) {
        const p = pending.get(m.id)
        if (p) {
          pending.delete(m.id)
          m.error ? p.reject(Error('Codex 请求失败（' + m.error.code + '）')) : p.resolve(m.result)
        }
        return
      }
      const p = m.params ?? {}
      if (m.id !== undefined) {
        let result: object
        if (
          m.method === 'item/commandExecution/requestApproval' ||
          m.method === 'item/fileChange/requestApproval'
        ) {
          // Approval may not enlarge the saved filesystem boundary.
          const allowed = false // Requests to escape the saved sandbox cannot be approved by this bridge.
          result = { decision: allowed ? 'accept' : 'decline' }
        } else if (m.method === 'item/tool/requestUserInput') result = { answers: {} }
        else {
          child!.stdin!.write(
            JSON.stringify({
              id: m.id,
              error: { code: -32601, message: 'Unsupported client request' },
            }) + '\n',
          )
          return
        }
        child!.stdin!.write(JSON.stringify({ id: m.id, result }) + '\n')
        return
      }
      if (p.threadId !== sessionId) return
      // The shell probe borrows this thread's command stream; it is kept out of the tool
      // call stream so it never surfaces as task activity.
      if (shellProbe) {
        if (m.method === 'item/commandExecution/outputDelta') shellProbe.output += p.delta ?? ''
        else if (m.method === 'item/completed' && p.item?.type === 'commandExecution')
          shellProbe.done?.()
        // The probe is internal bookkeeping and is never surfaced as task activity.
        if (m.method === 'item/started' || m.method === 'item/completed') return
      }
      if (m.method === 'item/agentMessage/delta')
        emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: p.delta } })
      if (m.method === 'item/started' || m.method === 'item/completed') {
        const item = p.item ?? {}
        if (!['agentMessage', 'userMessage', 'reasoning'].includes(item.type))
          emit({
            sessionUpdate: m.method === 'item/started' ? 'tool_call' : 'tool_call_update',
            toolCallId: item.id,
            title: item.command ?? item.type,
            status:
              m.method === 'item/started'
                ? 'in_progress'
                : item.status === 'failed'
                  ? 'failed'
                  : 'completed',
            kind: 'other',
          })
      }
      if (m.method === 'turn/completed') {
        turnId = ''
        if (p.turn.status === 'failed') rejectTurn?.(Error('Codex 执行失败'))
        else
          resolveTurn?.({ stopReason: p.turn.status === 'interrupted' ? 'cancelled' : 'end_turn' })
        resolveTurn = undefined
        rejectTurn = undefined
      }
    })().catch(() => rejectTurn?.(Error('Codex 消息处理失败')))
  })
  await codexRequest('initialize', {
    clientInfo: { name: 'opl-dsh', version: '0.2.13' },
    capabilities: { experimentalApi: true },
  })
  child.stdin!.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
}
/**
 * Confirm with the running Codex process which shell it really executes commands with.
 *
 * Uses Codex's own `thread/shellCommand`, so the answer needs no model call and no
 * credentials and cannot be faked by the environment the bridge happened to set. The probe
 * only prints which shell is running it.
 * @param threadId - the Codex thread to probe.
 * @returns the raw probe output.
 */
async function probeCodexShell(threadId: string): Promise<string> {
  const probe: { output: string; done?: () => void } = { output: '' }
  shellProbe = probe
  // The timeout still bounds the wait, but the timer is cleared on every exit path so a
  // finished probe never keeps the event loop alive or fires into a later session.
  const timer = setTimeout(() => probe.done?.(), 30000)
  try {
    const finished = new Promise<void>((resolve) => {
      probe.done = resolve
    })
    await codexRequest('thread/shellCommand', {
      threadId,
      command: codexShellProbeCommand(),
      timeoutMs: 20000,
    })
    await finished
  } finally {
    clearTimeout(timer)
    delete probe.done
    shellProbe = null
  }
  return probe.output
}

/**
 * Refuse to continue when the requested Git Bash did not take effect.
 *
 * The Codex Git Bash variable is not an upstream Codex interface, so a build that ignores it
 * would otherwise silently keep running on its own shell while the task claims Bash.
 * @param threadId - the Codex thread to verify.
 */
async function confirmCodexGitBash(threadId: string): Promise<void> {
  const shell = readShellProbe(await probeCodexShell(threadId))
  if (shell?.bashVersion && shell.bashVersion !== 'none') return
  throw Error(
    '已请求 Codex 使用 Git Bash，但当前 Codex 进程实际使用的 shell 是 ' +
      `${shell?.name ?? '未知（未收到回读）'}。` +
      '该 Codex 构建不支持 Git Bash 设置，上游官方亦未提供此接口；请改用官方支持的 Windows 方案（PowerShell 或 WSL）。',
  )
}

async function pathInProject(path: unknown): Promise<boolean> {
  if (typeof path !== 'string') return false
  const target = resolve(cwd, path)
  let probe = target
  for (;;) {
    try {
      const actual = await realpath(probe)
      return actual === cwd || actual.startsWith(cwd + sep)
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return false
      probe = parent
    }
  }
}
async function claudePrompt(text: string, effort?: string) {
  if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort))
    throw Error('Claude Code 不支持该推理强度')
  cancelled = false
  hasHistory = (await getSessionMessages(sessionId, { dir: cwd, limit: 1 })).length > 0
  // Restricted tasks keep the isolated sandbox and must fail loudly when no Windows sandbox
  // backend is active. Only an explicitly authorized full-access task turns the restricted
  // sandbox off, and it turns it off through the official SDK modes rather than by relaxing
  // anything a restricted task relies on.
  const fullAccess = taskPermission === 'full-access'
  const disallowed = readonly
    ? ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'Task']
    : ['Agent', 'Task']
  const abortController = new AbortController()
  let responseTimedOut = false
  let networkRetry = false
  let firstResponseTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => {
      responseTimedOut = true
      abortController.abort()
    },
    4 * 60 * 1000,
  )
  const receivedResponse = () => {
    if (firstResponseTimer) clearTimeout(firstResponseTimer)
    firstResponseTimer = undefined
  }
  claude = query({
    prompt: text,
    options: {
      cwd,
      model,
      abortController,
      ...(effort ? { effort: effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
      pathToClaudeCodeExecutable: command,
      env: harnessEnv(),
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: servers,
      ...(hasHistory ? { resume: sessionId } : { sessionId }),
      // `bypassPermissions` is the official SDK mode for a task the user already authorized at full
      // access; it does not answer anyone else's pending approval, it only stops Claude Code
      // from asking again about a decision this task was granted.
      permissionMode: fullAccess ? 'bypassPermissions' : 'default',
      includePartialMessages: true,
      disallowedTools: disallowed,
      // A restricted task keeps the isolated sandbox and refuses to run without a Windows
      // sandbox backend. Full access instead turns the restricted sandbox off explicitly.
      sandbox: fullAccess
        ? { enabled: false }
        : {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: false,
            allowUnsandboxedCommands: false,
            filesystem: { allowWrite: readonly ? [] : [cwd] },
            credentials: {
              envVars: [
                { name: 'ANTHROPIC_API_KEY', mode: 'deny' },
                { name: 'OPL_NATIVE_API_KEY', mode: 'deny' },
              ],
            },
          },
      // Restricted tasks only: under `bypassPermissions` the SDK auto-approves every tool call before
      // this callback is consulted, so it is not a filesystem boundary for a full-access task.
      // Such a task is bounded by the user's own explicit authorization, not by anything here.
      canUseTool: async (name, input) => {
        if (cancelled) return { behavior: 'deny', message: '任务已取消' }
        if (name.startsWith('mcp__opl-harness__')) return { behavior: 'allow', updatedInput: input }
        if (['Read', 'Glob', 'Grep', 'LS', 'TodoWrite'].includes(name))
          return { behavior: 'allow', updatedInput: input }
        if (readonly) return { behavior: 'deny', message: '此组合只允许读取' }
        if (['Write', 'Edit', 'NotebookEdit'].includes(name))
          return (await pathInProject(input.file_path ?? input.notebook_path))
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: '不能写入项目目录之外' }
        if (name === 'Bash')
          return input.dangerouslyDisableSandbox
            ? { behavior: 'deny', message: '不能退出组合的沙箱' }
            : { behavior: 'allow', updatedInput: input }
        return (await permission(
          'Claude Code · ' + name + '\n' + JSON.stringify(input).slice(0, 2000),
        ))
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: '用户未授权此操作' }
      },
    },
  })
  let result: any
  try {
    for await (const event of claude) {
      if (event.type === 'system' && event.subtype === 'api_retry' && event.error_status === null)
        networkRetry = true
      if (event.type === 'assistant' || event.type === 'result' || event.type === 'stream_event')
        receivedResponse()
      // Complete assistant text blocks are not replayed after their streamed deltas.
      for (const update of acpUpdatesForClaudeEvent(event)) emit(update)
      if (event.type === 'result') result = event
    }
  } catch (error) {
    if (responseTimedOut) throw Error(networkRetry ? 'HARNESS_NETWORK' : 'HARNESS_TIMEOUT')
    throw error
  } finally {
    receivedResponse()
    claude.close()
    claude = undefined
  }
  if (responseTimedOut) throw Error(networkRetry ? 'HARNESS_NETWORK' : 'HARNESS_TIMEOUT')
  if (cancelled) return { stopReason: 'cancelled' }
  if (!result || result.is_error || result.subtype !== 'success') {
    const status = result?.api_error_status
    if (status === 401 || status === 403) throw Error('HARNESS_AUTH')
    if (status === 429) throw Error('HARNESS_RATE_LIMIT')
    if (status === 400 || status === 404) throw Error('HARNESS_MODEL')
    throw Error('HARNESS_EXECUTION')
  }
  hasHistory = true
  return { stopReason: 'end_turn' }
}
async function invoke(method: string, p: any) {
  if (method === 'initialize') {
    if (kind === 'codex') await openCodex()
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: kind, version: 'native' },
    }
  }
  if (method === 'session/new' || method === 'session/load') {
    if (p.cwd !== cwd) throw Error('不能改变已绑定项目')
    servers = Object.fromEntries(
      (p.mcpServers ?? []).map((s: any) => [
        s.name,
        {
          command: s.command,
          args: s.args,
          env: Object.fromEntries(s.env.map((e: any) => [e.name, e.value])),
        },
      ]),
    )
    if (kind === 'codex') {
      const config = {
        model_provider: 'opl-gateway',
        model_providers: {
          'opl-gateway': {
            name: 'OPL Gateway',
            base_url: process.env.OPL_NATIVE_BASE_URL,
            env_key: 'OPL_NATIVE_API_KEY',
            wire_api: 'responses',
            requires_openai_auth: false,
          },
        },
        mcp_servers: Object.fromEntries(
          Object.entries(servers).map(([k, v]) => [
            k,
            { ...v, enabled: true, default_tools_approval_mode: 'approve', tool_timeout_sec: 600 },
          ]),
        ),
        shell_environment_policy: { inherit: 'core', exclude: ['OPL_*', 'ANTHROPIC_*', 'DSH_*'] },
        forced_login_method: 'api',
      }
      const params = {
        model,
        modelProvider: 'opl-gateway',
        cwd,
        // Codex refuses to start a thread under a restricted profile once
        // CODEX_NATIVE_GIT_BASH_PATH is set, so the mode and the Bash path have to agree.
        sandbox: codexSandboxMode(taskPermission),
        approvalPolicy: 'never',
        config,
      }
      const r = await codexRequest(method === 'session/load' ? 'thread/resume' : 'thread/start', {
        ...params,
        ...(p.sessionId ? { threadId: p.sessionId } : {}),
      })
      sessionId = r.thread.id
      if (r.model && r.model !== model) throw Error('Codex 返回不同模型')
      if (codexGitBashRequested) await confirmCodexGitBash(sessionId)
    } else {
      sessionId = p.sessionId ?? randomUUID()
      hasHistory = false
    }
    return { sessionId, models: { currentModelId: model } }
  }
  if (p.sessionId !== sessionId) throw Error('会话身份不匹配')
  if (method === 'session/cancel') {
    cancelled = true
    for (const resolve of asks.values()) resolve(false)
    asks.clear()
    if (kind === 'codex' && turnId)
      await codexRequest('turn/interrupt', { threadId: sessionId, turnId })
    if (claude) await claude.interrupt()
    return {}
  }
  if (method === 'session/prompt') {
    const text = p.prompt
      .filter((v: any) => v.type === 'text')
      .map((v: any) => v.text)
      .join('\n')
    const effort = p._meta?.reasoningEffort ?? undefined
    if (kind === 'claude') return claudePrompt(text, effort)
    const done = new Promise((resolve, reject) => {
      resolveTurn = resolve
      rejectTurn = reject
    })
    // Mark the promise handled before awaiting turn/start, which can itself fail.
    void done.catch(() => {})
    try {
      const r = await codexRequest('turn/start', {
        threadId: sessionId,
        input: [{ type: 'text', text, text_elements: [] }],
        model,
        effort: effort ?? null,
      })
      turnId = r.turn.id
      return await done
    } finally {
      resolveTurn = undefined
      rejectTurn = undefined
      turnId = ''
    }
  }
  throw Error('不支持的调用')
}
createInterface({ input: process.stdin }).on('line', (line) => {
  void (async () => {
    let m: any
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (!m.method) {
      const answer = asks.get(m.id)
      if (answer) {
        asks.delete(m.id)
        answer(m.result?.outcome?.optionId === 'allow')
      }
      return
    }
    try {
      const result = await invoke(m.method, m.params ?? {})
      if (m.id !== undefined) send({ id: m.id, result })
    } catch (error) {
      if (process.env.OPL_NATIVE_DIAGNOSTICS === '1')
        process.stderr.write(
          JSON.stringify({
            method: m.method,
            error: String(error instanceof Error ? error.message : 'failure').replaceAll(
              process.env.OPL_NATIVE_API_KEY ?? '__none__',
              '[REDACTED]',
            ),
          }) + '\n',
        )
      if (m.id !== undefined)
        send({
          id: m.id,
          error: {
            code:
              error instanceof Error &&
              /^HARNESS_(AUTH|RATE_LIMIT|MODEL|EXECUTION|TIMEOUT|NETWORK)$/.test(error.message)
                ? error.message
                : 'HARNESS_UNKNOWN',
            message: '官方 Harness 调用未完成',
          },
        })
    }
  })()
})
const stop = () => {
  claude?.close()
  child?.kill('SIGTERM')
  process.exit()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.stdin.on('end', stop)
