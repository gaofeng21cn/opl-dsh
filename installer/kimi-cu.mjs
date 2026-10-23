/** Install and configure the optional KimiCU companion from its official release. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export const KIMI_CU_VERSION_URL = 'https://cdn.kimi.com/kimi-computer-use/latest/version.json'
export const KIMI_CU_BUNDLE_ID = 'ai.kimi.cu'
export const KIMI_CU_TEAM_ID = '2J9472RW75'
export const KIMI_CU_INSTALL_PATH = '/Applications/KimiCU.app'
export const KIMI_CU_EXECUTABLE = '/Applications/KimiCU.app/Contents/MacOS/kimi-cu'
export const KIMI_CU_MCP_ARGS = ['mcp', '-s', 'user']
export const KIMI_CU_REQUIRED_TOOLS = [
  'list_apps',
  'get_app_state',
  'click',
  'type_text',
  'press_key',
  'scroll',
  'set_value',
  'perform_secondary_action',
  'select_text',
  'drag',
]
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/u
const SHA256 = /^[a-f0-9]{64}$/u

/** Return a comparable stable semantic version, or undefined for a prerelease/malformed one. */
export function parseStableVersion(value) {
  const match = VERSION.exec(value)
  return match === null ? undefined : match.slice(1).map(Number)
}

/** Compare two stable semantic versions without accepting prerelease downgrades. */
export function compareStableVersions(left, right) {
  const a = parseStableVersion(left)
  const b = parseStableVersion(right)
  if (a === undefined || b === undefined) throw Error('KimiCU 版本必须为稳定语义版本')
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

/** Pick the exact official archive for this Mac from the version manifest. */
export function kimiCuRelease(manifest, platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin') return undefined
  if (arch !== 'arm64' && arch !== 'x64') return undefined
  if (!isRecord(manifest) || typeof manifest.version !== 'string')
    throw Error('KimiCU 版本清单无效')
  const version = manifest.version
  if (parseStableVersion(version) === undefined) throw Error('KimiCU 版本清单不是稳定版本')
  const selected = manifest[arch === 'arm64' ? 'app' : 'app_x86_64']
  if (
    !isRecord(selected) ||
    typeof selected.url !== 'string' ||
    typeof selected.sha256 !== 'string' ||
    selected.team_id !== KIMI_CU_TEAM_ID ||
    !SHA256.test(selected.sha256)
  )
    throw Error('KimiCU 版本清单缺少有效的官方归档或签名身份')
  const url = new URL(selected.url)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'cdn.kimi.com' ||
    !url.pathname.startsWith(`/kimi-computer-use/${version}/`) ||
    !url.pathname.endsWith('.app.zip')
  )
    throw Error('KimiCU 归档地址不是已验证的官方 CDN')
  return { version, url: url.href, sha256: selected.sha256, arch }
}

/** Read a bounded streamed response without buffering an oversized body first. */
async function responseBytes(response, limit) {
  if (!response.ok) throw Error(`下载失败（HTTP ${String(response.status)}）`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > limit) throw Error('下载内容超过大小上限')
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel('response exceeds size limit').catch(() => {})
        throw Error('下载内容超过大小上限')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function command(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    ...options,
  })
  return {
    ok: result.status === 0 && result.error === undefined,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    status: result.status,
  }
}

/** Hash a private local archive so an explicit local candidate has one immutable input. */
function localArchiveDigest(path) {
  if (!existsSync(path)) throw Error('本地 KimiCU 归档不存在')
  const bytes = readFileSync(path)
  if (bytes.length > MAX_ARCHIVE_BYTES) throw Error('本地 KimiCU 归档超过大小上限')
  return digest(bytes)
}

function plistValue(path, key) {
  return command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path])
}

