/**
 * 候选共享事实、摘要校验与写入边界（供运行时导入校验与 scripts 构建脚本共用）。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import candidatePlan from './candidate.json' with { type: 'json' }

export const plan = candidatePlan

/**
 * 拒绝写入的目录：官方启动器目录、官方登录/数据目录、OPL profile 与套件 Harness 目录。
 */
export function officialProtectedRoots(
  env: NodeJS.ProcessEnv = process.env,
  extraRoots: string[] = [],
): string[] {
  const home = env.USERPROFILE || env.HOME || homedir()
  const roots: string[] = [
    join(home, '.minimax-code'),
    join(home, '.minimax'),
    join(home, '.minimax-code-data'),
    join(home, '.config', 'mcode'),
    env.OPL_DSH_HOME?.trim() || join(home, '.dsh'),
    join(tmpdir(), 'mcode-official-probe'),
  ]
  for (const value of [env.MINIMAX_CODE_HOME, env.MINIMAX_DATA_DIR, env.MAVIS_DATA_DIR]) {
    if (value?.trim()) roots.push(resolve(value.trim()))
  }
  for (const value of (env.OPL_MCODE_PROTECTED_ROOTS ?? '').split(/[;,]/)) {
    if (value.trim()) roots.push(resolve(value.trim()))
  }
  for (const value of extraRoots) if (value) roots.push(resolve(value))
  // 官方启动器实际所在目录：只判断存在性，不读取内容。
  const official = resolveCommandPath(process.platform === 'win32' ? 'mcode.cmd' : 'mcode', env)
  if (official) roots.push(dirname(resolve(official)))
  return normalizeRoots(roots)
}

/**
 * 套件自有的 Harness 根目录。构建脚本一律把它当受保护目录，避免构建结果写进已安装的套件；
 * 只有显式声明的生命周期操作（候选导入/选择）才在自己的 Store 里写。
 */
export function suiteOwnedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return normalizeRoots([
    env.APPDATA ? join(env.APPDATA, 'OPL DSH Suite') : '',
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'OPL DSH Suite') : '',
  ])
}

export function protectedRoots(
  env: NodeJS.ProcessEnv = process.env,
  extraRoots: string[] = [],
): string[] {
  return [...new Set([...officialProtectedRoots(env, extraRoots), ...suiteOwnedRoots(env)])]
}

function normalizeRoots(roots: string[]): string[] {
  return [...new Set(roots.filter(Boolean).map((value) => resolveThroughExistingAncestors(value)))]
}

/** 两个绝对路径在任意方向重叠（相等、互为祖先或互为后代）时为 true。 */
export function overlapsPath(left: string, right: string): boolean {
  return overlaps(resolve(left), resolve(right))
}

/** target 落在 base 之内（含相等）时为 true。 */
export function containsPath(base: string, target: string): boolean {
  const span = relative(resolve(base), resolve(target))
  return span === '' || (!span.startsWith(`..${sep}`) && span !== '..' && !isAbsolute(span))
}

/**
 * 把可能还不存在的路径解析成真实路径：向上找到最近的存在祖先，对它取 realpath，
 * 再拼回剩余片段。首次创建时 realpath 会失败——此时必须报错而不是退回绝对路径，
 * 否则已有 symlink/junction 祖先（以及断链）会被当成安全路径放行。
 */
export function resolveThroughExistingAncestors(path: string): string {
  const absolute = resolve(path)
  const segments: string[] = []
  let current = absolute
  while (true) {
    try {
      lstatSync(current)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
    }
    const parent = dirname(current)
    if (parent === current)
      throw new Error(`无法为 ${absolute} 找到可规范化的现存祖先，拒绝按未验证路径处理。`)
    segments.unshift(basename(current))
    current = parent
  }
  let real: string
  try {
    real = resolve(realpathSync(current))
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    throw new Error(
      `无法解析现存祖先 ${current} 的真实路径（${err.code ?? err.message}），拒绝放行。`,
    )
  }
  return segments.length ? resolve(real, ...segments) : real
}

