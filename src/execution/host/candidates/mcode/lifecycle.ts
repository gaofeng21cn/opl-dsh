/**
 * MiniMax Bash 候选版的生命周期：可校验导入、版本目录、显式选择、升级与切回官方。
 *
 * 失败语义：任何一步失败都保持原样。选择回执只在全部检查通过后用临时文件 + rename 原子
 * 替换；导入失败留下的半成品会被改名成 `<版本>.failed-<时间戳>` 保留，不会被选择。
 */
import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { distribution, verifyOfficialDistribution } from './distribution.ts'
import {
  assertCandidateVersion,
  assertRelativeInside,
  containsPath,
  mkdirp,
  officialProtectedRoots,
  overlapsPath,
  plan,
  resolveCommandPath,
  resolveThroughExistingAncestors,
  sha256File,
  suiteOwnedRoots,
} from './shared.ts'
import {
  candidateFiles,
  detectCapabilities,
  launcherContent,
  licenseTargets,
  scanForCredentials,
  verifyExternalModuleClosure,
} from './verification.ts'

export const LIFECYCLE_SCHEMA_VERSION = 1
/** 候选在套件 Harness 根目录里的 harnessRef，与安装回执 installation.candidate 一致。 */
export const HARNESS_REF = 'MiniMax Code'
export const SELECTION_FILE = 'selection.json'
export const VERIFICATION_DIR = 'verification'
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)-opl-bash\.(\d{8})\.(\d+)$/
/** 本模块从不联网；这个常量进计划与回执，供他人核对。 */
export const NETWORK_ACCESS = false

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

export interface ManifestFileEntry {
  file: string
  sha256: string
  bytes: number
}

export interface CandidateManifest {
  version: string
  distribution?: string
  toolchainStubbed?: boolean
  nodeRuntime?: { path?: string }
  externalModules?: { copied?: string[] }
  files: ManifestFileEntry[]
  [key: string]: unknown
}

export interface SelectionEntry {
  kind: 'candidate' | 'official'
  version: string | null
  launcher: string | null
  launcherSha256: string | null
  manifestSha256?: string | null
  officialBase?: string
  verifiedAt?: string
  at?: string | null
}

export interface CandidateReceiptEntry {
  version: string
  launcher: string | null
  launcherSha256: string | null
  manifestSha256: string | null
  importedAt: string | null
  verified: boolean
}

export interface LifecycleReceipt {
  schemaVersion: number
  harnessRef: string
  storeRoot: string
  updatedAt: string
  selection: SelectionEntry
  official: Record<string, unknown>
  preserved: Record<string, unknown>
  history: SelectionEntry[]
  candidates: CandidateReceiptEntry[]
}

export interface LifecycleOptions {
  store?: string | undefined
  source?: string | undefined
  manifest?: string | undefined
  version?: string | undefined
  select?: boolean | undefined
  replace?: boolean | undefined
  upgrade?: boolean | undefined
  dryRun?: boolean | undefined
  activeTasks?: string | number | undefined
  activity?: string | undefined
  allowRoots?: string[] | undefined
  extraRoots?: string[] | undefined
  officialLauncher?: string | undefined
  allowSameOrOlder?: boolean | undefined
  env?: NodeJS.ProcessEnv | undefined
}

export interface VerifyImportOptions {
  manifestPath?: string | undefined
  version?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  extraRoots?: string[] | undefined
}

export interface ActiveTasksResolution {
  activeTasks: number
  source: string
  injected: true
  note: string
}

const required = (value: unknown, flag: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`必须提供 ${flag}。`)
  return value
}

// ---------------------------------------------------------------- 位置与边界

/** 允许写候选的根目录：套件自有 Harness 根 + 调用方显式声明的 `--allow-root`。 */
export function allowedStoreRoots(
  env: NodeJS.ProcessEnv = process.env,
  allowRoots: string[] = [],
): string[] {
  return [
    ...new Set([
      ...suiteOwnedRoots(env),
      ...allowRoots.filter(Boolean).map((value) => resolveThroughExistingAncestors(value)),
    ]),
  ]
}

export function defaultStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const suites = suiteOwnedRoots(env)
  if (!suites.length)
    throw new Error(
      '无法确定套件根目录（环境里没有 APPDATA/LOCALAPPDATA）；请显式给出 --store 与 --allow-root。',
    )
  return join(suites[0], 'harnesses', HARNESS_REF)
}

/**
 * 候选 Store 根目录的写入闸门。和构建脚本不同，这里允许写套件自有的 Harness 根目录
 * （这正是导入的目的），但官方安装目录、官方登录数据与 OPL profile 仍然一律拒写；
 * 套件根之外的位置必须由调用方用 `--allow-root` 显式声明。
 */
export function assertStoreRoot(
  storeRoot: unknown,
  {
    env = process.env,
    allowRoots = [],
    extraRoots = [],
    label = '候选 Store 根目录',
  }: {
    env?: NodeJS.ProcessEnv | undefined
    allowRoots?: string[] | undefined
    extraRoots?: string[] | undefined
    label?: string | undefined
  } = {},
): string {
  const inside = resolveThroughExistingAncestors(required(storeRoot, '--store <目录>'))
  if (!isAbsolute(inside)) throw new Error(`${label}必须是绝对路径，收到 ${String(storeRoot)}。`)
  for (const forbidden of officialProtectedRoots(env, extraRoots))
    if (overlapsPath(forbidden, inside))
      throw new Error(
        `${label} ${inside} 与官方安装、官方登录数据或 OPL profile ${forbidden} 重叠，拒绝写入。`,
      )
  const allowed = allowedStoreRoots(env, allowRoots)
  if (!allowed.some((base) => containsPath(base, inside)))
    throw new Error(`${label} ${inside} 不在套件自有根目录内；请用 --allow-root 显式声明这个位置。`)
  return inside
}

export function selectionPath(storeRoot: string): string {
  return join(storeRoot, SELECTION_FILE)
}
export function versionDir(storeRoot: string, version: string): string {
  return join(storeRoot, version)
}
export function verificationDir(storeRoot: string, version: string): string {
  return join(storeRoot, VERIFICATION_DIR, version)
}

/**
 * 派生输出的统一写入闸门。每个派生目标都要按真实路径规范化后重新判定：
 * 必须仍在同一个 Store 内，且不得与官方安装、官方登录数据或 OPL profile 重叠。
 */
