/** Version and update operations for the KimiCU installation used by the DSH Host. */
import { execFileSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  compareStableVersions,
  installKimiCu,
  kimiCuRelease,
  KIMI_CU_INSTALL_PATH,
  KIMI_CU_VERSION_URL,
  parseStableVersion,
  responseBytes,
} from './kimi-cu.mjs'
import {
  installWindowsKimiCu,
  windowsKimiCuRelease,
  WINDOWS_KIMI_CU_VERSION,
} from './kimi-cu-windows.mjs'

import { acquireSuiteMaintenance } from './update-transaction.mjs'

const windowsFeed = 'https://cdn.kimi.com/kimi-computer-use-windows/latest/version.json'

async function installed({ platform, suiteRoot, appPath = KIMI_CU_INSTALL_PATH }) {
  if (platform === 'darwin') {
    try {
      await stat(appPath)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    const version = execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', join(appPath, 'Contents/Info.plist')],
      { encoding: 'utf8', timeout: 5000 },
    ).trim()
    if (!parseStableVersion(version)) throw Error('无法识别已安装的 KimiCU 版本')
    return version
  }
  for (const version of [WINDOWS_KIMI_CU_VERSION, '0.3.10']) {
    const root = join(suiteRoot, 'kimi-cu', version)
    try {
      await stat(root)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const plugin = JSON.parse(await readFile(join(root, 'plugin', 'kimi.plugin.json'), 'utf8'))
    if (plugin.version !== version || plugin.name !== 'kimi-cu-win')
      throw Error('已安装的 KimiCU 插件版本与目录不符')
    for (const path of ['runtime/kimi-cu.exe', 'plugin/runtime/node-repl.exe'])
      if (!(await stat(join(root, path))).isFile()) throw Error('KimiCU 安装不完整')
    return version
  }
  return null
}

/** Read the selected installation. A remote error preserves its local version. */
export async function componentStatus({
  check = false,
  suiteRoot,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
  appPath,
  signal,
} = {}) {
  const state = { installedVersion: null, latestVersion: null, available: false }
  try {
    if (
      !(platform === 'darwin' && ['x64', 'arm64'].includes(arch)) &&
      !(platform === 'win32' && arch === 'x64')
    )
      throw Error('当前系统或架构不支持 KimiCU')
    state.installedVersion = await installed({ platform, suiteRoot, appPath })
  } catch {
    return { ...state, error: 'read-failed' }
  }
  if (!check) return state
  try {
    const url = platform === 'win32' ? windowsFeed : KIMI_CU_VERSION_URL
    const response = await fetchImpl(url, {
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    })
    const manifest = JSON.parse((await responseBytes(response, 65536)).toString('utf8'))
    if (
      platform === 'win32' &&
      parseStableVersion(manifest.version) &&
      compareStableVersions(manifest.version, WINDOWS_KIMI_CU_VERSION) > 0
    ) {
      state.latestVersion = manifest.version
      return { ...state, error: 'unvalidated' }
    }
    const target =
      platform === 'win32'
        ? windowsKimiCuRelease(manifest)
        : kimiCuRelease(manifest, platform, arch)
    state.latestVersion = target.version
    state.available =
      !state.installedVersion || compareStableVersions(target.version, state.installedVersion) > 0
  } catch {
    state.error = 'check-failed'
  }
  return state
}

/** Install a verified component without downgrading, then read back its active version. */
export async function updateComponent(options = {}) {
  const before = await componentStatus({ ...options, check: true })
  if (!before.available) return before
  if (options.expectedVersion && options.expectedVersion !== before.latestVersion)
    return { ...before, error: 'check-failed' }
  let lease
  try {
    lease = await acquireSuiteMaintenance(options.suiteRoot)
    return await installChecked(options, before)
  } catch (error) {
    return {
      ...before,
      error: [
        'suite-operation-busy',
        'suite-launch-in-progress',
        'suite-update-in-progress',
        'update-in-progress',
      ].includes(error.code)
        ? 'busy'
        : 'install-failed',
    }
  } finally {
    await lease?.release()
  }
}

async function installChecked(options, before) {
  const fetchImpl = async (url, init) => {
    const response = await (options.fetchImpl ?? fetch)(url, {
      ...init,
      signal:
        options.signal && init.signal
          ? AbortSignal.any([options.signal, init.signal])
          : (options.signal ?? init.signal),
    })
    if (url === KIMI_CU_VERSION_URL) {
      const bytes = await responseBytes(response, 65536)
      if (JSON.parse(bytes.toString('utf8')).version !== before.latestVersion)
        throw Error('KimiCU 可更新版本已变化，请重新检查')
      return new Response(bytes)
    }
    return response
  }
  const install =
    (options.platform ?? process.platform) === 'win32' ? installWindowsKimiCu : installKimiCu
  const result = await install({
    ...options,
    fetchImpl,
    allowOffline: false,
    archivePath: undefined,
  })
  if (!['current', 'installed'].includes(result.state))
    return { ...before, error: 'install-failed' }
  const after = await componentStatus({ ...options, check: false })
  if (
    !after.installedVersion ||
    compareStableVersions(after.installedVersion, before.latestVersion) < 0
  )
    return { ...before, error: after.error || 'install-failed' }
  return { ...after, latestVersion: before.latestVersion }
}
