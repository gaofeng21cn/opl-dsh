import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path'

const execFileAsync = promisify(execFile)
const POWERSHELL = 'powershell.exe'
const MAX_POWER_SHELL_OUTPUT = 4 * 1024 * 1024
const RECYCLE_TIME_FUTURE_TOLERANCE_MS = 60_000

const PATH_SAFETY_SCRIPT = String.raw`
& {
  param([string]$encodedRequest)
  $ErrorActionPreference = 'Stop'
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedRequest)) | ConvertFrom-Json
  foreach ($path in $request.paths) {
    $attributes = [IO.File]::GetAttributes([IO.Path]::GetFullPath([string]$path))
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point refused' }
  }
  $seen = @{}
  foreach ($path in $request.ancestorPaths) {
    $current = [IO.Path]::GetFullPath([string]$path)
    while ($current) {
      if ($seen.ContainsKey($current)) { break }
      $seen[$current] = $true
      $attributes = [IO.File]::GetAttributes($current)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point refused' }
      $parent = [IO.Directory]::GetParent($current)
      $current = if ($null -eq $parent) { $null } else { $parent.FullName }
    }
  }
  [Console]::Write('[]')
}
`

const CURRENT_USER_SCRIPT = String.raw`
& { [Console]::Write([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) }
`

/**
 * The scripts are fixed source. User paths are supplied as base64 arguments, so
 * PowerShell never parses a path as code or as a command-line fragment.
 */
const DESKTOP_CHECK_SCRIPT = String.raw`
& {
  param([string]$encodedRequest)
  $ErrorActionPreference = 'Stop'
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedRequest))
  try {
    $request = $decoded | ConvertFrom-Json
    $path = [string]$request.executable
    $dataRoot = if ([string]::IsNullOrWhiteSpace([string]$request.home)) { $null } else { [IO.Path]::GetFullPath([string]$request.home).TrimEnd('\') }
  } catch {
    $path = $decoded
    $dataRoot = $null
  }
  $expected = [IO.Path]::GetFullPath($path).TrimEnd('\')
  $expectedName = [IO.Path]::GetFileName($expected)
  $matches = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
    if ($dataRoot -and -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and ([string]$_.CommandLine).IndexOf($dataRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      return $true
    }
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals([string]$_.Name, $expectedName)) {
      return $false
    }
    if ([string]::IsNullOrWhiteSpace($_.ExecutablePath)) { throw 'Matching process path is unavailable' }
    try { $candidate = [IO.Path]::GetFullPath([string]$_.ExecutablePath).TrimEnd('\') }
    catch { return $false }
    [StringComparer]::OrdinalIgnoreCase.Equals($candidate, $expected)
  })
  if ($matches.Count -ne 0) { exit 17 }
  [Console]::Write('[]')
}
`

const RECYCLE_SCRIPT = String.raw`
& {
  param([string]$encodedRequest)
  $ErrorActionPreference = 'Stop'
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedRequest))
  $request = $json | ConvertFrom-Json
  if ($request.method -eq 'DeleteFile') {
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
      [string]$request.path,
      [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
      [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
      [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
  } elseif ($request.method -eq 'DeleteDirectory') {
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
      [string]$request.path,
      [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
      [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
      [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
  } else {
    throw 'Unsupported recycle operation'
  }
  [Console]::Write('{"ok":true}')
}
`

