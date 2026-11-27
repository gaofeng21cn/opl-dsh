import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, readdir, realpath, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import writeFileAtomic from 'write-file-atomic'
import { OPL_GATEWAY_INFERENCE_BASE_URL } from './opl-credentials.ts'

export class CodexNativeSetupError extends Error {}

const model = 'gpt-6.2-sol'
const provider = {
  name: 'OPL Gateway',
  base_url: OPL_GATEWAY_INFERENCE_BASE_URL,
  wire_api: 'responses',
  requires_openai_auth: true,
}
const values = {
  cli_auth_credentials_store: 'keyring',
  model_provider: 'opl_gateway',
  model,
  'model_providers.opl_gateway': provider,
}
type Command = { bin: string; prefix: string[] }

async function existsFile(path: string) {
  try {
    await access(path, constants.X_OK)
    return (await lstat(await realpath(path))).isFile()
  } catch {
    return false
  }
}

async function findCli(explicit?: string): Promise<Command> {
  const windows = process.platform === 'win32'
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
  const bins = dirs.map((dir) => join(dir, windows ? 'codex.exe' : 'codex'))
  if (windows && process.env.LOCALAPPDATA) {
    const root = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const installed = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const path = join(root, e.name, 'codex.exe')
          return { path, time: (await lstat(path).catch(() => null))?.mtimeMs ?? 0 }
        }),
    )
    bins.push(...installed.sort((a, b) => b.time - a.time).map((e) => e.path))
  } else if (!windows) {
    for (const base of ['/Applications', join(homedir(), 'Applications')]) {
      bins.push(
        join(base, 'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
      )
      bins.push(join(base, 'Codex.app/Contents/Resources/codex'))
    }
    bins.push('/opt/homebrew/bin/codex', '/usr/local/bin/codex')
  }
  for (const bin of explicit ? [explicit] : bins) {
    if (isAbsolute(bin) && (await existsFile(bin))) return { bin, prefix: [] }
  }
  if (!explicit && windows) {
    for (const dir of dirs) {
      const script = join(dir, 'node_modules/@openai/codex/bin/codex.js')
      if (await existsFile(script)) return { bin: process.execPath, prefix: [script] }
    }
  }
  throw new CodexNativeSetupError('未找到此环境的 Codex CLI，请先安装 Codex。')
}

