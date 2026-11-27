/** Reclaim obsolete macOS Desktop backup bundles under <suiteRoot>/runtime safely and idempotently. */
import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const officialBackupPattern = /^DeepSeek Harness\.backup\.(.+)\.app$/u
const launcherBackupPattern = /^OPL DSH\.app\.backup\.(.+)$/u
const legacyAppPattern = /^OPL DSH\.legacy-.+\.app$/u
const epochSuffixPattern = /^(\d+)(?:-(\d+))?$/u

function safeRealpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function parseTimestamp(suffix) {
  const match = epochSuffixPattern.exec(suffix)
  if (!match) return { hasEpoch: false, epoch: 0, seq: 0 }
  return {
    hasEpoch: true,
    epoch: Number(match[1]),
    seq: match[2] ? Number(match[2]) : 0,
  }
}

export function classifyRuntimeBackup(name) {
  let match = officialBackupPattern.exec(name)
  if (match) {
    return {
      kind: 'official-backup',
      tier: 2,
      ...parseTimestamp(match[1]),
    }
  }
  match = launcherBackupPattern.exec(name)
  if (match) {
    return {
      kind: 'launcher-backup',
      tier: 1,
      ...parseTimestamp(match[1]),
    }
  }
  if (legacyAppPattern.test(name)) {
    return {
      kind: 'legacy-app',
      tier: 0,
      hasEpoch: false,
      epoch: 0,
      seq: 0,
    }
  }
  return null
}

function compareBackupsNewestFirst(left, right) {
  if (left.tier !== right.tier) return right.tier - left.tier
  if (left.hasEpoch !== right.hasEpoch) return left.hasEpoch ? -1 : 1
  if (left.hasEpoch && right.hasEpoch) {
    if (left.epoch !== right.epoch) return right.epoch - left.epoch
    if (left.seq !== right.seq) return right.seq - left.seq
  }
  if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs
  return right.name.localeCompare(left.name)
}

function defaultListProcessCommands() {
  const result = spawnSync('/bin/ps', ['-axo', 'command='], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trimStart())
    .filter(Boolean)
}

function isSameOrNestedPath(left, right) {
  if (!left || !right) return false
  return left === right || left.startsWith(right + '/') || right.startsWith(left + '/')
}

function verifyVerifiedInstallation(resolvedRoot, resolvedApp) {
  const receiptPath = join(resolvedRoot, 'installation.json')
  const receiptStat = lstatSync(receiptPath, { throwIfNoEntry: false })
  if (!receiptStat || !receiptStat.isFile() || receiptStat.isSymbolicLink()) return null

  let receipt
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  } catch {
    return null
  }
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    typeof receipt.app !== 'string' ||
    !receipt.app ||
    typeof receipt.officialVersion !== 'string' ||
    !receipt.officialVersion
  ) {
    return null
  }

  const receiptAppPath = resolve(receipt.app)
  const appReal = safeRealpath(resolvedApp)
  const receiptAppReal = safeRealpath(receiptAppPath)
  const appMatches =
    receiptAppPath === resolvedApp || (appReal !== undefined && appReal === receiptAppReal)
  if (!appMatches) return null

  const appStat = lstatSync(resolvedApp, { throwIfNoEntry: false })
  const executableStat = statSync(join(resolvedApp, 'Contents/MacOS/DeepSeek Harness'), {
    throwIfNoEntry: false,
  })
  const asarStat = statSync(join(resolvedApp, 'Contents/Resources/app.asar'), {
    throwIfNoEntry: false,
  })
  if (
    !appStat ||
    !appStat.isDirectory() ||
    appStat.isSymbolicLink() ||
    !executableStat?.isFile() ||
    !asarStat
  ) {
    return null
  }

  const activePaths = new Set(
    [resolvedApp, appReal, receiptAppPath, receiptAppReal].filter(Boolean),
  )
  return { activePaths, officialVersion: receipt.officialVersion }
}

function isRunningBundle(candidate, commands) {
  const prefixes = [candidate.path, candidate.realPath].filter(Boolean)
  return commands.some((command) =>
    prefixes.some((base) => command === base || command.startsWith(base + '/')),
  )
}

/**
 * Prune accumulated `.app` backups under `<root>/runtime` after a verified installation.
 * Keeps at most `keep` (default 1) most recent backup bundle and removes older backups
 * plus obsolete `OPL DSH.legacy-*.app` directories without ever touching symlinks,
 * unknown files/directories, the active app bundle, or any currently running bundle.
 */