export function assertDerivedTarget(
  target: unknown,
  {
    storeRoot,
    env = process.env,
    extraRoots = [],
    label = '派生输出',
  }: {
    storeRoot: string
    env?: NodeJS.ProcessEnv | undefined
    extraRoots?: string[] | undefined
    label?: string | undefined
  },
): string {
  if (typeof target !== 'string' || !isAbsolute(target))
    throw new Error(`${label}必须是绝对路径，收到 ${JSON.stringify(target)}。`)
  const store = resolveThroughExistingAncestors(storeRoot)
  const inside = resolveThroughExistingAncestors(target)
  if (!containsPath(store, inside))
    throw new Error(
      `${label} ${inside} 不在候选 Store ${store} 内（可能是符号链接/junction 指向外部），拒绝写入。`,
    )
  for (const forbidden of officialProtectedRoots(env, extraRoots))
    if (overlapsPath(forbidden, inside))
      throw new Error(`${label} ${inside} 与受保护目录 ${forbidden} 重叠，拒绝写入。`)
  return inside
}

/** 先把 Store 内将要写到的每个派生路径全部验证一遍，再开始任何写入。 */
function assertDerivedTargets(
  storeRoot: string,
  targets: Array<{ path: string; label: string }>,
  { env, extraRoots = [] }: { env: NodeJS.ProcessEnv; extraRoots?: string[] | undefined },
): string[] {
  return targets.map(({ path, label }) =>
    assertDerivedTarget(path, { storeRoot, env, extraRoots, label }),
  )
}

/** 只读列出 Store 里的候选版本目录；`verification/` 与改名保留的目录不算候选。 */
export function listImportedVersions(storeRoot: string): string[] {
  if (!existsSync(storeRoot)) return []
  return readdirSync(storeRoot, { withFileTypes: true })
    .filter((item) => item.isDirectory() && VERSION_PATTERN.test(item.name))
    .map((item) => item.name)
    .sort(compareVersions)
}

/** `0.6.3-opl-bash.20261010.2` 之类的候选版本号比较：官方段、日期、序号依次比较。 */
export function compareVersions(left: unknown, right: unknown): number {
  const a = VERSION_PATTERN.exec(String(left ?? ''))
  const b = VERSION_PATTERN.exec(String(right ?? ''))
  if (!a || !b) throw new Error(`无法比较候选版本号：${String(left)} 与 ${String(right)}。`)
  for (let index = 1; index <= 5; index += 1) {
    const diff = Number(a[index]) - Number(b[index])
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

// ---------------------------------------------------------------- 选择回执

/**
 * 读取选择回执。文件不存在返回 undefined；存在但损坏或版本不符则报错，
 * 绝不把无法理解的回执当成空回执覆盖。
 */
export function readSelection(storeRoot: string): LifecycleReceipt | undefined {
  const path = selectionPath(storeRoot)
  if (!existsSync(path)) return undefined
  let parsed: Partial<LifecycleReceipt>
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`选择回执已损坏，拒绝覆盖：${path}（${(error as Error).message}）`)
  }
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== LIFECYCLE_SCHEMA_VERSION)
    throw new Error(`选择回执 schemaVersion 不受支持，拒绝覆盖：${path}`)
  if (!parsed.selection || !['candidate', 'official'].includes(parsed.selection.kind))
    throw new Error(`选择回执缺少有效的 selection.kind，拒绝覆盖：${path}`)
  return parsed as LifecycleReceipt
}

/** 原子写选择回执：临时文件 + rename；失败不会留下半份回执。 */
function writeSelection(
  storeRoot: string,
  receipt: LifecycleReceipt,
  {
    env = process.env,
    extraRoots = [],
  }: { env?: NodeJS.ProcessEnv | undefined; extraRoots?: string[] | undefined } = {},
): string {
  const target = selectionPath(storeRoot)
  return writeJsonAtomically(storeRoot, target, receipt, { env, extraRoots })
}

/** 回执和报告均创建独占临时文件后替换目录项，不改写现存硬链接所引用的文件。 */
function writeJsonAtomically(
  storeRoot: string,
  target: string,
  value: unknown,
  { env, extraRoots }: { env: NodeJS.ProcessEnv; extraRoots: string[] },
): string {
  const temporary = `${target}.${randomUUID()}.tmp`
  assertDerivedTargets(
    storeRoot,
    [
      { path: temporary, label: '回执临时文件' },
      { path: target, label: '选择回执' },
    ],
    { env, extraRoots },
  )
  mkdirp(dirname(temporary))
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  try {
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      /* 保留原错误 */
    }
    throw error
  }
  return target
}

/**
 * 生成新的选择回执。`preserved` 是不透明状态，原样搬运；`candidates` 由只读扫描得出，
 * 旧候选目录既不删除也不从列表里消失。
 */
export function buildReceipt({
  storeRoot,
  previous,
  selection,
  official,
  now = new Date().toISOString(),
}: {
  storeRoot: string
  previous: LifecycleReceipt | undefined
  selection: SelectionEntry
  official: Record<string, unknown>
  now?: string
}): LifecycleReceipt {
  const history = previous?.history ? [...previous.history] : []
  if (
    previous?.selection &&
    (previous.selection.kind !== selection.kind ||
      previous.selection.version !== selection.version ||
      previous.selection.launcher !== selection.launcher)
  )
    history.push({ ...previous.selection, at: previous.updatedAt ?? null })
  const known = new Map((previous?.candidates ?? []).map((item) => [item.version, item]))
  const candidates: CandidateReceiptEntry[] = listImportedVersions(storeRoot).map((version) => {
    const entry = known.get(version)
    const launcher = join(versionDir(storeRoot, version), plan.launcher.windows)
    return {
      version,
      launcher: existsSync(launcher) ? launcher : null,
      launcherSha256: existsSync(launcher) ? sha256File(launcher) : null,
      manifestSha256: entry?.manifestSha256 ?? null,
      importedAt: entry?.importedAt ?? null,
      verified: entry?.verified ?? false,
    }
  })
  return {
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    harnessRef: HARNESS_REF,
    storeRoot,
    updatedAt: now,
    selection,
    official,
    preserved: previous?.preserved ?? {},
    history: history.slice(-50),
    candidates,
  }
}

// ---------------------------------------------------------------- 候选校验

function resolveManifestPath(sourceDir: string, manifestPath: string | undefined): string {
  if (manifestPath) {
    const explicit = resolve(manifestPath)
    if (!existsSync(explicit)) throw new Error(`清单不存在：${explicit}`)
    return explicit
  }
  for (const candidate of [
    join(sourceDir, 'manifest.json'),
    join(dirname(sourceDir), 'candidate-manifest.json'),
  ])
    if (existsSync(candidate)) return candidate
  throw new Error(`未找到清单：${sourceDir} 内没有 manifest.json，也没有 --manifest。`)
}

/** 候选目录里不允许出现符号链接：导入不能把官方安装或账号目录链接进来。 */
function collectSymlinks(
  directory: string,
  found: string[] = [],
  current: string = directory,
): string[] {
  for (const item of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, item.name)
    if (item.isSymbolicLink()) {
      found.push(path)
      continue
    }
    if (item.isDirectory()) collectSymlinks(directory, found, path)
  }
  return found
}