/** Verify one Mac app's signature, notarization, identity, version and architecture. */
export function verifyKimiCuBundle(appPath, expectedVersion, expectedArchitecture = process.arch) {
  const info = join(appPath, 'Contents/Info.plist')
  const executable = join(appPath, 'Contents/MacOS', basename(KIMI_CU_EXECUTABLE))
  if (!existsSync(info) || !existsSync(executable)) throw Error('KimiCU 归档不包含完整应用')
  const bundleId = plistValue(info, 'CFBundleIdentifier')
  const version = plistValue(info, 'CFBundleShortVersionString')
  if (!bundleId.ok || bundleId.stdout.trim() !== KIMI_CU_BUNDLE_ID)
    throw Error('KimiCU Bundle ID 不匹配')
  if (!version.ok || version.stdout.trim() !== expectedVersion)
    throw Error('KimiCU 归档版本与官方清单不匹配')
  const signature = command('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  const identity = command('/usr/bin/codesign', ['-dv', '--verbose=2', appPath])
  const gatekeeper = command('/usr/sbin/spctl', [
    '--assess',
    '--type',
    'execute',
    '--verbose=2',
    appPath,
  ])
  if (
    !signature.ok ||
    !gatekeeper.ok ||
    !identity.stderr.includes(`TeamIdentifier=${KIMI_CU_TEAM_ID}`) ||
    !identity.stderr.includes('Authority=Developer ID Application:')
  )
    throw Error('KimiCU 签名、Team ID 或公证校验失败')
  const architectures = command('/usr/bin/lipo', ['-archs', executable])
  const expectedArch = expectedArchitecture === 'x64' ? 'x86_64' : 'arm64'
  if (!architectures.ok || !architectures.stdout.split(/\s+/u).includes(expectedArch))
    throw Error('KimiCU 可执行文件架构不匹配')
  return { bundleId: KIMI_CU_BUNDLE_ID, version: expectedVersion, arch: expectedArch }
}

/** Inspect an existing bundle without mutating it. */
export function inspectKimiCu(appPath = KIMI_CU_INSTALL_PATH, expectedArchitecture = process.arch) {
  if (!existsSync(appPath)) return { installed: false, verified: false }
  const info = join(appPath, 'Contents/Info.plist')
  const executable = join(appPath, 'Contents/MacOS', basename(KIMI_CU_EXECUTABLE))
  if (!existsSync(info) || !existsSync(executable))
    return { installed: true, verified: false, version: null, executable: null }
  const version = plistValue(info, 'CFBundleShortVersionString')
  let verified = false
  if (version.ok) {
    try {
      verifyKimiCuBundle(appPath, version.stdout.trim(), expectedArchitecture)
      verified = true
    } catch {}
  }
  return {
    installed: true,
    verified,
    version: version.ok ? version.stdout.trim() : null,
    executable,
  }
}

function toolNames(output) {
  const names = []
  for (const line of output.split(/\r?\n/u)) {
    try {
      const value = JSON.parse(line)
      const tools = value?.result?.tools
      if (Array.isArray(tools))
        names.push(...tools.flatMap((tool) => (typeof tool?.name === 'string' ? [tool.name] : [])))
    } catch {}
  }
  return [...new Set(names)]
}

/** Verify the MCP handshake and required tool vocabulary, then initialize the companion. */
export function configureKimiCu(executable = KIMI_CU_EXECUTABLE) {
  // Re-register the launch service after an upgrade. Keeping the old registration
  // across bundle replacement can leave launchd pointing at the previous code
  // identity, which then fails with EX_CONFIG even though the new bundle is valid.
  const uninstalled = command(executable, ['uninstall'])
  if (
    !uninstalled.ok &&
    !/not (installed|registered)|notRegistered/iu.test(`${uninstalled.stdout}${uninstalled.stderr}`)
  )
    throw Error(`KimiCU 旧服务注销失败：${uninstalled.stderr.trim() || uninstalled.stdout.trim()}`)
  const installed = command(executable, ['install'])
  if (!installed.ok)
    throw Error(`KimiCU 官方初始化失败：${installed.stderr.trim() || installed.stdout.trim()}`)
  const restarted = command('/bin/launchctl', [
    'kickstart',
    '-k',
    `gui/${String(process.getuid?.() ?? 0)}/ai.kimi.cu.service`,
  ])
  if (!restarted.ok)
    throw Error(`KimiCU 服务重启失败：${restarted.stderr.trim() || restarted.stdout.trim()}`)
  const request =
    [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'opl-dsh-installer', version: '0.2.40' },
        },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    ].join('\n') + '\n'
  const probe = command(executable, KIMI_CU_MCP_ARGS, { input: request })
  if (!probe.ok) throw Error(`KimiCU MCP 启动失败：${probe.stderr.trim()}`)
  const observed = toolNames(`${probe.stdout}\n${probe.stderr}`)
  const missing = KIMI_CU_REQUIRED_TOOLS.filter((tool) => !observed.includes(tool))
  if (missing.length) throw Error(`KimiCU MCP 工具不完整：${missing.join(', ')}`)
  const doctor = command(executable, ['doctor'])
  const xpc = command(executable, ['xpc-ping'])
  if (!xpc.ok || !xpc.stdout.includes('permissionStatus:'))
    throw Error(`KimiCU XPC 服务不可用：${xpc.stderr.trim() || xpc.stdout.trim()}`)
  return {
    initialized: true,
    tools: observed,
    permissions: doctor.ok ? doctor.stdout.trim() : doctor.stderr.trim(),
    permissionsReady: doctor.ok && !doctor.stdout.includes('❌'),
    xpc: xpc.stdout.trim(),
  }
}