const RECYCLE_CENSUS_SCRIPT = String.raw`
& {
  param([string]$encodedRequest)
  $ErrorActionPreference = 'Stop'
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedRequest))
  $request = $json | ConvertFrom-Json
  $originalPath = [IO.Path]::GetFullPath([string]$request.path)
  $volumeRoot = [IO.Path]::GetPathRoot($originalPath)
  if ([string]::IsNullOrWhiteSpace($volumeRoot)) { throw 'Target has no volume root' }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $directory = [IO.Path]::Combine($volumeRoot, '$Recycle.Bin', $sid)
  $results = @()
  if (Test-Path -LiteralPath $directory -PathType Container) {
    foreach ($metadata in @(Get-ChildItem -LiteralPath $directory -Force -File -ErrorAction Stop)) {
      if (-not $metadata.Name.StartsWith('$I', [StringComparison]::OrdinalIgnoreCase)) { continue }
      $bytes = [IO.File]::ReadAllBytes($metadata.FullName)
      if ($bytes.Length -lt 24) { throw 'Invalid recycle metadata' }
      $version = [BitConverter]::ToUInt64($bytes, 0)
      if ($version -ne 1 -and $version -ne 2) { throw 'Unknown recycle metadata version' }
      $offset = if ($version -eq 1) { 24 } else { 28 }
      if ($bytes.Length -lt $offset -or (($bytes.Length - $offset) % 2) -ne 0) {
        throw 'Invalid recycle metadata path'
      }
      $original = [Text.Encoding]::Unicode.GetString($bytes, $offset, $bytes.Length - $offset).TrimEnd([char]0)
      if ([string]::IsNullOrWhiteSpace($original)) { throw 'Empty recycle metadata path' }
      $deletedAt = [DateTime]::FromFileTimeUtc([BitConverter]::ToInt64($bytes, 16))
      $recycle = [IO.Path]::Combine($directory, '$R' + $metadata.Name.Substring(2))
      $results += [PSCustomObject]@{
        metadataPath = $metadata.FullName
        recyclePath = $recycle
        originalPath = $original
        deletionTimeMs = ([DateTimeOffset]$deletedAt).ToUnixTimeMilliseconds()
      }
    }
  }
  [PSCustomObject]@{ entries = @($results) } | ConvertTo-Json -Compress -Depth 4
}
`

const encodePowerShellArgument = (value) => Buffer.from(value, 'utf8').toString('base64')
let currentUserSid

/** Run one fixed PowerShell script with opaque, base64 encoded request arguments. */
async function runPowerShell(script, request) {
  try {
    const { stdout } = await execFileAsync(
      POWERSHELL,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script.trim(),
        '--',
        encodePowerShellArgument(request),
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: MAX_POWER_SHELL_OUTPUT,
      },
    )
    return stdout
  } catch {
    throw new Error('PowerShell 操作失败')
  }
}

function runPowerShellSync(script, request) {
  try {
    const args = ['-NoProfile', '-NonInteractive', '-Command', script.trim()]
    if (request !== undefined) args.push('--', encodePowerShellArgument(request))
    return execFileSync(POWERSHELL, args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: MAX_POWER_SHELL_OUTPUT,
    })
  } catch {
    fail('无法核验 Windows 路径属性')
  }
}

function assertNativePathSafety(paths, ancestorPaths = paths) {
  if (process.platform === 'win32')
    runPowerShellSync(PATH_SAFETY_SCRIPT, JSON.stringify({ paths, ancestorPaths }))
}

function fail(message) {
  throw new Error(message)
}

function hostPathApi() {
  return process.platform === 'win32' ? win32 : { isAbsolute, resolve, relative, parse, sep }
}

function normalizedPath(path) {
  if (typeof path !== 'string' || path.length === 0) fail('路径必须是非空字符串')
  const api = hostPathApi()
  if (!api.isAbsolute(path)) fail('路径必须是绝对路径')
  const normalized = api.resolve(path)
  if (process.platform === 'win32') {
    const extendedPrefix = '\\\\?\\'
    const extendedUncPrefix = '\\\\?\\UNC\\'
    const extended = normalized.startsWith(extendedPrefix)
      ? normalized.startsWith(extendedUncPrefix)
        ? `\\${normalized.slice(extendedUncPrefix.length)}`
        : normalized.slice(4)
      : normalized
    return win32.normalize(extended)
  }
  return normalized
}

function comparisonPath(path) {
  const value = normalizedPath(path).replaceAll('/', '\\')
  if (process.platform !== 'win32') return value
  return value
    .replace(/[\\]+$/u, (trailing) => (trailing.length === value.length ? trailing : ''))
    .toLocaleLowerCase('en-US')
}