/** 两个路径在任意方向上重叠即为冲突：相等、互为祖先或互为后代。 */
function overlaps(left: string, right: string): boolean {
  const span = relative(left, right)
  const contained =
    span === '' || (!span.startsWith(`..${sep}`) && span !== '..' && !isAbsolute(span))
  const reverse = relative(right, left)
  const contains =
    reverse === '' || (!reverse.startsWith(`..${sep}`) && reverse !== '..' && !isAbsolute(reverse))
  return contained || contains
}

/** 候选版允许出现在独占目录里；与受保护目录双向重叠一律拒绝，没有覆盖开关。 */
export function assertNotProtected(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
  label = '输出',
  extraRoots: string[] = [],
): string {
  const inside = resolveThroughExistingAncestors(target)
  for (const root of protectedRoots(env, extraRoots)) {
    if (overlaps(root, inside))
      throw new Error(
        `${label} ${inside} 与受保护目录 ${root}（官方安装、官方登录数据或 OPL profile）重叠，拒绝写入。`,
      )
  }
  return inside
}

/** 写入前的统一闸门：绝对路径、不与受保护目录重叠、位于声明的独占根之内。 */
export function assertWritableTarget(
  target: string,
  {
    root,
    label = '输出',
    extraRoots = [],
  }: {
    root?: string | undefined
    label?: string | undefined
    extraRoots?: string[] | undefined
  } = {},
): string {
  if (!isAbsolute(target)) throw new Error(`${label}必须是绝对路径，收到 ${target}。`)
  const inside = assertNotProtected(target, process.env, label, extraRoots)
  if (root) {
    const base = resolveThroughExistingAncestors(root)
    const span = relative(base, inside)
    if (span.startsWith(`..${sep}`) || span === '..' || isAbsolute(span))
      throw new Error(`${label} ${inside} 不在独占目录 ${base} 内，拒绝写入。`)
  }
  return inside
}

/** 候选版本号必须显式、带候选后缀，并且以复核过的官方版本为前缀。 */
export function assertCandidateVersion(version: unknown): string {
  const supported = [plan.official.version, '0.7.4', '0.7.7']
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+-opl-bash\.\d{8}\.\d+$/.test(version))
    throw new Error(
      `候选版本号必须是 <官方版本>-opl-bash.<YYYYMMDD>.<序号>，收到 ${JSON.stringify(version)}。`,
    )
  if (!supported.some((official) => version.startsWith(`${official}-opl-bash.`)))
    throw new Error(`候选版本号必须以已复核官方版本 ${supported.join('/')} 开头，拒绝 ${version}。`)
  return version
}

export function sha256(bytes: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sha512Base64(bytes: string | NodeJS.ArrayBufferView): string {
  return createHash('sha512').update(bytes).digest('base64')
}

export function sha256File(path: string): string {
  return sha256(readFileSync(path))
}

/** 校验补丁或归档的固定摘要，不匹配即失败，不做任何降级或修补。 */
export function assertDigest(path: string, expected: string, label: string): string {
  const actual = sha256File(path)
  if (actual !== expected)
    throw new Error(`${label} 摘要不匹配：期望 ${expected}，实际 ${actual}（${path}）。`)
  return actual
}

export function mkdirp(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

export function writeJson(path: string, value: unknown): string {
  mkdirp(resolve(path, '..'))
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}

/** 在 PATH 与 PATHEXT 中解析真实可执行文件，返回 '' 表示没有找到。 */
export function resolveCommandPath(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!command) return ''
  if (isAbsolute(command) || command.includes('/') || command.includes('\\'))
    return existsSync(command) ? command : ''
  const extensions =
    process.platform === 'win32'
      ? extname(command)
        ? ['']
        : (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  const roots = (env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const root of roots) {
    for (const extension of extensions) {
      const candidate = join(root, command + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  return existsSync(command) ? command : ''
}

/** 清单里的文件键必须是相对路径且不能逃逸候选目录。 */
export function assertRelativeInside(file: unknown, label = '清单条目'): string {
  if (typeof file !== 'string' || !file || isAbsolute(file) || /^[a-zA-Z]:/.test(file))
    throw new Error(`${label}必须是相对路径，收到 ${JSON.stringify(file)}。`)
  const normalized = file.replaceAll('\\', '/')
  if (normalized.split('/').includes('..')) throw new Error(`${label} ${file} 逃出候选目录，拒绝。`)
  return normalized
}

export { extname }