/**
 * Install or upgrade KimiCU without downgrading a verified newer bundle.
 * Failure is recorded in a receipt and never blocks the rest of the DSH installer.
 */
export async function installKimiCu({
  suiteRoot,
  appPath = KIMI_CU_INSTALL_PATH,
  fetchImpl = fetch,
  platform = process.platform,
  arch = process.arch,
  log = () => {},
  inspect,
  verifyBundle = verifyKimiCuBundle,
  configure = configureKimiCu,
  archivePath = process.env.OPL_KIMI_CU_ARCHIVE_PATH?.trim() || undefined,
  expectedSha256 = process.env.OPL_KIMI_CU_ARCHIVE_SHA256?.trim() || undefined,
  unpack = (archive, destination) => command('/usr/bin/ditto', ['-x', '-k', archive, destination]),
  hostPlatform = process.platform,
} = {}) {
  const receiptPath =
    suiteRoot === undefined ? undefined : join(suiteRoot, 'kimi-cu-installation.json')
  const record = async (state, extra = {}) => {
    if (receiptPath === undefined) return
    await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 })
    await writeFile(
      receiptPath,
      JSON.stringify(
        { version: 1, checkedAt: new Date().toISOString(), state, ...extra },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    )
  }
  if (platform !== 'darwin') {
    await record('skipped', { reason: 'KimiCU 仅支持 macOS', platform })
    return { state: 'skipped', reason: 'KimiCU 仅支持 macOS' }
  }
  if (hostPlatform !== 'darwin') {
    await record('skipped', {
      reason: '当前安装器宿主不是 macOS，已跳过 KimiCU 安装',
      platform,
      hostPlatform,
    })
    return { state: 'skipped', reason: '当前安装器宿主不是 macOS' }
  }
  try {
    const inspectBundle = inspect ?? ((path) => inspectKimiCu(path, arch))
    const before = inspectBundle(appPath)
    if (archivePath !== undefined) {
      if (platform !== 'darwin') throw Error('KimiCU 本地归档只能安装在 macOS')
      if (expectedSha256 === undefined) throw Error('KimiCU 本地归档必须同时提供 SHA-256')
      if (!SHA256.test(expectedSha256)) throw Error('KimiCU 本地归档摘要格式无效')
      const actual = localArchiveDigest(archivePath)
      if (expectedSha256 !== undefined && actual !== expectedSha256)
        throw Error('KimiCU 本地归档 SHA-256 不匹配')
      const manifestResponse = await fetchImpl(KIMI_CU_VERSION_URL, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
      const manifest = JSON.parse(
        (await responseBytes(manifestResponse, MAX_MANIFEST_BYTES)).toString('utf8'),
      )
      const target = kimiCuRelease(manifest, platform, arch)
      if (target === undefined) throw Error('当前 Mac 架构没有 KimiCU 官方归档')
      if (
        before.verified &&
        before.version !== null &&
        compareStableVersions(before.version, target.version) >= 0
      ) {
        const configured = configure(before.executable)
        await record('current', {
          installedVersion: before.version,
          targetVersion: target.version,
          archiveSha256: actual,
          localArchive: true,
          ...configured,
        })
        return { state: 'current', version: before.version, ...configured }
      }
      if (before.installed && !before.verified)
        throw Error('现有 KimiCU 身份未通过校验，已保留；请人工确认后移走该应用再重试')
      const stage = await mkdtemp(join(tmpdir(), 'opl-dsh-kimi-cu-'))
      try {
        const extracted = join(stage, 'payload')
        await mkdir(extracted, { recursive: true, mode: 0o700 })
        const unpacked = unpack(archivePath, extracted)
        if (!unpacked.ok) throw Error(`KimiCU 本地归档解压失败：${unpacked.stderr.trim()}`)
        const staged = join(extracted, 'KimiCU.app')
        verifyBundle(staged, target.version, arch)
        const replacement = `${appPath}.opl-stage-${String(process.pid)}`
        const backup = `${appPath}.opl-backup-${String(process.pid)}`
        rmSync(replacement, { recursive: true, force: true })
        rmSync(backup, { recursive: true, force: true })
        const copied = command('/usr/bin/ditto', [staged, replacement])
        if (!copied.ok) throw Error(`KimiCU 暂存复制失败：${copied.stderr.trim()}`)
        try {
          if (existsSync(appPath)) renameSync(appPath, backup)
          renameSync(replacement, appPath)
          const verified = inspectBundle(appPath)
          if (!verified.verified) throw Error('KimiCU 安装后身份校验失败')
          verifyBundle(appPath, target.version, arch)
          const configured = configure(verified.executable)
          await record('installed', {
            installedVersion: target.version,
            previousVersion: before.version ?? null,
            archiveSha256: actual,
            localArchive: true,
            ...configured,
          })
          rmSync(backup, { recursive: true, force: true })
          return { state: 'installed', version: target.version, ...configured }
        } catch (error) {
          rmSync(appPath, { recursive: true, force: true })
          if (existsSync(backup)) renameSync(backup, appPath)
          throw error
        }
      } finally {
        await rm(stage, { recursive: true, force: true })
      }
    }
    if (before.verified && before.version !== null && process.env.OPL_KIMI_CU_OFFLINE === '1') {
      const configured = configure(before.executable)
      await record('current', {
        installedVersion: before.version,
        targetVersion: before.version,
        offline: true,
        ...configured,
      })
      log(`KimiCU ${before.version} 已安装；离线模式未查询更新`)
      return { state: 'current', version: before.version, ...configured }
    }
    const manifestResponse = await fetchImpl(KIMI_CU_VERSION_URL, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    const manifest = JSON.parse(
      (await responseBytes(manifestResponse, MAX_MANIFEST_BYTES)).toString('utf8'),
    )
    const target = kimiCuRelease(manifest, platform, arch)
    if (target === undefined) throw Error('当前 Mac 架构没有 KimiCU 官方归档')
    if (
      before.verified &&
      before.version !== null &&
      compareStableVersions(before.version, target.version) >= 0
    ) {
      const configured = configure(before.executable)
      await record('current', {
        installedVersion: before.version,
        targetVersion: target.version,
        ...configured,
      })
      log(`KimiCU ${before.version} 已是最新或更高可信版本`)
      return { state: 'current', version: before.version, ...configured }
    }
    if (before.installed && !before.verified)
      throw Error('现有 KimiCU 身份未通过校验，已保留；请人工确认后移走该应用再重试')
    const response = await fetchImpl(target.url, {
      headers: { accept: 'application/octet-stream' },
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    })
    const bytes = await responseBytes(response, MAX_ARCHIVE_BYTES)
    if (digest(bytes) !== target.sha256) throw Error('KimiCU 归档 SHA-256 不匹配')
    const stage = await mkdtemp(join(tmpdir(), 'opl-dsh-kimi-cu-'))
    try {
      const archive = join(stage, 'KimiCU.app.zip')
      await writeFile(archive, bytes, { mode: 0o600 })
      const extracted = join(stage, 'payload')
      await mkdir(extracted, { recursive: true, mode: 0o700 })
      const unpacked = unpack(archive, extracted)
      if (!unpacked.ok) throw Error(`KimiCU 归档解压失败：${unpacked.stderr.trim()}`)
      const staged = join(extracted, 'KimiCU.app')
      verifyBundle(staged, target.version, arch)
      const replacement = `${appPath}.opl-stage-${String(process.pid)}`
      const backup = `${appPath}.opl-backup-${String(process.pid)}`
      rmSync(replacement, { recursive: true, force: true })
      rmSync(backup, { recursive: true, force: true })
      const copied = command('/usr/bin/ditto', [staged, replacement])
      if (!copied.ok) throw Error(`KimiCU 暂存复制失败：${copied.stderr.trim()}`)
      try {
        if (existsSync(appPath)) renameSync(appPath, backup)
        renameSync(replacement, appPath)
      } catch (error) {
        rmSync(replacement, { recursive: true, force: true })
        if (!existsSync(appPath) && existsSync(backup)) renameSync(backup, appPath)
        throw error
      }
      try {
        const verified = inspectBundle(appPath)
        if (!verified.verified) throw Error('KimiCU 安装后身份校验失败')
        verifyBundle(appPath, target.version, arch)
        const configured = configure(verified.executable)
        await record('installed', {
          installedVersion: target.version,
          previousVersion: before.version ?? null,
          archiveSha256: target.sha256,
          ...configured,
        })
        rmSync(backup, { recursive: true, force: true })
        log(`KimiCU ${target.version} 已安装并配置 MCP`)
        return { state: 'installed', version: target.version, ...configured }
      } catch (error) {
        rmSync(appPath, { recursive: true, force: true })
        if (existsSync(backup)) renameSync(backup, appPath)
        throw error
      }
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await record('deferred', { message })
    log(`KimiCU 自动安装未完成，继续安装 DSH：${message}`)
    return { state: 'deferred', message }
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const KIMI_CU_PLUGIN_URL =
  'https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip'
export const KIMI_CU_INSTALL_COMMAND = `/plugins install ${KIMI_CU_PLUGIN_URL}`

export function kimiCuInstallInfo() {
  return {
    platform: 'win32',
    architecture: 'x64',
    command: KIMI_CU_INSTALL_COMMAND,
    verified: false,
    note: '仅显示官方安装命令；不会下载、解压或执行插件。',
  }
}