/** 扫描 bundle 里声明的标记串：bundle 缺失或标记缺失都按失败暴露。 */
function scanBundleMarkers(candidateDir: string, markers: string[]) {
  const files: string[] = []
  const walk = (current: string) => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, item.name)
      if (item.isDirectory()) walk(path)
      else if (item.isFile() && /\.m?js$/.test(item.name)) files.push(path)
    }
  }
  for (const name of ['chunks', 'overlay']) {
    const root = join(candidateDir, name)
    if (existsSync(root)) walk(root)
  }
  const haystack = files.map((file) => readFileSync(file, 'utf8')).join('\n')
  return {
    scanned: files.length > 0,
    missing: markers.filter((marker) => !haystack.includes(marker)),
  }
}

/**
 * 启动器必须是完整的已知模板，而不是「包含若干合法子串」。
 */
function launcherGrammarCheck(actualLauncher: string): {
  ok: boolean
  runtime: string | null
  detail: string
} {
  const template = launcherContent(undefined).split('\r\n')
  const normalized = String(actualLauncher).replaceAll('\r\n', '\n')
  const lines = normalized.split('\n')
  if (lines.length !== template.length)
    return {
      ok: false,
      runtime: null,
      detail: `启动器行数 ${lines.length} ≠ 模板 ${template.length} 行，只允许运行时那一行变化`,
    }
  const runtimeLineIndex = template.findIndex((line) => line.includes('"%~dp0cli.js" %*'))
  for (let index = 0; index < template.length; index += 1) {
    if (index === runtimeLineIndex) continue
    if (lines[index] !== template[index])
      return {
        ok: false,
        runtime: null,
        detail: `启动器第 ${index + 1} 行与已知模板不符：${JSON.stringify(lines[index])}`,
      }
  }
  const match = /^(.+?) "%~dp0cli\.js" %\*$/.exec(lines[runtimeLineIndex] ?? '')
  if (!match)
    return {
      ok: false,
      runtime: null,
      detail: `运行时行不符合模板：${JSON.stringify(lines[runtimeLineIndex])}`,
    }
  const token = match[1]
  const allowedToken = token === 'node' || /^"(?:[A-Za-z]:[\\/][^"]*|%~dp0[^"]*)"$/.test(token)
  if (!allowedToken)
    return { ok: false, runtime: null, detail: `不允许的运行时写法：${JSON.stringify(token)}` }
  return { ok: true, runtime: token, detail: `已知模板，运行时行：${token}` }
}

/** 运行时 token → 清单里应声明的 `nodeRuntime.path`（`system-node` 表示 PATH 上的 node）。 */
function runtimeTokenToDeclared(token: string): string {
  if (token === 'node') return 'system-node'
  const inner = token.slice(1, -1)
  return inner.startsWith('%~dp0') ? inner.slice('%~dp0'.length) : inner
}

/**
 * 运行时一致性：启动器引用的运行时必须与清单声明一致，或者是候选目录内的等价可携带形态。
 */
function launcherRuntimeCheck(
  runtimeToken: string | null,
  {
    base,
    declared,
    declaredNode,
  }: { base: string; declared: Set<string>; declaredNode: string | undefined },
): [boolean, string] {
  if (!runtimeToken) return [false, '启动器语法未通过，运行时无法判定']
  const declaredValue = declaredNode ?? 'system-node'
  const declaredPath =
    typeof declaredValue === 'string' ? declaredValue.replaceAll('\\', '/') : declaredValue
  const tokenDeclared = runtimeTokenToDeclared(runtimeToken)
  const tokenPath = tokenDeclared.replaceAll('\\', '/')

  if (tokenDeclared === declaredPath) {
    if (tokenDeclared !== 'system-node' && !isAbsolute(tokenDeclared) && !declared.has(tokenPath))
      return [false, `启动器引用的运行时未被清单摘要覆盖：${tokenPath}`]
    return [true, `与清单声明的运行时一致：${declaredValue}`]
  }
  if (declaredPath === 'system-node' && tokenPath !== 'system-node') {
    if (isAbsolute(tokenDeclared))
      return [false, `清单声明 system-node，启动器却写死绝对运行时 ${tokenDeclared}；两者必须一致`]
    if (tokenPath.split('/').includes('..') || tokenPath.startsWith('/'))
      return [false, `启动器引用的运行时逃出候选目录：${tokenPath}`]
    if (!existsSync(join(base, ...tokenPath.split('/'))))
      return [false, `启动器引用的运行时不存在：${tokenPath}`]
    if (!declared.has(tokenPath)) return [false, `启动器引用的运行时未被清单摘要覆盖：${tokenPath}`]
    return [true, `候选内运行时已被清单覆盖：${tokenPath}`]
  }
  return [
    false,
    `启动器运行时 ${JSON.stringify(tokenDeclared)} 与清单声明 ${JSON.stringify(declaredValue)} 不一致`,
  ]
}

export interface VerifyImportResult {
  version: string | null
  manifestPath: string | null
  base: string
  manifest?: CandidateManifest
  capabilities?: ReturnType<typeof detectCapabilities>
  launcherPath?: string
  externalClosure?: ReturnType<typeof verifyExternalModuleClosure>
  checks: CheckResult[]
  passed: boolean
  failed: string[]
  manifestSha256: string | null
  launcherSha256: string | null
  networkUsed: boolean
}

/**
 * 导入前的只读校验：版本、摘要、能力、许可证。不执行候选代码、不联网。
 * 返回的 `passed` 为 false 时调用方不得复制或选择；`checks` 逐项给出原因。
 */