function isPathRoot(path) {
  const normalized = normalizedPath(path)
  return comparisonPath(normalized) === comparisonPath(hostPathApi().parse(normalized).root)
}

function statIsReparsePoint(stat) {
  return stat.isSymbolicLink()
}

function checkEntry(path, { allowMissing = false } = {}) {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return undefined
    fail(`无法读取目标路径: ${path}`)
  }
  if (statIsReparsePoint(stat)) fail(`目标包含符号链接或重解析点: ${path}`)
  return stat
}

/**
 * Reject reparse traversal in every existing parent component of a path.
 * @param {string} path - absolute path to inspect.
 * @returns {void}
 */
function assertNoReparseAncestors(path) {
  const normalized = normalizedPath(path)
  const api = hostPathApi()
  const parsed = api.parse(normalized)
  let current = parsed.root
  checkEntry(current)
  const pieces = normalized
    .slice(parsed.root.length)
    .split(/[\\/]+/u)
    .filter(Boolean)
  for (const piece of pieces) {
    current = api.join ? api.join(current, piece) : join(current, piece)
    if (!isMacSystemAliasPath(current)) checkEntry(current, { allowMissing: true })
  }
}

function isMacSystemAliasPath(path) {
  if (process.platform !== 'darwin') return false
  const current = resolve(path)
  if (!['/etc', '/tmp', '/var'].some((prefix) => current === prefix || current.startsWith(prefix + '/')))
    return false
  try {
    return realpathSync.native(current) === '/private' + current
  } catch {
    return false
  }
}

function canonicalExistingPath(path) {
  const normalized = normalizedPath(path)
  assertNoReparseAncestors(normalized)
  checkEntry(normalized)
  try {
    const canonical = realpathSync.native(normalized)
    assertNoReparseAncestors(canonical)
    return canonical
  } catch {
    fail(`无法解析目标路径: ${path}`)
  }
}

/**
 * Assert that a path is a non-root descendant of an existing root without
 * traversing a symlink, junction, mount point, or other reparse point.
 * @param {string} path - existing target path.
 * @param {string} root - existing directory that owns the target.
 * @returns {string} canonical target path.
 */
