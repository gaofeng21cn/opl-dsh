// Capability discovery never posts a message.
const { existsSync, readdirSync } = require('node:fs')
const { homedir } = require('node:os')
const { join, delimiter, isAbsolute, posix } = require('node:path')
const execFile = require('node:util').promisify(require('node:child_process').execFile)

function macQueueCandidates(home) {
  const bundled = [
    'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    'ChatGPT.app/Contents/Resources/codex',
    'Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    'Codex.app/Contents/Resources/codex',
  ]
  return [
    ...['/Applications', posix.join(home, 'Applications')].flatMap((dir) =>
      bundled.map((entry) => posix.join(dir, entry)),
    ),
    posix.join(home, '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ]
}

function queueCandidates(profileHome) {
  const windows = process.platform === 'win32'
  const name = windows ? 'codex.exe' : 'codex'
  const fixed = process.platform === 'darwin' ? macQueueCandidates(homedir()) : []
  if (windows && profileHome) {
    const root = join(profileHome, 'profiles/desktop/harness-runtimes/codex')
    if (existsSync(root))
      fixed.push(
        ...readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
          .map((v) => join(root, v, 'bin', name)),
      )
  }
  if (windows && process.env.LOCALAPPDATA) {
    const bin = join(process.env.LOCALAPPDATA, 'OpenAI/Codex/bin')
    if (existsSync(bin)) {
      const versions = readdirSync(bin, { withFileTypes: true }).filter((e) => e.isDirectory())
      const { statSync } = require('node:fs')
      versions.sort(
        (a, b) => statSync(join(bin, b.name)).mtimeMs - statSync(join(bin, a.name)).mtimeMs,
      )
      fixed.push(...versions.slice(0, 8).map((e) => join(bin, e.name, name)))
    }
  }
  return [
    ...new Set([
      ...fixed,
      ...(process.env.PATH || '')
        .split(delimiter)
        .filter(isAbsolute)
        .map((dir) => join(dir, name)),
    ]),
  ]
}

async function queueCapability(path, { exists = existsSync, run = execFile } = {}) {
  if (!path || !isAbsolute(path) || !exists(path)) return null
  try {
    const { stdout, stderr } = await run(path, ['queue', '--help'], {
      timeout: 3500,
      windowsHide: true,
      maxBuffer: 128 * 1024,
    })
    const help = stdout + '\n' + stderr
    if (
      !/^Usage:\s+codex queue\b/im.test(help) ||
      !/(?:^|\s)--thread\b(?!-)/.test(help) ||
      !/(?:^|\s)--message\b(?!-)/.test(help)
    )
      return null
    return { path, resume: /(?:^|\s)--resume(?:\s|$)/.test(help) }
  } catch {
    return null
  }
}

async function selectQueue(paths, options) {
  let basic
  for (const path of new Set(paths)) {
    const bridge = await queueCapability(path, options)
    if (bridge?.resume) return bridge
    if (bridge) basic ??= bridge
  }
  return basic
}

async function findQueue(paths = queueCandidates(), options) {
  return (await selectQueue(paths, options))?.path
}

async function ensureDaemon(path, codexHome, run = execFile) {
  const options = {
    env: { ...process.env, CODEX_HOME: codexHome },
    timeout: 20000,
    windowsHide: true,
    maxBuffer: 256 * 1024,
  }
  async function version() {
    const { stdout } = await run(path, ['app-server', 'daemon', 'version'], options)
    const report = JSON.parse(stdout)
    return report.status === 'running' && typeof report.appServerVersion === 'string'
      ? report.appServerVersion
      : null
  }
  try {
    let current = await version().catch(() => null)
    if (!current) {
      await run(path, ['app-server', 'daemon', 'start'], options)
      current = await version()
    }
    return current
  } catch {
    return null
  }
}

async function completeDelegation({
  settings,
  install,
  enableAutoStart,
  autoStart,
  save,
  profileHome,
  codexHome,
  installHooks,
  supportedVersion,
  select = selectQueue,
  daemon = ensureDaemon,
  candidates = queueCandidates,
}) {
  await install()
  if (!autoStart) await enableAutoStart()
  const patch = {}
  if (settings.cooperation?.externalCodex === false)
    patch.cooperation = { ...settings.cooperation, externalCodex: true }
  const existing = settings.wakeExecutable?.trim()
  const wsl = settings.wakeExecution === 'wsl'
  const bridge = wsl ? null : await select([existing, ...candidates(profileHome)].filter(Boolean))
  if ((bridge || (wsl && existing)) && settings.wakeTransport !== 'codex-queue')
    patch.wakeTransport = 'codex-queue'
  if (bridge && bridge.path !== existing)
    Object.assign(patch, { wakeExecutable: bridge.path, wakeExecution: 'native', wakeDistro: '' })
  if (Object.keys(patch).length) await save(patch)
  const hooks = await installHooks(bridge?.path)
  const trust =
    hooks.total > 0 &&
    hooks.installed &&
    hooks.registered === hooks.total &&
    hooks.trusted === hooks.total &&
    hooks.disabled === 0
  const hint = trust ? '' : ' 请在 Codex 设置 → 钩子中检查并信任、启用项目续作 Hook。'
  if (wsl) return '已保留 WSL 通知设置。WSL 的崩溃恢复需单独验证。' + hint
  if (!bridge) return '未找到支持任务完成通知的 Codex，请安装或更新 Codex 后重试。' + hint
  const notification = '任务完成通知已配置。'
  if (!bridge.resume) return notification + '当前队列桥不支持自动接手，请更新 Codex 后重试。' + hint
  const version = await daemon(bridge.path, codexHome)
  if (!version) return notification + '未能确认 Codex 后台服务正在运行，请重试一键配置。' + hint
  if (!supportedVersion(version)) return notification + '当前后台服务版本尚未适配项目续作。' + hint
  return notification + (trust ? '主审异常退出后可自动接手。' : '后台服务已就绪。') + hint
}
module.exports = {
  completeDelegation,
  findQueue,
  macQueueCandidates,
  ensureDaemon,
  selectQueue,
  queueCandidates,
}
