/**
 * 候选目录静态核对原语（启动器模板、许可列表、凭据扫描、能力标记与外部模块闭包验证）。
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { plan, resolveThroughExistingAncestors } from './shared.ts'

/** 许可文件在候选目录中的实际位置，验证器与组装阶段共用同一份。 */
export function licenseTargets(): string[] {
  return [...plan.license.rootFiles, ...plan.license.extraFiles].map((file) =>
    join('licenses', file),
  )
}

/**
 * 生成候选独立启动器。运行时不写进系统 PATH，也不改官方启动器文件。
 * 绝对路径直接引用；相对路径按启动器所在目录解析，便于随候选一起分发。
 */
export function launcherContent(runtimePath: string | undefined): string {
  const runtime = runtimePath
    ? isAbsolute(runtimePath)
      ? `"${runtimePath}"`
      : `"%~dp0${runtimePath.split('\\').join('/')}"`
    : 'node'
  return [
    '@ECHO off',
    'REM MiniMax Bash candidate launcher. Not an official MiniMax release.',
    `${runtime} "%~dp0cli.js" %*`,
    'EXIT /B %ERRORLEVEL%',
    '',
  ].join('\r\n')
}

/** 候选目录内出现账号数据或凭据即失败；官方登录目录永远不复制。 */
export function scanForCredentials(directory: string): boolean {
  const suspicious: string[] = []
  const credentialNames = new Set([
    'auth',
    'auth.json',
    'credentials.json',
    'tokens.json',
    '.npmrc',
    'id_rsa',
    'id_ed25519',
  ])
  const walk = (current: string) => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, item.name)
      if (item.isDirectory()) {
        if (item.name === 'node_modules' || item.name === 'chunks') continue
        if (credentialNames.has(item.name.toLowerCase())) suspicious.push(path)
        walk(path)
      } else if (credentialNames.has(item.name.toLowerCase())) suspicious.push(path)
    }
  }
  walk(directory)
  if (suspicious.length)
    throw new Error(`候选目录内发现凭据或账号数据文件：${suspicious.slice(0, 5).join(', ')}`)
  return true
}

/** 候选版与官方版分开的能力检测：静态标记只证明补丁进了产物，不等于运行时可用。 */
export function detectCapabilities(
  candidateDir: string,
  { scanBundle = true }: { scanBundle?: boolean | undefined } = {},
) {
  const markers: Record<string, boolean> = {}
  if (scanBundle) {
    const files = ['chunks', 'overlay'].flatMap((name) => {
      const root = join(candidateDir, name)
      return existsSync(root) ? walkFiles(root) : []
    })
    const haystack = files
      .filter((file) => /\.m?js$/.test(file))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    for (const marker of plan.capability.bundleMarkers) markers[marker] = haystack.includes(marker)
  }
  const bundleScanned = Object.keys(markers).length > 0
  const markersPresent = bundleScanned && Object.values(markers).every(Boolean)
  return {
    declaredAcpMeta: {
      key: plan.capability.acpMetaKey,
      version: plan.capability.acpMetaVersion,
      environment: 'MCODE_SHELL_PATH',
    },
    bundleScanned,
    bundleMarkers: markers,
    markersPresent,
    runtimeCapability: 'not-verified-by-this-script',
    runtimeVerification:
      '需要真实 ACP initialize 回读 _meta["minimax-code/shell"] 与真实工具执行；由主审实机验收。',
  }
}

export function walkFiles(directory: string): string[] {
  const found: string[] = []
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) found.push(...walkFiles(path))
    else if (item.isFile()) found.push(path)
  }
  return found
}

/** 候选目录内的实际文件集合，使用与清单一致的相对路径键。 */
export function candidateFiles(candidateDir: string): string[] {
  return walkFiles(candidateDir)
    .map((path) =>
      path
        .slice(candidateDir.length + 1)
        .split('\\')
        .join('/'),
    )
    .sort()
}

/**
 * 解析一个包的真实安装目录。只按 require 的解析路径逐个查找候选目录，不读取任何与依赖解析无关的文件。
 */
export function resolvePackageDir(name: string, importer: string): string | undefined {
  const require = createRequire(join(importer, 'package.json'))
  for (const search of require.resolve.paths(`${name}/package.json`) ?? []) {
    const candidate = join(search, name)
    if (existsSync(join(candidate, 'package.json'))) {
      try {
        return resolve(realpathSync(candidate))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

export interface ResolvedModuleInfo {
  name: string
  version: string | null
  dir: string
}

/**
 * 从某个目录出发，按 package.json 声明的 dependencies / optionalDependencies 递归解析出完整闭包。
 */
export function resolveModuleClosure(fromDir: string, names: string[]) {
  const modules = new Map<string, ResolvedModuleInfo>()
  const missing: string[] = []
  const queue = names.map((name) => ({ name, importer: fromDir, optional: false }))
  while (queue.length) {
    const next = queue.shift()
    if (!next) break
    const { name, importer, optional } = next
    const dir = resolvePackageDir(name, importer)
    if (!dir) {
      if (!optional && !missing.includes(name)) missing.push(name)
      continue
    }
    if (modules.has(dir)) continue
    let manifest: {
      version?: string
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    } = {}
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      missing.push(name)
      continue
    }
    modules.set(dir, { name, version: manifest.version ?? null, dir })
    const optionalDependencies = manifest.optionalDependencies ?? {}
    for (const dependency of Object.keys({
      ...(manifest.dependencies ?? {}),
      ...optionalDependencies,
    }))
      queue.push({
        name: dependency,
        importer: dir,
        optional: Object.hasOwn(optionalDependencies, dependency),
      })
  }
  return { modules, missing }
}

/**
 * 从候选目录自身出发验证外部模块闭包：每个包都必须能从候选目录解析到，
 * 且真实路径不得落在构建树或仓库 node_modules 里。
 */
export function verifyExternalModuleClosure(candidateDir: string, names: string[]) {
  const base = resolveThroughExistingAncestors(candidateDir)
  const { modules, missing } = resolveModuleClosure(base, names)
  const escaped: string[] = []
  for (const module of modules.values()) {
    const span = relative(base, module.dir)
    if (span.startsWith(`..${sep}`) || span === '..' || isAbsolute(span))
      escaped.push(`${module.name} → ${module.dir}`)
  }
  return {
    resolved: modules.size,
    missing,
    escaped,
    ok: missing.length === 0 && escaped.length === 0,
  }
}