export function assertSafePath(path, root) {
  const canonicalRoot = canonicalExistingPath(root)
  const rootStat = checkEntry(canonicalRoot)
  if (!rootStat.isDirectory()) fail('安全路径根必须是目录')
  const api = hostPathApi()
  const comparablePath = (value) => {
    const normalized = normalizedPath(value)
    if (
      process.platform === 'darwin' &&
      ['/etc', '/tmp', '/var'].some(
        (prefix) => normalized === prefix || normalized.startsWith(prefix + '/'),
      )
    )
      return '/private' + normalized
    return normalized
  }
  const isDescendant = (candidate) => {
    const rootForRelative = comparablePath(canonicalRoot)
    const targetForRelative = comparablePath(candidate)
    const rootValue = process.platform === 'win32' ? rootForRelative.toLowerCase() : rootForRelative
    const targetValue = process.platform === 'win32' ? targetForRelative.toLowerCase() : targetForRelative
    const descendant = api.relative(rootValue, targetValue)
    return (
      descendant !== '' &&
      descendant !== '..' &&
      !descendant.startsWith(`..${api.sep}`) &&
      !api.isAbsolute(descendant)
    )
  }
  const normalizedTarget = normalizedPath(path)
  if (isPathRoot(normalizedTarget)) fail('不能操作文件系统根目录')
  if (!isDescendant(normalizedTarget)) fail('目标路径必须位于安全根目录内')
  const canonicalTarget = canonicalExistingPath(normalizedTarget)
  if (!isDescendant(canonicalTarget)) fail('目标路径必须位于安全根目录内')
  assertNativePathSafety([canonicalRoot, canonicalTarget], [canonicalRoot, canonicalTarget])
  return normalizedTarget
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function orderedTree(tree) {
  if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) fail('文件树格式无效')
  const result = {}
  for (const key of Object.keys(tree).sort((a, b) => a.localeCompare(b))) {
    const entry = tree[key]
    const pieces = key.split('/')
    if (
      !key ||
      key.includes('\\') ||
      key.startsWith('/') ||
      pieces.some(
        (piece, index) =>
          piece === '..' ||
          (piece === '.' && key !== '.' && key !== './') ||
          (piece === '' && index !== pieces.length - 1),
      )
    ) {
      fail('文件树包含无效相对路径')
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail('文件树摘要无效')
    if (
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !/^[0-9a-f]{64}$/iu.test(entry.sha256)
    ) {
      fail('文件树摘要无效')
    }
    result[key.replaceAll('\\', '/')] = { bytes: entry.bytes, sha256: entry.sha256.toLowerCase() }
  }
  return result
}

function treeEqual(left, right) {
  const a = orderedTree(left)
  const b = orderedTree(right)
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(
    (key, index) =>
      key === bKeys[index] && a[key].bytes === b[key].bytes && a[key].sha256 === b[key].sha256,
  )
}

/**
 * Return a deterministic SHA-256 tree after rejecting all link/reparse entries.
 * @param {string} path - existing file or directory.
 * @returns {Record<string, {bytes: number, sha256: string}>} relative file tree.
 */
function readSafeTree(path, extraPaths = []) {
  const canonical = canonicalExistingPath(path)
  if (isPathRoot(canonical)) fail('不能操作文件系统根目录')
  const rootStat = checkEntry(canonical)
  const result = {}
  const paths = [canonical, ...extraPaths]
  if (rootStat.isFile()) {
    const bytes = readFileSync(canonical)
    const after = checkEntry(canonical)
    if (
      !after.isFile() ||
      after.size !== bytes.length ||
      after.mtimeMs !== rootStat.mtimeMs ||
      after.ino !== rootStat.ino
    )
      fail('目标在读取期间发生变化')
    assertNativePathSafety(paths, paths)
    result['.'] = { bytes: bytes.length, sha256: hashBytes(bytes) }
    return result
  }
  if (!rootStat.isDirectory()) fail('目标必须是普通文件或目录')

  const visit = (directory, prefix) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    if (entries.length === 0)
      result[prefix ? `${prefix}/` : './'] = { bytes: 0, sha256: hashBytes(Buffer.alloc(0)) }
    for (const entry of entries) {
      const next = join(directory, entry.name)
      const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name
      const before = checkEntry(next)
      paths.push(next)
      if (before.isDirectory()) visit(next, relativeName)
      else if (before.isFile()) {
        const bytes = readFileSync(next)
        const after = checkEntry(next)
        if (
          !after.isFile() ||
          after.size !== bytes.length ||
          after.mtimeMs !== before.mtimeMs ||
          after.ino !== before.ino
        )
          fail('目标在读取期间发生变化')
        result[relativeName.replaceAll('\\', '/')] = {
          bytes: bytes.length,
          sha256: hashBytes(bytes),
        }
      } else fail(`目标包含非普通文件: ${next}`)
    }
  }
  visit(canonical, '')
  assertNativePathSafety(paths, paths)
  return result
}

/**
 * Return a deterministic SHA-256 tree after rejecting all link/reparse entries.
 * @param {string} path - existing file or directory.
 * @returns {Record<string, {bytes: number, sha256: string}>} relative file tree.
 */
export function safeTree(path) {
  return readSafeTree(path)
}

/**
 * Ensure no process has the exact normalized executable path.
 * @param {string} executable - expected Desktop executable path.
 * @param {string} [home] - optional DSH home used only by the private census check.
 *   Command-line text is never returned or included in errors.
 * @returns {Promise<void>} resolves only when no matching process exists.
 */
export async function assertDesktopStopped(executable, home) {
  if (process.platform !== 'win32') fail('Desktop 进程检查仅支持 Windows')
  const path = normalizedPath(executable)
  try {
    await runPowerShell(DESKTOP_CHECK_SCRIPT, JSON.stringify({ executable: path, home }))
  } catch {
    throw new Error('目标 Desktop 仍在运行，或无法读取进程清单')
  }
}