export function reclaimRuntimeBackups({
  root,
  app,
  keep = 1,
  listProcessCommands = defaultListProcessCommands,
  removeEntry = (target) => rmSync(target, { recursive: true, force: true }),
  onWarn = (message) => console.warn(message),
} = {}) {
  const empty = { kept: [], removed: [], skippedRunning: [], failed: [] }
  if (typeof root !== 'string' || !root || typeof app !== 'string' || !app) {
    return { ...empty, skipped: 'invalid-arguments' }
  }
  const keepCount = Number.isInteger(keep) && keep >= 0 ? keep : 1
  const resolvedRoot = resolve(root)
  const resolvedApp = resolve(app)

  const rootStat = lstatSync(resolvedRoot, { throwIfNoEntry: false })
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { ...empty, skipped: 'invalid-root' }
  }

  const runtimeDir = join(resolvedRoot, 'runtime')
  const runtimeStat = lstatSync(runtimeDir, { throwIfNoEntry: false })
  if (!runtimeStat) return { ...empty, skipped: 'missing-runtime' }
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
    return { ...empty, skipped: 'unsafe-runtime' }
  }

  const verified = verifyVerifiedInstallation(resolvedRoot, resolvedApp)
  if (!verified) return { ...empty, skipped: 'unverified-active-app' }

  const entries = readdirSync(runtimeDir, { withFileTypes: true })
  const retainable = []
  const obsolete = []

  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue
    const classification = classifyRuntimeBackup(entry.name)
    if (!classification) continue

    const entryPath = join(runtimeDir, entry.name)
    const entryStat = lstatSync(entryPath, { throwIfNoEntry: false })
    if (!entryStat || entryStat.isSymbolicLink() || !entryStat.isDirectory()) continue

    const realPath = safeRealpath(entryPath)
    const matchesActive = [...verified.activePaths].some(
      (active) => isSameOrNestedPath(entryPath, active) || isSameOrNestedPath(realPath, active),
    )
    if (matchesActive) continue

    const candidate = {
      name: entry.name,
      path: entryPath,
      realPath,
      mtimeMs: entryStat.mtimeMs,
      ...classification,
    }
    if (candidate.tier === 0) obsolete.push(candidate)
    else retainable.push(candidate)
  }

  if (retainable.length <= keepCount && obsolete.length === 0) {
    return {
      ...empty,
      kept: retainable.sort(compareBackupsNewestFirst).map((item) => item.path),
    }
  }

  const commands = listProcessCommands()
  if (!Array.isArray(commands)) {
    onWarn('无法确认运行中桌面进程，已跳过历史桌面备份清理。')
    return { ...empty, skipped: 'process-inspection-failed' }
  }

  retainable.sort(compareBackupsNewestFirst)
  const kept = retainable.slice(0, keepCount)
  const toDelete = [...retainable.slice(keepCount), ...obsolete]
  const removed = []
  const skippedRunning = []
  const failed = []

  for (const candidate of toDelete) {
    if (isRunningBundle(candidate, commands)) {
      skippedRunning.push(candidate.path)
      continue
    }
    try {
      removeEntry(candidate.path)
      removed.push(candidate.path)
    } catch (error) {
      failed.push({ path: candidate.path, message: error.message })
      onWarn(`无法清理历史桌面备份 ${candidate.name}：${error.message}`)
    }
  }

  return {
    kept: kept.map((item) => item.path),
    removed,
    skippedRunning,
    failed,
  }
}

const officialArchivePattern = /^deepseek-harness-(.+)\.(?:zip|exe)$/u

/**
 * Prune obsolete downloaded official desktop archives under `<root>/cache` after a
 * verified installation, retaining only the archive matching the installed officialVersion.
 */
export function reclaimOfficialArchives({
  root,
  app,
  officialVersion,
  preservePaths = [],
  removeEntry = (target) => rmSync(target, { force: true }),
  onWarn = (message) => console.warn(message),
} = {}) {
  const empty = { kept: [], removed: [], failed: [] }
  if (typeof root !== 'string' || !root || typeof app !== 'string' || !app) {
    return { ...empty, skipped: 'invalid-arguments' }
  }
  const resolvedRoot = resolve(root)
  const resolvedApp = resolve(app)

  const rootStat = lstatSync(resolvedRoot, { throwIfNoEntry: false })
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { ...empty, skipped: 'invalid-root' }
  }

  const cacheDir = join(resolvedRoot, 'cache')
  const cacheStat = lstatSync(cacheDir, { throwIfNoEntry: false })
  if (!cacheStat) return { ...empty, skipped: 'missing-cache' }
  if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()) {
    return { ...empty, skipped: 'unsafe-cache' }
  }

  const verified = verifyVerifiedInstallation(resolvedRoot, resolvedApp)
  if (!verified) return { ...empty, skipped: 'unverified-active-app' }

  const activeVersion =
    typeof officialVersion === 'string' && officialVersion
      ? officialVersion
      : verified.officialVersion
  const preservedNames = new Set([
    `deepseek-harness-${activeVersion}.zip`,
    `deepseek-harness-${activeVersion}-win-x64.exe`,
  ])
  const preservedResolved = new Set(preservePaths.filter(Boolean).map((item) => resolve(item)))

  const kept = []
  const removed = []
  const failed = []

  for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue
    if (!officialArchivePattern.test(entry.name)) continue

    const entryPath = join(cacheDir, entry.name)
    const entryStat = lstatSync(entryPath, { throwIfNoEntry: false })
    if (!entryStat || entryStat.isSymbolicLink() || !entryStat.isFile()) continue

    if (preservedNames.has(entry.name) || preservedResolved.has(resolve(entryPath))) {
      kept.push(entryPath)
      continue
    }

    try {
      removeEntry(entryPath)
      removed.push(entryPath)
    } catch (error) {
      failed.push({ path: entryPath, message: error.message })
      onWarn(`无法清理过期官方安装包缓存 ${entry.name}：${error.message}`)
    }
  }

  return { kept, removed, failed }
}

function isCliEntry() {
  const entry = process.argv[1]
  if (!entry) return false
  const self = fileURLToPath(import.meta.url)
  return resolve(entry) === self || safeRealpath(entry) === safeRealpath(self)
}

if (isCliEntry()) {
  const [root, app] = process.argv.slice(2)
  if (root && app) {
    const backups = reclaimRuntimeBackups({ root, app })
    if (backups.removed.length > 0) {
      console.log(`已清理 ${backups.removed.length} 份历史桌面备份，仅保留最近 1 份备份。`)
    }
    const archives = reclaimOfficialArchives({
      root,
      app,
      preservePaths: [process.env.OPL_OFFICIAL_ARCHIVE].filter(Boolean),
    })
    if (archives.removed.length > 0) {
      console.log(`已清理 ${archives.removed.length} 份过期官方安装包缓存。`)
    }
  }
}