function child(command: Command, home: string, args: string[]) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (
      /^(CODEX_|OPENAI_|RUST_LOG$|RUST_BACKTRACE$|NODE_OPTIONS$|NODE_DEBUG$|DEBUG$|OTEL_)/i.test(
        name,
      )
    )
      delete env[name]
  }
  // These overrides apply only while configuring the profile.
  const overrides = [
    'features.hooks=false',
    'features.plugins=false',
    'features.apps=false',
    'analytics.enabled=false',
    'otel.exporter="none"',
    'otel.metrics_exporter="none"',
    'otel.trace_exporter="none"',
  ].flatMap((value) => ['-c', value])
  return spawn(command.bin, [...command.prefix, ...overrides, ...args], {
    cwd: home,
    env: { ...env, CODEX_HOME: home, CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1' },
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

async function login(command: Command, home: string, args: string[], key?: string) {
  const proc = child(command, home, ['-c', 'cli_auth_credentials_store="keyring"', ...args])
  proc.stdin.on('error', () => {})
  proc.stdout.resume()
  let message = ''
  proc.stderr.on('data', (buf: Buffer) => {
    message = (message + buf.toString()).slice(-8192)
  })
  const timer = setTimeout(() => proc.kill(), 60_000)
  const done = new Promise<number | null>((res, rej) => {
    proc.once('error', () => rej(new CodexNativeSetupError('无法启动 Codex CLI。')))
    proc.once('close', res)
  })
  proc.stdin.end(key === undefined ? undefined : key + '\n')
  try {
    const code = await done
    return {
      ok: code === 0,
      apiKey: code === 0 && /^(API key configured|Logged in using an API key)\b/im.test(message),
      empty: code === 1 && /^Not logged in\s*$/im.test(message),
    }
  } finally {
    clearTimeout(timer)
  }
}

type ConfigResult = {
  config: Record<string, unknown> & { model_providers?: Record<string, Record<string, unknown>> }
  layers?: { name: { type: string }; version: string }[]
}
function configured(c: ConfigResult['config']) {
  const p = c.model_providers?.opl_gateway
  return (
    c.cli_auth_credentials_store === 'keyring' &&
    c.model_provider === 'opl_gateway' &&
    p?.base_url === provider.base_url &&
    p.wire_api === 'responses' &&
    p.requires_openai_auth === true
  )
}

async function withServer<T>(
  cmd: Command,
  home: string,
  use: (request: <R>(method: string, params: unknown) => Promise<R>) => Promise<T>,
): Promise<T> {
  const proc = child(cmd, home, ['app-server'])
  proc.on('error', () => {})
  proc.stdin.on('error', () => {})
  proc.stderr.resume()
  const closed = new Promise<void>((done) => proc.once('close', () => done()))
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]()
  const timer = setTimeout(() => proc.kill(), 45_000)
  let seq = 0
  async function request<R>(method: string, params: unknown): Promise<R> {
    const id = ++seq
    proc.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    for (;;) {
      const line = await lines.next()
      if (line.done) throw new CodexNativeSetupError('Codex 配置服务已退出，请检查 CLI 版本。')
      let message
      try {
        message = JSON.parse(line.value)
      } catch {
        throw new CodexNativeSetupError('Codex 配置服务返回了无效响应。')
      }
      if (message.id !== id) continue
      if (message.error || !message.result)
        throw new CodexNativeSetupError('Codex 未接受配置，请检查现有配置或管理策略。')
      return message.result as R
    }
  }
  try {
    await request('initialize', { clientInfo: { name: 'opl_gateway_setup', version: '1' } })
    proc.stdin.write('{"method":"initialized"}\n')
    return await use(request)
  } finally {
    clearTimeout(timer)
    proc.stdin.end()
    proc.kill()
    await closed
  }
}
const busy = new Set<string>()
const privatePath = (home: string) => join(home, 'auth.json')
async function regularBytes(path: string): Promise<Buffer | null> {
  const st = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (!st) return null
  if (!st.isFile() || st.nlink !== 1)
    throw new CodexNativeSetupError('配置路径不是独立的普通文件。')
  return readFile(path)
}
function sameBytes(left: Buffer | null, right: Buffer | null) {
  return left === null ? right === null : right !== null && left.equals(right)
}
async function hasAuthFile(home: string) {
  return Boolean(
    await lstat(privatePath(home)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null
      throw e
    }),
  )
}

/** Configure the selected native Codex home with its credential manager. Paths are host-owned. */
export async function configureNativeCodex(
  issueKey: () => Promise<string>,
  options: { home?: string; executable?: string } = {},
): Promise<void> {
  if (process.platform !== 'win32' && process.platform !== 'darwin')
    throw new CodexNativeSetupError('请选择 Windows 或 macOS 原生 Codex。')
  const dest = options.home ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  if (!isAbsolute(dest)) throw new CodexNativeSetupError('Codex 配置目录不是绝对路径。')
  const cmd = await findCli(options.executable)
  await mkdir(dest, { recursive: true, mode: 0o700 })
  const home = await realpath(resolve(dest))
  if (busy.has(home)) throw new CodexNativeSetupError('Codex 正在配置，请稍候。')
  busy.add(home)
  try {
    if (await hasAuthFile(home))
      throw new CodexNativeSetupError(
        '发现已有 auth.json，已保留现有登录。请先在 Codex 迁移或退出旧登录。',
      )
    const path = join(home, 'config.toml')
    const initial = await regularBytes(path)
    const inspect = () =>
      withServer(cmd, home, (request) =>
        request<ConfigResult>('config/read', { includeLayers: true }),
      )
    const before = await inspect()
    const status = await login(cmd, home, ['login', 'status'])
    if (!status.ok && !status.empty)
      throw new CodexNativeSetupError('无法读取系统凭据库，请解锁后重试。')
    if (status.ok && (!status.apiKey || !configured(before.config)))
      throw new CodexNativeSetupError('此 Codex 已有其他登录，已保留。请先在 Codex 退出旧登录。')
    const key = await issueKey()
    if (!key || /\s/u.test(key)) throw new CodexNativeSetupError('网关未提供有效的专用密钥。')
    const matchesKey = () =>
      withServer(cmd, home, async (request) => {
        const auth = await request<{ authToken?: string }>('getAuthStatus', {
          includeToken: true,
          refreshToken: false,
        })
        return auth.authToken === key
      })
    if (status.ok) {
      if (!(await matchesKey()))
        throw new CodexNativeSetupError('已有 OPL 登录与本次专用密钥不同，已保留原登录。')
      return
    }
    let written: Buffer | null | undefined

    let attemptedWrite = false
    let attemptedLogin = false
    try {
      if (!sameBytes(initial, await regularBytes(path)) || (await hasAuthFile(home)))
        throw new CodexNativeSetupError('配置在操作期间已变化，请重新配置。')
      attemptedWrite = true
      const write = await withServer(cmd, home, (request) =>
        request<{ status: string; version: string }>('config/batchWrite', {
          edits: Object.entries(values).map(([keyPath, value]) => ({
            keyPath,
            value,
            mergeStrategy: 'replace',
          })),
          expectedVersion: before.layers?.find((layer) => layer.name.type === 'user')?.version,
        }),
      )
      written = await regularBytes(path)
      const after = await inspect()
      if (after.layers?.find((layer) => layer.name.type === 'user')?.version !== write.version) {
        written = undefined
        throw new CodexNativeSetupError('其他程序已更改 Codex 配置，请刷新后重试。')
      }
      if (write.status !== 'ok' || !configured(after.config) || after.config.model !== model) {
        throw new CodexNativeSetupError('配置未生效，请检查 Codex 管理策略。')
      }
      const latest = await login(cmd, home, ['login', 'status'])
      if (!latest.empty || (await hasAuthFile(home)))
        throw new CodexNativeSetupError('Codex 登录状态已变化，请重新配置。')
      attemptedLogin = true
      if (!(await login(cmd, home, ['login', '--with-api-key'], key)).ok)
        throw new CodexNativeSetupError('Codex 无法保存密钥，请解锁系统凭据库后重试。')
      if (
        (await hasAuthFile(home)) ||
        !(await login(cmd, home, ['login', 'status'])).ok ||
        !(await matchesKey())
      )
        throw new CodexNativeSetupError('Codex 未从系统凭据库读回专用密钥。')
    } catch (err) {
      if (attemptedWrite && written === undefined && !sameBytes(initial, await regularBytes(path)))
        throw new CodexNativeSetupError(
          '无法确认 Codex 是否已写入配置，已保留现场。请重新配置以核对。',
        )
      let uncertain = false
      if (attemptedLogin) {
        try {
          if (await matchesKey()) uncertain = !(await login(cmd, home, ['logout'])).ok
          else uncertain = !(await login(cmd, home, ['login', 'status'])).empty
        } catch {
          uncertain = true
        }
      }
      if (written !== undefined) {
        if (!sameBytes(written, await regularBytes(path)))
          throw new CodexNativeSetupError('配置已被其他程序修改，已保留最新文件，请重新配置。')
        if (initial === null) await unlink(path)
        else await writeFileAtomic(path, initial, { mode: 0o600 })
      }
      if (uncertain)
        throw new CodexNativeSetupError('Codex 登录结果未确认，请检查系统凭据库后重试。')
      throw err
    }
  } finally {
    busy.delete(home)
  }
}