function parseMetadata(path) {
  let bytes
  try {
    bytes = readFileSync(path)
  } catch {
    fail('无法读取回收站元数据')
  }
  if (bytes.length < 24) fail('回收站元数据无效')
  const version = Number(bytes.readBigUInt64LE(0))
  if (version !== 1 && version !== 2) fail('回收站元数据版本未知')
  const offset = version === 1 ? 24 : 28
  if (bytes.length < offset || (bytes.length - offset) % 2 !== 0) fail('回收站元数据路径无效')
  const originalPath = bytes.toString('utf16le', offset).replace(/\u0000+$/u, '')
  if (!originalPath) fail('回收站元数据路径为空')
  let deletionTimeMs
  try {
    const fileTime = bytes.readBigInt64LE(16)
    deletionTimeMs = Number(fileTime / 10_000n - 11_644_473_600_000n)
  } catch {
    fail('回收站元数据时间无效')
  }
  return { originalPath, deletionTimeMs }
}

function validateReceipt(receipt) {
  if (receipt === null || typeof receipt !== 'object') fail('回收凭据无效')
  for (const key of ['originalPath', 'recyclePath', 'metadataPath']) {
    if (typeof receipt[key] !== 'string' || !receipt[key]) fail('回收凭据无效')
  }
  const originalPath = normalizedPath(receipt.originalPath)
  const recyclePath = normalizedPath(receipt.recyclePath)
  const metadataPath = normalizedPath(receipt.metadataPath)
  const recycleName = win32.basename(recyclePath)
  const metadataName = win32.basename(metadataPath)
  if (!/^\$R[^\\/]+$/iu.test(recycleName) || !/^\$I[^\\/]+$/iu.test(metadataName))
    fail('回收凭据文件名无效')
  if (recycleName.slice(2).toLowerCase() !== metadataName.slice(2).toLowerCase())
    fail('回收凭据不匹配')
  if (comparisonPath(dirname(recyclePath)) !== comparisonPath(dirname(metadataPath)))
    fail('回收凭据目录不匹配')
  const recycleDirectory = dirname(recyclePath)
  const recycleParent = dirname(recycleDirectory)
  if (win32.basename(recycleParent).toLocaleLowerCase('en-US') !== '$recycle.bin')
    fail('回收凭据位置无效')
  const recycleDirectoryName = win32.basename(recycleDirectory)
  if (!/^S-\d(?:-\d+)+$/iu.test(recycleDirectoryName)) fail('回收凭据用户目录无效')
  if (process.platform === 'win32') {
    currentUserSid ??= runPowerShellSync(CURRENT_USER_SCRIPT).trim()
    const sid = currentUserSid
    if (!sid || recycleDirectoryName.toLowerCase() !== sid.toLowerCase())
      fail('回收凭据不属于当前用户')
    const expectedDirectory = win32.join(win32.parse(originalPath).root, '$Recycle.Bin', sid)
    if (comparisonPath(recycleDirectory) !== comparisonPath(expectedDirectory))
      fail('回收凭据卷不匹配')
  }
  assertNoReparseAncestors(recyclePath)
  checkEntry(metadataPath)
  checkEntry(recyclePath)
  return { originalPath, recyclePath, metadataPath }
}

/**
 * Verify a receipt's original path metadata and the complete recycled tree.
 * @param {{path: string, tree: object}} target - original target snapshot.
 * @param {{originalPath: string, recyclePath: string, metadataPath: string}} receipt - recycle receipt.
 * @returns {true} true after all hashes match.
 */
export function verifyRecycledTarget(target, receipt) {
  if (target === null || typeof target !== 'object') fail('目标无效')
  const expectedPath = normalizedPath(target.path)
  const expectedTree = orderedTree(target.tree)
  const checked = validateReceipt(receipt)
  if (comparisonPath(expectedPath) !== comparisonPath(checked.originalPath))
    fail('回收原路径不匹配')
  const metadata = parseMetadata(checked.metadataPath)
  if (comparisonPath(expectedPath) !== comparisonPath(metadata.originalPath))
    fail('回收元数据原路径不匹配')
  const actualTree = readSafeTree(checked.recyclePath, [checked.metadataPath])
  if (!treeEqual(expectedTree, actualTree)) fail('回收内容哈希不匹配')
  return true
}

