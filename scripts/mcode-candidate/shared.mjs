/**
 * 候选构建与验证脚本共用的事实、摘要校验、命令执行和写入边界。
 *
 * 这里是唯一的写入闸门：所有输出都必须落在调用方声明的独占目录内，且与官方安装目录、
 * 官方登录目录和 OPL profile 在任意方向上都不重叠。所有外部命令都按 argv 数组调用，
 * Windows 的 `.cmd`/`.bat` shim 走 cmd.exe 并逐字传参，因此带空格的路径按原样传递。
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertNotProtected,
  mkdirp,
  resolveCommandPath,
  sha256,
  sha512Base64,
} from '../../src/execution/host/candidates/mcode/shared.ts'

export * from '../../src/execution/host/candidates/mcode/shared.ts'
export const scriptDir = fileURLToPath(new URL('.', import.meta.url))

/** 逐行 JSONL 构建轨迹，供主审核对真实执行过哪些步骤。 */
export function createTrace(path) {
  mkdirp(resolve(path, '..'))
  return {
    path,
    record(event, detail = {}) {
      appendFileSync(
        path,
        `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`,
        'utf8',
      )
    },
  }
}

/**
 * Windows 上 `.cmd`/`.bat` 不是可执行映像，必须经 cmd.exe 启动；`cmd /S` 只剥最外层引号，
 * 因此脚本路径要留在第二层引号里，并且整个参数向量必须逐字送达 cmd。含空格的路径
 * （Program Files 下的常规情形）依赖这一点。
 */
export function commandLaunch(command, args = [], env = process.env) {
  const resolved = resolveCommandPath(command, env)
  if (!resolved || process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(resolved))
    return { command: resolved || command, args: [...args], resolved }
  for (const argument of args)
    if (/["%^&|<>()\r\n]/.test(argument))
      throw new Error(`无法安全地通过 cmd.exe 传递参数：${argument}`)
  const line = [
    `"${resolved}"`,
    ...args.map((value) => (/\s/.test(value) ? `"${value}"` : value)),
  ].join(' ')
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
    resolved,
  }
}

/**
 * 执行外部命令并把命令、退出码和输出记进轨迹。命令一律用参数数组调用；
 * 默认只把输出尾部写进轨迹，避免把环境内容带出去。
 */
export function run(argv, { cwd, trace, capture = true, env } = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string')
    throw new Error(`run 需要非空 argv 数组，收到 ${JSON.stringify(argv)}。`)
  const launch = commandLaunch(argv[0], argv.slice(1), env ?? process.env)
  const started = Date.now()
  let result
  try {
    result = execFileSync(launch.command, launch.args, {
      cwd,
      env: env ?? process.env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments === true,
    })
  } catch (error) {
    trace?.record('command', {
      command: argv,
      resolved: launch.resolved,
      cwd,
      exitCode: error.status ?? null,
      ms: Date.now() - started,
      stderr: tail(error.stderr),
    })
    throw new Error(
      `命令失败（${error.status ?? 'signal'}）：${argv.join(' ')}\n${tail(error.stderr)}`,
    )
  }
  trace?.record('command', {
    command: argv,
    resolved: launch.resolved,
    cwd,
    exitCode: 0,
    ms: Date.now() - started,
    stdout: tail(result),
  })
  return result
}

function tail(value, limit = 2000) {
  if (typeof value !== 'string' || !value) return ''
  return value.length > limit ? `${value.slice(-limit)}…` : value
}

/**
 * 下载归档并校验固定摘要；只写入声明的下载目录，不启用任何 TLS 例外。
 * expectation 可以是 { sha256 }（源码归档）或 { integritySha512 }（官方 npm 归档）。
 */
export async function downloadVerified(url, destination, expectation, trace, label) {
  mkdirp(resolve(destination, '..'))
  trace?.record('download', { url, destination, expectation })
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`下载 ${label} 失败：HTTP ${response.status} ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const observed = {
    bytes: bytes.length,
    sha256: sha256(bytes),
    integritySha512: sha512Base64(bytes),
  }
  for (const field of ['sha256', 'integritySha512']) {
    const expected = expectation[field]
    if (!expected) continue
    if (observed[field] !== expected)
      throw new Error(
        `${label} ${field} 不匹配：期望 ${expected}，实际 ${observed[field]}（${url}）。`,
      )
  }
  writeFileSync(destination, bytes)
  trace?.record('download-verified', { url, ...observed })
  return observed
}

/** 归档条目的路径预检：拒绝绝对路径、盘符和上跳，防止解包越界。 */
export function assertSafeArchiveEntries(entries) {
  const unsafe = entries.filter((entry) => {
    const name = entry.replaceAll('\\', '/')
    return (
      name.startsWith('/') ||
      /^[a-zA-Z]:/.test(name) ||
      name.split('/').includes('..') ||
      name.includes('\0')
    )
  })
  if (unsafe.length)
    throw new Error(`归档包含不安全条目，拒绝解包：${unsafe.slice(0, 3).join(', ')}`)
  return entries.length
}

export function tarVersion(trace) {
  return toolVersion('tar', ['--version'], trace)
}

export function toolVersion(command, args, trace) {
  try {
    return run([command, ...args], { trace })
      .split('\n')[0]
      .trim()
  } catch {
    return 'unavailable'
  }
}

export { assertNotProtected }