export function verifyImportCandidate(
  sourceDir: string,
  { manifestPath, version, env = process.env, extraRoots = [] }: VerifyImportOptions = {},
): VerifyImportResult {
  const checks: CheckResult[] = []
  const check = (name: string, ok: unknown, detail = '') => {
    checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 2000) })
    return !!ok
  }
  const base = resolve(sourceDir)
  check('source-present', existsSync(base) && statSync(base).isDirectory(), base)

  let officialOverlap = ''
  try {
    const forbiddenRoots = [
      ...officialProtectedRoots(env, extraRoots),
      ...officialProtectedRoots(process.env, extraRoots),
    ]
    for (const forbidden of forbiddenRoots)
      if (overlapsPath(forbidden, base)) officialOverlap = forbidden
  } catch (error) {
    officialOverlap = `无法规范化路径：${(error as Error).message}`
  }
  check('source-not-official-install', !officialOverlap, officialOverlap || '不在受保护目录内')

  let symlinks: string[] = []
  if (existsSync(base) && statSync(base).isDirectory()) {
    try {
      symlinks = collectSymlinks(base)
    } catch (error) {
      symlinks = [`无法遍历：${(error as Error).message}`]
    }
  }
  check(
    'source-no-symlinks',
    symlinks.length === 0,
    symlinks.length ? `发现符号链接：${symlinks.slice(0, 3).join(', ')}` : '无符号链接',
  )

  let manifestFile: string
  let manifest: CandidateManifest
  try {
    manifestFile = resolveManifestPath(base, manifestPath)
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    check('manifest-present', true, manifestFile)
  } catch (error) {
    check('manifest-present', false, (error as Error).message)
    return finish(checks, { version: null, manifestPath: null, base })
  }
  const manifestInside = manifestFile === base || manifestFile.startsWith(base + sep)
  const schemaOk =
    manifest &&
    typeof manifest.version === 'string' &&
    Array.isArray(manifest.files) &&
    manifest.files.every(
      (entry) =>
        entry &&
        typeof entry.file === 'string' &&
        typeof entry.sha256 === 'string' &&
        Number.isInteger(entry.bytes),
    )
  check('manifest-schema', schemaOk, schemaOk ? `${manifest.files.length} 个条目` : '清单结构无效')
  if (!schemaOk) return finish(checks, { version: null, manifestPath: manifestFile, base })

  const duplicatePaths = [
    ...new Set(
      manifest.files
        .map((entry) => String(entry.file))
        .filter((file, index, all) => all.indexOf(file) !== index),
    ),
  ]
  check(
    'manifest-unique-paths',
    duplicatePaths.length === 0,
    duplicatePaths.length ? `重复条目：${duplicatePaths.slice(0, 3).join(', ')}` : '无重复条目',
  )

  const declaredVersion = manifest.version
  const npmOverlay = manifest.distribution === 'official-npm-overlay'
  const officialBase = npmOverlay ? String(declaredVersion).split('-')[0] : plan.official.version
  const shapeOk = VERSION_PATTERN.test(declaredVersion)
  check('version-declared', shapeOk, declaredVersion)
  check(
    'version-matches-official-base',
    shapeOk && declaredVersion.startsWith(`${officialBase}-opl-bash.`),
    `官方基线 ${officialBase}`,
  )
  check(
    'version-requested-matches',
    !version || version === declaredVersion,
    version ? `请求 ${version}，清单 ${declaredVersion}` : '未额外指定',
  )
  let versionAccepted = false
  let versionRejection = '版本号格式或官方基线不符'
  if (shapeOk && declaredVersion.startsWith(`${officialBase}-opl-bash.`)) {
    try {
      assertCandidateVersion(declaredVersion)
      versionAccepted = true
      versionRejection = ''
    } catch (error) {
      versionRejection = (error as Error).message
    }
  }
  check(
    'version-accepted-by-plan',
    versionAccepted,
    versionAccepted ? declaredVersion : versionRejection,
  )

  const stubbed = manifest.toolchainStubbed === true
  check('toolchain-not-stubbed', !stubbed, stubbed ? '替身工具链产物，不可导入' : '真实工具链')
  if (npmOverlay) {
    try {
      const result = verifyOfficialDistribution(join(base, 'official'), officialBase)
      check('official-npm-unchanged', true, `${result.version}: ${result.files} files`)
    } catch (error) {
      check('official-npm-unchanged', false, (error as Error).message)
    }
  }

  for (const requiredFile of ['cli.js', plan.launcher.windows, 'package.json', 'CANDIDATE.md'])
    check(
      `layout:${requiredFile}`,
      existsSync(join(base, requiredFile)),
      existsSync(join(base, requiredFile)) ? requiredFile : `缺少 ${requiredFile}`,
    )

  let packageIdentity = ''
  let packageOk = false
  try {
    const manifestPackage = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'))
    const expectedName = plan.official.packageName
    const nameOk = manifestPackage.name === expectedName
    const versionOk = manifestPackage.version === declaredVersion
    packageOk = nameOk && versionOk
    packageIdentity = packageOk
      ? `${manifestPackage.name}@${manifestPackage.version}`
      : [
          nameOk
            ? ''
            : `包名 ${JSON.stringify(manifestPackage.name)} ≠ ${JSON.stringify(expectedName)}`,
          versionOk
            ? ''
            : `包版本 ${JSON.stringify(manifestPackage.version)} ≠ 清单版本 ${JSON.stringify(declaredVersion)}`,
        ]
          .filter(Boolean)
          .join('；')
  } catch (error) {
    packageIdentity = `package.json 无法解析：${(error as Error).message}`
  }
  check('candidate-package-identity', packageOk, packageIdentity)

  const declared = new Set(manifest.files.map((entry) => assertRelativeInside(entry.file)))

  const declaredNode = manifest.nodeRuntime?.path
  const launcherPath = join(base, plan.launcher.windows)
  const actualLauncher = existsSync(launcherPath) ? readFileSync(launcherPath, 'utf8') : ''
  const grammar = launcherGrammarCheck(actualLauncher)
  check('launcher-grammar', grammar.ok, grammar.detail)
  check(
    'launcher-runtime-resolvable',
    ...launcherRuntimeCheck(grammar.runtime, {
      base,
      declared,
      declaredNode,
    }),
  )

  const licenses = (npmOverlay ? distribution.license.files : licenseTargets()).map((file) =>
    file.split(sep).join('/'),
  )
  const missingLicenses = licenses.filter((file) => !existsSync(join(base, file)))
  check(
    'licenses-present',
    missingLicenses.length === 0,
    missingLicenses.length
      ? `缺少 ${missingLicenses.slice(0, 3).join(', ')}`
      : `${licenses.length} 份`,
  )
  const emptyLicenses = licenses.filter((file) => {
    const path = join(base, file)
    return existsSync(path) && readFileSync(path).length === 0
  })
  check('licenses-non-empty', emptyLicenses.length === 0, emptyLicenses.join(', ') || '非空')
  if (npmOverlay)
    check(
      'official-license-digest',
      existsSync(join(base, 'LICENSE')) &&
        sha256File(join(base, 'LICENSE')) === distribution.license.sha256,
    )

  try {
    scanForCredentials(base)
    check('no-credentials', true, '候选目录内未发现凭据或官方账号数据')
  } catch (error) {
    check('no-credentials', false, (error as Error).message)
  }

  const unsafe: string[] = []
  for (const entry of manifest.files) {
    try {
      assertRelativeInside(entry.file, '清单条目')
    } catch (error) {
      unsafe.push((error as Error).message)
    }
  }
  check(
    'manifest-paths-relative',
    unsafe.length === 0,
    unsafe.length ? unsafe.slice(0, 3).join('；') : `${manifest.files.length} 个条目均为相对路径`,
  )

  const actual = candidateFiles(base).filter(
    (file) => !(manifestInside && relative(base, manifestFile).split(sep).join('/') === file),
  )
  const undeclared = actual.filter((file) => !declared.has(file))
  const absent = [...declared].filter((file) => !actual.includes(file))
  check(
    'manifest-covers-all-files',
    undeclared.length === 0 && absent.length === 0,
    undeclared.length || absent.length
      ? `未登记：${undeclared.slice(0, 3).join(', ') || '无'}；缺失：${absent.slice(0, 3).join(', ') || '无'}`
      : `${actual.length} 个文件全部登记`,
  )

  const mismatched = manifest.files
    .map((entry) => {
      const file = assertRelativeInside(entry.file)
      const path = join(base, file)
      if (!existsSync(path)) return { file, ok: false, reason: '缺失' }
      const size = statSync(path).size
      if (size !== entry.bytes)
        return { file, ok: false, reason: `字节数 ${size} ≠ ${entry.bytes}` }
      if (sha256File(path) !== entry.sha256) return { file, ok: false, reason: 'sha256 不符' }
      return { file, ok: true, reason: '' }
    })
    .filter((entry) => !entry.ok)
  check(
    'manifest-digests',
    mismatched.length === 0,
    mismatched.length
      ? `不一致：${mismatched
          .slice(0, 5)
          .map((entry) => `${entry.file}（${entry.reason}）`)
          .join(', ')}`
      : `${manifest.files.length} 个文件的摘要与字节数一致`,
  )
  const uncoveredLicenses = licenses.filter((file) => !declared.has(file))
  check(
    'licenses-covered-by-manifest',
    uncoveredLicenses.length === 0,
    uncoveredLicenses.length ? `未纳入摘要：${uncoveredLicenses.join(', ')}` : '许可文件都在清单内',
  )

  const capabilities = detectCapabilities(base)
  check(
    'capability-bundle-scanned',
    capabilities.bundleScanned,
    capabilities.bundleScanned ? '已扫描' : '没有可扫描的 bundle',
  )
  check(
    'capability-markers-present',
    capabilities.markersPresent,
    JSON.stringify(capabilities.bundleMarkers),
  )
  const history = plan.capability.acpSessionHistory
  const declaredMarkers = [
    plan.capability.acpMetaKey,
    history.metaKey,
    history.clientRequestIdMetaKey,
    ...history.methods,
    ...history.notifications,
  ]
  const historyScan = scanBundleMarkers(base, declaredMarkers)
  check(
    'capability-acp-session-history-declared',
    historyScan.scanned && historyScan.missing.length === 0,
    historyScan.missing.length
      ? `缺少标记：${historyScan.missing.slice(0, 3).join(', ')}`
      : `${declaredMarkers.length} 个声明标记都在 bundle 内`,
  )

  const declaredExternal = manifest.externalModules
  const requiredExternal = npmOverlay ? distribution.externalModules : plan.build.externalModules
  const externalDeclared =
    Array.isArray(declaredExternal?.copied) &&
    requiredExternal.every((name) => declaredExternal.copied?.includes(name))
  check('external-modules-declared', externalDeclared, `需要 ${requiredExternal.join(', ')}`)
  const closure = verifyExternalModuleClosure(
    npmOverlay ? join(base, 'official') : base,
    requiredExternal,
  )
  check(
    'external-modules-closure-inside-candidate',
    closure.ok,
    closure.ok
      ? `闭包 ${closure.resolved} 个包全部解析在候选目录内`
      : [
          closure.missing.length ? `缺包：${closure.missing.slice(0, 3).join(', ')}` : '',
          closure.escaped.length ? `逃出候选目录：${closure.escaped.slice(0, 3).join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('；'),
  )

  return finish(checks, {
    version: shapeOk ? declaredVersion : null,
    manifestPath: manifestFile,
    base,
    manifest,
    capabilities,
    launcherPath,
    externalClosure: closure,
  })

  function finish(
    all: CheckResult[],
    extra: {
      version: string | null
      manifestPath: string | null
      base: string
      manifest?: CandidateManifest
      capabilities?: ReturnType<typeof detectCapabilities>
      launcherPath?: string
      externalClosure?: ReturnType<typeof verifyExternalModuleClosure>
    },
  ): VerifyImportResult {
    const failed = all.filter((item) => !item.ok).map((item) => item.name)
    return {
      ...extra,
      checks: all,
      passed: failed.length === 0,
      failed,
      manifestSha256:
        extra.manifestPath && existsSync(extra.manifestPath)
          ? sha256File(extra.manifestPath)
          : null,
      launcherSha256:
        extra.launcherPath && existsSync(extra.launcherPath)
          ? sha256File(extra.launcherPath)
          : null,
      networkUsed: NETWORK_ACCESS,
    }
  }
}

// ---------------------------------------------------------------- 集成状态

export const RUNTIME_SELECTION_INTEGRATION = {
  wiredByLifecycle: false,
  receiptOnly: true,
  publicInterface: 'oplExecution/save-catalog（src/execution/host/service.ts 的 saveCatalog）',
  field: "ExecutionCatalog.harnesses[id='minimax-code'].command = <候选目录>/mcode.cmd 的绝对路径",
  switchBackField: "把同一字段改回 'mcode' 或官方安装目录的绝对路径",
  activity:
    '调用方必须用公开活动状态提供 --active-tasks；本脚本不探活，也不保证它与真实全局活动一致',
}

// ---------------------------------------------------------------- 活动任务闸门

export function resolveActiveTasks({
  activeTasks,
  activity,
  env = process.env,
}: {
  activeTasks?: string | number | undefined
  activity?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
} = {}): ActiveTasksResolution {
  const note = '调用方注入的公开状态；本脚本不探活，也不验证它与真实全局活动一致。'
  if (activeTasks !== undefined && activeTasks !== null && activeTasks !== '') {
    const value = Number(activeTasks)
    if (!Number.isInteger(value) || value < 0)
      throw new Error(`--active-tasks 必须是非负整数，收到 ${JSON.stringify(activeTasks)}。`)
    return { activeTasks: value, source: 'caller-argument', injected: true, note }
  }
  if (activity) {
    const path = resolve(activity)
    if (!existsSync(path)) throw new Error(`活动状态文件不存在：${path}`)
    let parsed: { activeTasks?: unknown }
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new Error(`活动状态文件无法解析：${path}（${(error as Error).message}）`)
    }
    const value = parsed?.activeTasks
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
      throw new Error(`活动状态文件缺少非负整数 activeTasks：${path}`)
    return { activeTasks: value, source: path, injected: true, note }
  }
  void env
  throw new Error(
    '切换选择必须注入公开状态：--active-tasks <非负整数> 或 --activity <JSON 文件>；不自行探活。',
  )
}

export function assertNoActiveTasks(
  resolved: ActiveTasksResolution,
  action: string,
): ActiveTasksResolution {
  if (resolved.activeTasks !== 0)
    throw new Error(
      `存在 ${resolved.activeTasks} 个活动任务（来源 ${resolved.source}），拒绝${action}；等任务结束后重试。`,
    )
  return resolved
}

// ---------------------------------------------------------------- 导入与选择

function copyCandidateTree(sourceDir: string, destination: string, manifestFile: string): string {
  mkdirp(destination)
  cpSync(sourceDir, destination, { recursive: true, dereference: false, force: true })
  const target = join(destination, 'manifest.json')
  if (resolve(manifestFile) !== resolve(target)) copyFileSync(manifestFile, target)
  return target
}

/** 官方启动器只用存在性判断解析；找不到也允许切回，只是记录 unresolved。 */
export function resolveOfficialLauncher({
  officialLauncher,
  env = process.env,
}: {
  officialLauncher?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
} = {}): { launcher: string; resolved: string | null } {
  if (officialLauncher) {
    const resolved = resolveCommandPath(officialLauncher, env)
    return { launcher: officialLauncher, resolved: resolved || null }
  }
  const command = process.platform === 'win32' ? 'mcode.cmd' : 'mcode'
  const resolved = resolveCommandPath(command, env)
  return { launcher: resolved || command, resolved: resolved || null }
}

function requireStore(options: LifecycleOptions): { env: NodeJS.ProcessEnv; storeRoot: string } {
  const env = options.env ?? process.env
  const storeRoot = assertStoreRoot(options.store ?? defaultStoreRoot(env), {
    env,
    allowRoots: options.allowRoots ?? [],
    extraRoots: options.extraRoots ?? [],
  })
  return { env, storeRoot }
}

function verifyOptions(options: LifecycleOptions, env: NodeJS.ProcessEnv): VerifyImportOptions {
  return {
    env,
    extraRoots: options.extraRoots ?? [],
    manifestPath: options.manifest,
    version: options.version,
  }
}

/**
 * 导入一个新候选：先只读校验来源，再复制到版本目录，再对目标目录重新校验一遍，
 * 最后（可选）写入选择。全程不执行候选代码、不联网。
 */
export function importCandidate(options: LifecycleOptions = {}) {
  const dryRun = options.dryRun === true
  const { env, storeRoot } = requireStore(options)
  const source = resolve(required(options.source, '--source <候选目录>'))
  const verification = verifyImportCandidate(source, verifyOptions(options, env))
  if (!verification.passed || !verification.version || !verification.manifestPath)
    return {
      command: 'import',
      dryRun,
      applied: false,
      ok: false,
      storeRoot,
      source,
      failed: verification.failed,
      checks: verification.checks,
      networkUsed: NETWORK_ACCESS,
      selectionChanged: false,
    }
  const version = verification.version
  const destination = versionDir(storeRoot, version)
  const previous = readSelection(storeRoot)
  const selectionRequested = options.select === true
  const wantsSwitch = selectionRequested || options.upgrade === true

  let activeTasks: ActiveTasksResolution | null = null
  let direction: number | null = null
  if (wantsSwitch) {
    activeTasks = assertNoActiveTasks(
      resolveActiveTasks({ activeTasks: options.activeTasks, activity: options.activity, env }),
      options.upgrade ? '升级候选' : '切换候选',
    )
    if (options.upgrade) {
      if (previous?.selection?.kind !== 'candidate')
        throw new Error('当前没有已选择的候选版；请先用 import --select 完成首次导入。')
      direction = compareVersions(version, previous.selection.version)
      if (direction <= 0 && options.allowSameOrOlder !== true)
        throw new Error(
          `升级目标 ${version} 不高于当前选择 ${previous.selection.version}；如确实要切回旧版，请显式 --allow-same-or-older。`,
        )
    }
  }

  const verificationTarget = verificationDir(storeRoot, version)
  const extraRoots = options.extraRoots ?? []
  assertDerivedTargets(
    storeRoot,
    [
      { path: destination, label: '版本目录' },
      { path: verificationTarget, label: '校验报告目录' },
      ...(wantsSwitch ? [{ path: selectionPath(storeRoot), label: '选择回执' }] : []),
    ],
    { env, extraRoots },
  )

  if (containsPath(storeRoot, resolveThroughExistingAncestors(source)))
    throw new Error(`来源目录位于候选 Store 内，拒绝自我导入：${source}`)

  const selectedVersion =
    previous?.selection?.kind === 'candidate' ? previous.selection.version : null
  let alreadyImported = false
  let rotateTo: string | null = null
  let existingVerification: VerifyImportResult | null = null
  if (existsSync(destination)) {
    const replacing = options.replace === true
    if (replacing && selectedVersion === version)
      throw new Error(
        `不能 --replace 当前已选择的候选版本 ${version}；先 select 到别的版本或切回官方，再替换它。`,
      )
    existingVerification = verifyImportCandidate(destination, {
      env,
      extraRoots,
      manifestPath: join(destination, 'manifest.json'),
      version,
    })
    if (
      existingVerification.passed &&
      existingVerification.manifestSha256 === verification.manifestSha256
    )
      alreadyImported = true
    else if (!replacing)
      throw new Error(
        `目标版本目录已存在且与来源不一致：${destination}。换版本号，或显式 --replace（旧目录改名保留）。`,
      )
    else rotateTo = `${destination}.previous-${Date.now()}`
  }

  const stamp = Date.now()
  const stagingDir = `${destination}.staging-${stamp}`
  const failedDir = `${destination}.failed-${stamp}`
  if (!alreadyImported)
    assertDerivedTargets(
      storeRoot,
      [
        { path: stagingDir, label: '暂存目录' },
        { path: failedDir, label: '失败保留目录' },
      ],
      { env, extraRoots },
    )
  if (rotateTo)
    assertDerivedTargets(storeRoot, [{ path: rotateTo, label: '旧版本保留目录' }], {
      env,
      extraRoots,
    })

  const plan_ = {
    command: options.upgrade ? 'upgrade' : 'import',
    dryRun,
    storeRoot,
    source,
    manifest: verification.manifestPath,
    version,
    destination,
    alreadyImported,
    replace: options.replace === true,
    rotateTo,
    stagingDir: alreadyImported ? null : stagingDir,
    selectionRequested,
    activeTasks,
    upgradeDirection: direction,
    previousSelection: previous?.selection ?? null,
    selectedVersion,
    manifestSha256: verification.manifestSha256,
    launcher: verification.launcherPath,
    launcherSha256: verification.launcherSha256,
    checks: verification.checks,
    networkUsed: NETWORK_ACCESS,
    integration: RUNTIME_SELECTION_INTEGRATION,
    warnings: wantsSwitch
      ? [
          'selection.json 只是本脚本的审计回执，不是 DSH 的真实运行时选择。',
          '要让 MiniMax 组合真正用上候选启动器，主审必须用公开接口 oplExecution/save-catalog 把',
          "harnesses[id='minimax-code'].command 设为该候选启动器的绝对路径；接线前切换不生效。",
          '本次的活动任务数由调用方注入，不是全局活动探测，也不构成全局安全锁。',
        ]
      : [],
    writes: [
      ...(alreadyImported ? [] : [{ action: 'stage', to: stagingDir }]),
      ...(rotateTo ? [{ action: 'rotate', to: rotateTo }] : []),
      ...(alreadyImported ? [] : [{ action: 'publish', to: destination }]),
      { action: 'verification-report', to: join(verificationTarget, 'import-verification.json') },
      ...(wantsSwitch ? [{ action: 'selection', to: selectionPath(storeRoot) }] : []),
    ],
  }
  if (dryRun) return { ...plan_, applied: false, ok: true, selectionChanged: false }

  let finalVerification = existingVerification ?? verification
  let published = false
  let rotated = false
  try {
    if (!alreadyImported) {
      copyCandidateTree(source, stagingDir, verification.manifestPath)
      const recheck = verifyImportCandidate(stagingDir, {
        env,
        extraRoots,
        manifestPath: join(stagingDir, 'manifest.json'),
        version,
      })
      if (!recheck.passed) {
        renameSync(stagingDir, failedDir)
        return {
          ...plan_,
          applied: false,
          ok: false,
          failed: recheck.failed,
          checks: recheck.checks,
          failedDir,
          restored: true,
          selectionChanged: false,
        }
      }
      finalVerification = recheck
      if (rotateTo) {
        renameSync(destination, rotateTo)
        rotated = true
      }
      renameSync(stagingDir, destination)
      published = true
    }
    mkdirp(verificationTarget)
    writeJsonAtomically(
      storeRoot,
      join(verificationTarget, 'import-verification.json'),
      {
        version,
        source,
        destination,
        verifiedAt: new Date().toISOString(),
        passed: finalVerification.passed,
        failed: finalVerification.failed,
        checks: finalVerification.checks,
        manifestSha256: finalVerification.manifestSha256,
        launcherSha256: finalVerification.launcherSha256,
        networkUsed: NETWORK_ACCESS,
        candidateCodeExecuted: false,
      },
      { env, extraRoots },
    )

    let receipt = previous
    let selectionChanged = false
    if (wantsSwitch) {
      const launcher = join(destination, plan.launcher.windows)
      receipt = buildReceipt({
        storeRoot,
        previous,
        selection: {
          kind: 'candidate',
          version,
          launcher,
          launcherSha256: sha256File(launcher),
          manifestSha256: finalVerification.manifestSha256,
          officialBase: version.split('-opl-bash.')[0],
          verifiedAt: new Date().toISOString(),
        },
        official: previous?.official ?? {
          launcher: null,
          resolved: null,
          note: '未记录官方启动器',
        },
      })
      const entry = receipt.candidates.find((item) => item.version === version)
      if (entry) {
        entry.manifestSha256 = finalVerification.manifestSha256
        entry.verified = true
        entry.importedAt = entry.importedAt ?? new Date().toISOString()
      }
      writeSelection(storeRoot, receipt, { env, extraRoots })
      selectionChanged = true
    }
    return { ...plan_, applied: true, ok: true, receipt, selectionChanged, restored: false }
  } catch (error) {
    const rollback = rollbackImport({
      destination,
      stagingDir,
      failedDir,
      rotateTo,
      published,
      rotated,
    })
    return {
      ...plan_,
      applied: false,
      ok: false,
      error: (error as Error).message,
      ...rollback,
      selectionChanged: false,
    }
  }
}

/**
 * 导入失败后的恢复：把已发布的暂存目录挪成 `<版本>.failed-<ts>` 保留，再把被改名的原目录改回目标位置。
 */
function rollbackImport({
  destination,
  stagingDir,
  failedDir,
  rotateTo,
  published,
  rotated,
}: {
  destination: string
  stagingDir: string
  failedDir: string
  rotateTo: string | null
  published: boolean
  rotated: boolean
}) {
  const problems: string[] = []
  let keptFailed: string | null = null
  if (published && existsSync(destination)) {
    keptFailed = existsSync(failedDir) ? `${failedDir}-${Date.now()}` : failedDir
    try {
      renameSync(destination, keptFailed)
    } catch (error) {
      keptFailed = null
      problems.push(`无法移开已发布目录：${(error as Error).message}`)
    }
  }
  if (rotated && rotateTo && existsSync(rotateTo)) {
    try {
      renameSync(rotateTo, destination)
    } catch (error) {
      problems.push(`无法把原目录改回 ${destination}：${(error as Error).message}`)
    }
  }
  const restored =
    problems.length === 0 &&
    (!rotated || existsSync(destination)) &&
    (!rotateTo || !existsSync(rotateTo))
  if (!published && existsSync(stagingDir)) problems.push(`暂存目录仍在：${stagingDir}`)
  return {
    restored,
    originalRestored: restored,
    failedDir: keptFailed,
    stagingDir: published ? null : stagingDir,
    rollbackProblems: problems,
  }
}

/** 显式选择一个已导入的候选版本。 */
export function selectCandidate(options: LifecycleOptions = {}) {
  const dryRun = options.dryRun === true
  const { env, storeRoot } = requireStore(options)
  const version = required(options.version, '--version <候选版本>')
  const destination = versionDir(storeRoot, version)
  assertDerivedTargets(
    storeRoot,
    [
      { path: destination, label: '版本目录' },
      { path: selectionPath(storeRoot), label: '选择回执' },
    ],
    { env, extraRoots: options.extraRoots ?? [] },
  )
  if (!existsSync(destination)) throw new Error(`尚未导入该候选版本：${destination}`)
  const verification = verifyImportCandidate(destination, {
    env,
    extraRoots: options.extraRoots ?? [],
    manifestPath: join(destination, 'manifest.json'),
    version,
  })
  if (!verification.passed)
    return {
      command: 'select',
      dryRun,
      applied: false,
      ok: false,
      storeRoot,
      version,
      failed: verification.failed,
      checks: verification.checks,
      selectionChanged: false,
    }
  const activeTasks = assertNoActiveTasks(
    resolveActiveTasks({ activeTasks: options.activeTasks, activity: options.activity, env }),
    '切换候选',
  )
  const previous = readSelection(storeRoot)
  const launcher = join(destination, plan.launcher.windows)
  const selection: SelectionEntry = {
    kind: 'candidate',
    version,
    launcher,
    launcherSha256: sha256File(launcher),
    manifestSha256: verification.manifestSha256,
    officialBase: version.split('-opl-bash.')[0],
    verifiedAt: new Date().toISOString(),
  }
  const plan_ = {
    command: 'select',
    dryRun,
    storeRoot,
    version,
    destination,
    launcher,
    activeTasks,
    previousSelection: previous?.selection ?? null,
    checks: verification.checks,
    networkUsed: NETWORK_ACCESS,
    integration: RUNTIME_SELECTION_INTEGRATION,
    warnings: [
      'selection.json 只是本脚本的审计回执，不是 DSH 的真实运行时选择；写入它不会改变 MiniMax 组合。',
      "要让选择生效，主审必须用公开接口 oplExecution/save-catalog 把 harnesses[id='minimax-code'].command 设为：",
      launcher,
      '本次的活动任务数由调用方注入，不是全局活动探测，也不构成全局安全锁。',
    ],
  }
  if (dryRun) return { ...plan_, applied: false, ok: true, selectionChanged: false }
  const receipt = buildReceipt({
    storeRoot,
    previous,
    selection,
    official: previous?.official ?? { launcher: null, resolved: null, note: '未记录官方启动器' },
  })
  const entry = receipt.candidates.find((item) => item.version === version)
  if (entry) {
    entry.manifestSha256 = verification.manifestSha256
    entry.verified = true
    entry.importedAt = entry.importedAt ?? new Date().toISOString()
  }
  writeSelection(storeRoot, receipt, { env, extraRoots: options.extraRoots ?? [] })
  return { ...plan_, applied: true, ok: true, receipt, selectionChanged: true }
}

/**
 * 切回官方安装：只改本脚本的选择回执，不动官方安装、账号数据与任何候选目录。
 */
export function switchToOfficial(options: LifecycleOptions = {}) {
  const dryRun = options.dryRun === true
  const { env, storeRoot } = requireStore(options)
  const activeTasks = assertNoActiveTasks(
    resolveActiveTasks({ activeTasks: options.activeTasks, activity: options.activity, env }),
    '切回官方',
  )
  assertDerivedTargets(storeRoot, [{ path: selectionPath(storeRoot), label: '选择回执' }], {
    env,
    extraRoots: options.extraRoots ?? [],
  })
  const previous = readSelection(storeRoot)
  const official = resolveOfficialLauncher({ officialLauncher: options.officialLauncher, env })
  const selection: SelectionEntry = {
    kind: 'official',
    version: null,
    launcher: official.resolved ?? official.launcher,
    launcherSha256: official.resolved ? sha256File(official.resolved) : null,
    officialBase: plan.official.version,
    verifiedAt: new Date().toISOString(),
  }
  const plan_ = {
    command: 'official',
    dryRun,
    storeRoot,
    activeTasks,
    official,
    previousSelection: previous?.selection ?? null,
    integration: RUNTIME_SELECTION_INTEGRATION,
    warnings: [
      'selection.json 只是本脚本的审计回执，不是 DSH 的真实运行时选择。',
      "要让切回生效，主审必须用公开接口 oplExecution/save-catalog 把 harnesses[id='minimax-code'].command 改回：",
      official.resolved ?? official.launcher,
      '本次的活动任务数由调用方注入，不是全局活动探测，也不构成全局安全锁。',
      '官方 0.6.3 不提供 ACP _meta["minimax-code/shell"] 与会话历史接口；',
      '切回后 MiniMax 组合会在发送前按设计被拒绝，不会静默退回 PowerShell/CMD/WSL。',
      official.resolved
        ? ''
        : `未在 PATH 上解析到官方 ${process.platform === 'win32' ? 'mcode.cmd' : 'mcode'}；请用 --official-launcher 指定绝对路径。`,
    ].filter(Boolean),
    networkUsed: NETWORK_ACCESS,
  }
  if (dryRun) return { ...plan_, applied: false, ok: true, selectionChanged: false }
  const receipt = buildReceipt({
    storeRoot,
    previous,
    selection,
    official: {
      launcher: official.resolved ?? official.launcher,
      resolved: official.resolved,
      note: '官方安装与账号数据未被本脚本修改；切换方式见 docs/minimax-bash-candidate.md。',
    },
  })
  writeSelection(storeRoot, receipt, { env, extraRoots: options.extraRoots ?? [] })
  return { ...plan_, applied: true, ok: true, receipt, selectionChanged: true }
}

/** 只读列出候选与当前选择。 */
export function listCandidates(options: LifecycleOptions = {}) {
  const { env, storeRoot } = requireStore(options)
  const selection = readSelection(storeRoot)
  return {
    command: 'list',
    dryRun: true,
    applied: false,
    ok: true,
    storeRoot,
    selection: selection?.selection ?? null,
    history: selection?.history ?? [],
    preserved: selection?.preserved ?? {},
    integration: RUNTIME_SELECTION_INTEGRATION,
    candidates: listImportedVersions(storeRoot).map((version) => {
      const launcher = join(versionDir(storeRoot, version), plan.launcher.windows)
      return {
        version,
        launcher: existsSync(launcher) ? launcher : null,
        report: existsSync(join(verificationDir(storeRoot, version), 'import-verification.json'))
          ? join(verificationDir(storeRoot, version), 'import-verification.json')
          : null,
      }
    }),
    networkUsed: NETWORK_ACCESS,
  }
}

/** 只读校验一个候选目录，不导入、不选择、不写任何文件。 */
export function verifyOnly(options: LifecycleOptions = {}) {
  const env = options.env ?? process.env
  const source = resolve(required(options.source, '--source <候选目录>'))
  const verification = verifyImportCandidate(source, verifyOptions(options, env))
  return {
    command: 'verify',
    dryRun: true,
    applied: false,
    ok: verification.passed,
    source,
    version: verification.version,
    manifestSha256: verification.manifestSha256,
    launcherSha256: verification.launcherSha256,
    failed: verification.failed,
    checks: verification.checks,
    networkUsed: NETWORK_ACCESS,
    runtimeValidation: {
      verifiedByThisScript: false,
      reason:
        '本脚本只做静态与摘要检查，不执行候选代码、不发起 ACP；真实 _meta["minimax-code/shell"] 回读、会话历史接口与真实 Bash 执行不在离线检查范围内。',
    },
  }
}

export function runLifecycle(command: string, options: LifecycleOptions = {}) {
  switch (command) {
    case 'list':
      return listCandidates(options)
    case 'verify':
      return verifyOnly(options)
    case 'import':
      return importCandidate(options)
    case 'upgrade':
      return importCandidate({ ...options, upgrade: true, select: true })
    case 'select':
      return selectCandidate(options)
    case 'official':
      return switchToOfficial(options)
    default:
      throw new Error(
        `未知命令 ${JSON.stringify(command)}；可用：list/verify/import/upgrade/select/official。`,
      )
  }
}
