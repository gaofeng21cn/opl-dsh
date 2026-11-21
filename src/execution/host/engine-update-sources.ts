import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'
import type { HarnessInstallation } from '../contracts/installations.ts'
import type { EngineUpdateItem } from '../contracts/engine-updates.ts'
import { maintenanceEnvironment, maintainHarness } from './harness-maintenance.ts'
import { commandLaunch, executablePath, harnessDiagnostic } from './harness-registry.ts'
import { harnessProxyEnvironment } from './proxy.ts'
import { AcpProcess, object } from './acp.ts'
const exec = promisify(execFile)
const packages: Record<string, string> = {
  opencode: 'opencode-ai',
  kilo: '@kilocode/cli',
  pi: '@earendil-works/pi-coding-agent',
  codex: '@openai/codex',
  'minimax-code': '@minimax-ai/code',
}
const stable = /^\d{1,8}\.\d{1,8}\.\d{1,8}$/
function environment(item: HarnessInstallation) {
  return harnessProxyEnvironment(maintenanceEnvironment(), item.definition?.proxy)
}
async function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = 20000,
  input?: string,
  cwd = homedir(),
) {
  const launch = commandLaunch(cmd, args)
  const p = exec(launch.command, launch.args, {
    encoding: 'buffer',
    env,
    cwd,
    timeout,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  })
  p.child.stdin?.on('error', () => {})
  p.child.stdin?.end(input)
  try {
    return (await p).stdout.toString('utf8').trim()
  } catch (e) {
    const x = e as { stderr?: Buffer; code?: string | number }
    const bytes = x.stderr ?? Buffer.alloc(0)
    let message = bytes.toString('utf8')
    if (process.platform === 'win32' && message.includes('�'))
      message = new TextDecoder('gb18030').decode(bytes)
    if (/SEC_E_UNTRUSTED_ROOT/i.test(message))
      throw Error(
        '更新服务器的证书不受信任，请检查网络代理或受信任的根证书（SEC_E_UNTRUSTED_ROOT）',
      )
    throw Error(harnessDiagnostic(message) || '命令失败：' + (x.code ?? cmd))
  }
}
function source(item: HarnessInstallation) {
  if (
    !item.path ||
    !item.version ||
    item.definition?.codexRuntime ||
    /opl[-.]?(git)?bash/i.test(item.version + ' ' + item.path)
  )
    return
  if (item.id === 'antigravity')
    return (
      'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/' +
      (process.platform === 'win32' ? 'windows' : process.platform) +
      '_' +
      (process.arch === 'x64' ? 'amd64' : process.arch) +
      '.json'
    )
  if (item.id === 'claude') return 'https://downloads.claude.ai/claude-code-releases/latest'
  if (item.id === 'step-code') return 'https://static-openapi.stepfun.com/stepcode/latest.json'
  if (item.id === 'mimo-code')
    return 'https://mimocode.cnbj1.mi-fds.com/mimocode/mimocode/releases/latest'
  if (item.id === 'kimi-code') return 'https://code.kimi.com/kimi-code/latest'
  if (Object.hasOwn(packages, item.id))
    return 'https://registry.npmjs.org/' + packages[item.id]!.replace('/', '%2F') + '/latest'
}
function newer(a: string, b: string) {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!
  return false
}
const version = (s: string) => s.match(/\b\d+\.\d+\.\d+(?![\w.-])/)?.[0]
export async function checkEngineUpdate(item: HarnessInstallation): Promise<EngineUpdateItem> {
  const base = { id: item.id, name: item.name, ...(item.version ? { current: item.version } : {}) }
  if (item.definition?.prefix?.length)
    return { ...base, status: 'unsupported', message: '自定义启动参数由原安装渠道维护' }
  if (item.path && item.id === 'grok-build' && item.maintenanceAction === 'update') {
    const result = JSON.parse(
      await run(item.path, ['update', '--check', '--json'], environment(item), 45000),
    )
    if (
      result.error ||
      !stable.test(result.latestVersion ?? '') ||
      !stable.test(result.currentVersion ?? '')
    )
      throw Error('Grok 官方更新器未返回稳定版本')
    return {
      ...base,
      current: result.currentVersion,
      target: result.latestVersion,
      status: newer(result.latestVersion, result.currentVersion) ? 'available' : 'current',
    }
  }
  const win = process.platform === 'win32'
  const officialPaths: Record<string, string> = {
    'kimi-code': join(homedir(), '.kimi-code', 'bin', win ? 'kimi.exe' : 'kimi'),
    'minimax-code': join(homedir(), '.minimax-code', win ? 'mcode.cmd' : 'bin/mcode'),
    'mimo-code': join(homedir(), '.mimocode', 'bin', win ? 'mimo.exe' : 'mimo'),
    'step-code': join(homedir(), '.stepcode', 'bin', win ? 'step.exe' : 'step'),
  }
  if (
    item.maintenanceAction === 'update' &&
    item.path &&
    officialPaths[item.id] &&
    resolve(item.path) !== resolve(officialPaths[item.id]!)
  )
    return { ...base, status: 'unsupported', message: '自定义启动路径请通过原安装渠道更新' }
  const url = source(item)
  if (
    !url ||
    (!item.maintenanceAction && !['step-code', 'opencode', 'pi', 'kilo'].includes(item.id))
  )
    return {
      ...base,
      status: 'unsupported',
      message: item.id === 'qwen-code' ? '当前适配要求固定版本' : '由原安装渠道维护',
    }
  const current = version(item.version ?? '')
  if (!current) return { ...base, status: 'unsupported', message: '当前入口未返回稳定版本' }
  const raw = await run(
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32/curl.exe')
      : 'curl',
    ['-q', '--proto', '=https', '--proto-redir', '=https', '-fsSL', '--max-time', '15', url],
    environment(item),
  )
  const value = raw.startsWith('{') ? JSON.parse(raw).version : raw.replace(/^v/, '')
  if (typeof value !== 'string' || !stable.test(value)) throw Error('官方目录未返回有效的稳定版本')
  return {
    ...base,
    current,
    target: value,
    status: newer(value, current) ? 'available' : 'current',
  }
}
async function verify(path: string, target: string, env: NodeJS.ProcessEnv) {
  if (version(await run(path, ['--version'], env)) !== target)
    throw Error('启动入口版本与目标版本不一致')
}
async function probe(path: string, id: string, env: NodeJS.ProcessEnv, cwd: string) {
  if (id === 'pi' || id === 'step-code') {
    const output = await run(
      path,
      ['--mode', 'rpc', '--session-dir', cwd],
      { ...env, PI_CODING_AGENT_DIR: cwd, STEP_CODING_AGENT_DIR: cwd },
      20000,
      '{"id":"opl-check","type":"get_state"}\n',
      cwd,
    )
    if (
      !output.split('\n').some((line) => {
        try {
          const r = JSON.parse(line)
          return r.id === 'opl-check' && r.success === true && r.data
        } catch {
          return false
        }
      })
    )
      throw Error('RPC 会话状态验证失败')
  } else {
    const launch = commandLaunch(path, ['acp', '--cwd', cwd])
    const acp = new AcpProcess(
      launch.command,
      launch.args,
      cwd,
      {
        ...env,
        XDG_DATA_HOME: cwd,
        XDG_CONFIG_HOME: cwd,
        XDG_STATE_HOME: cwd,
        XDG_CACHE_HOME: cwd,
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      },
      () => {},
      () => {},
      () => {},
      launch.windowsVerbatimArguments,
    )
    try {
      const info = object(
        await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 20000),
      )
      if (info.protocolVersion !== 1 || object(info.agentCapabilities).loadSession !== true)
        throw Error('ACP 协议或恢复能力不兼容')
      const session = object(await acp.request('session/new', { cwd, mcpServers: [] }, 20000))
      if (typeof session.sessionId !== 'string' || !session.sessionId)
        throw Error('ACP 未返回会话 ID')
      await acp.request(
        'session/load',
        { cwd, sessionId: session.sessionId, mcpServers: [] },
        20000,
      )
    } finally {
      await acp.dispose()
    }
  }
}
export async function applyEngineUpdate(
  item: HarnessInstallation,
  target: string,
  warn: (message: string) => void = console.warn,
): Promise<{ path?: string; version: string }> {
  const row = await checkEngineUpdate(item)
  if (row.status !== 'available' || row.target !== target || !stable.test(target) || !item.path)
    throw Error('更新目标已变化，请重新检查')
  const env = environment(item)
  if (
    ['opencode', 'kilo', 'pi'].includes(item.id) ||
    (item.id === 'step-code' && !item.maintenanceAction)
  ) {
    const root = join(
      process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'),
      'OPL DSH Suite',
      'engine-updates',
      item.id,
    )
    await mkdir(root, { recursive: true })
    const stage = await mkdtemp(join(root, target + '-'))
    const scratch = await mkdtemp(join(tmpdir(), 'opl-engine-check-'))
    try {
      let path: string
      if (item.id === 'step-code') {
        if (process.platform !== 'win32') throw Error('该平台的固定 StepCode 请通过原安装渠道更新')
        const manifest = JSON.parse(
          await run(
            'curl.exe',
            [
              '-q',
              '--proto',
              '=https',
              '-fsS',
              'https://static-openapi.stepfun.com/stepcode/' + target + '/manifest.json',
            ],
            env,
          ),
        )
        const key = 'windows-' + process.arch
        const url =
          'https://static-openapi.stepfun.com/stepcode/' +
          target +
          '/step-' +
          target +
          '-' +
          key +
          '.zip'
        const sha = manifest.checksums?.[key]
        if (
          manifest.version !== target ||
          manifest.packages?.[key] !== url ||
          !/^[0-9a-f]{64}$/.test(sha)
        )
          throw Error('StepCode 官方包校验信息不匹配')
        const archive = join(scratch, 'step.zip')
        await run('curl.exe', ['-q', '--proto', '=https', '-fsS', '-o', archive, url], env, 180000)
        await run(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$ErrorActionPreference='Stop'; if((Get-FileHash -LiteralPath $env:OPL_ARCHIVE).Hash -ne $env:OPL_HASH){throw 'SHA256 mismatch'}; Expand-Archive -LiteralPath $env:OPL_ARCHIVE -DestinationPath $env:OPL_STAGE",
          ],
          { ...env, OPL_ARCHIVE: archive, OPL_STAGE: stage, OPL_HASH: sha },
          180000,
        )
        path = join(stage, 'step.exe')
      } else {
        const npm = await executablePath('npm')
        if (!npm) throw Error('未找到 npm')
        await run(
          npm,
          [
            'install',
            '--global',
            '--prefix',
            stage,
            '--registry=https://registry.npmjs.org',
            packages[item.id] + '@' + target,
            ...(item.id === 'pi' ? ['--ignore-scripts'] : []),
          ],
          env,
          300000,
        )
        path =
          process.platform === 'win32' ? join(stage, item.id + '.cmd') : join(stage, 'bin', item.id)
      }
      await verify(path, target, env)
      await probe(path, item.id, env, scratch)
      return { path, version: target }
    } catch (error) {
      await removeUpdateDirectory(stage, warn)
      throw error
    } finally {
      await removeUpdateDirectory(scratch, warn)
    }
  }
  if (item.id === 'grok-build') await run(item.path, ['update', '--version', target], env, 300000)
  else await maintainHarness(item, item.definition?.proxy, target)
  await verify(item.path, target, env)
  return { version: target }
}

async function removeUpdateDirectory(path: string, warn: (message: string) => void) {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 })
  } catch (error) {
    warn(
      `未能清理执行引擎更新目录 ${path}（${(error as NodeJS.ErrnoException).code ?? 'unknown'}）`,
    )
  }
}