function targetForIO(target) {
  if (target === null || typeof target !== 'object') fail('目标无效')
  const canonicalPath = canonicalExistingPath(target.path)
  if (isPathRoot(canonicalPath)) fail('不能操作文件系统根目录')
  const actualTree = safeTree(canonicalPath)
  const expectedTree = orderedTree(target.tree)
  if (!treeEqual(expectedTree, actualTree)) fail('目标文件已变化')
  const stat = checkEntry(canonicalPath)
  return {
    path: canonicalPath,
    tree: actualTree,
    method: stat.isDirectory()
      ? 'DeleteDirectory'
      : stat.isFile()
        ? 'DeleteFile'
        : fail('目标必须是普通文件或目录'),
  }
}

/**
 * Move an exact, pre-hashed target to the Windows Recycle Bin and verify it.
 * @param {{path: string, tree: object}} target - target path and frozen file tree.
 * @returns {Promise<{originalPath: string, recyclePath: string, metadataPath: string}>} verified receipt.
 */
export async function recycleTarget(target) {
  if (process.platform !== 'win32') fail('Windows 回收站仅支持 Windows')
  const prepared = targetForIO(target)
  const sinceMs = Date.now()
  await runPowerShell(
    RECYCLE_SCRIPT,
    JSON.stringify({ path: prepared.path, method: prepared.method }),
  )
  if (existsSync(prepared.path)) fail('回收操作后目标仍存在')
  const receipt = await findRecycledTarget(prepared, sinceMs)
  if (receipt === null) fail('未找到对应的回收站条目')
  return receipt
}

/**
 * Find the unique current-user Recycle Bin entry created after an operation began.
 * @param {{path: string, tree: object}} target - original target snapshot.
 * @param {number} sinceMs - persisted operation start timestamp in Unix milliseconds.
 * @returns {Promise<{originalPath: string, recyclePath: string, metadataPath: string}|null>} receipt or null.
 */
export async function findRecycledTarget(target, sinceMs) {
  if (process.platform !== 'win32') fail('Windows 回收站仅支持 Windows')
  if (!Number.isFinite(sinceMs)) fail('回收操作时间无效')
  const expectedPath = normalizedPath(target?.path)
  const tree = orderedTree(target?.tree)
  const stdout = await runPowerShell(
    RECYCLE_CENSUS_SCRIPT,
    JSON.stringify({ path: expectedPath, sinceMs }),
  )
  let entries
  try {
    entries = JSON.parse(stdout.trim()).entries
  } catch {
    fail('回收站清单无效')
  }
  if (!Array.isArray(entries)) fail('回收站清单无效')
  const now = Date.now() + RECYCLE_TIME_FUTURE_TOLERANCE_MS
  const matches = entries.filter((entry) => {
    if (entry === null || typeof entry !== 'object') fail('回收站清单项无效')
    if (
      typeof entry.originalPath !== 'string' ||
      typeof entry.recyclePath !== 'string' ||
      typeof entry.metadataPath !== 'string' ||
      !Number.isFinite(entry.deletionTimeMs)
    )
      fail('回收站清单项无效')
    return (
      comparisonPath(entry.originalPath) === comparisonPath(expectedPath) &&
      entry.deletionTimeMs >= sinceMs &&
      entry.deletionTimeMs <= now
    )
  })
  if (matches.length === 0) return null
  if (matches.length !== 1) fail('对应的回收站条目不唯一')
  const receipt = {
    originalPath: matches[0].originalPath,
    recyclePath: matches[0].recyclePath,
    metadataPath: matches[0].metadataPath,
  }
  verifyRecycledTarget({ path: expectedPath, tree }, receipt)
  return receipt
}
