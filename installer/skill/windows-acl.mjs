import { statSync } from 'node:fs'
import { win32 } from 'node:path'

/** Validate the directory whose ACL will be repaired. */
export function assertRepairTarget(cwd, { platform = process.platform, stat = statSync } = {}) {
  if (platform !== 'win32') throw new Error('Windows ACL repair is available only on Windows')
  if (typeof cwd !== 'string' || !win32.isAbsolute(cwd)) throw new Error('--cwd 必须为绝对路径')
  let info
  try {
    info = stat(cwd)
  } catch {
    throw new Error(`工作目录不存在：${cwd}`)
  }
  if (!info.isDirectory()) throw new Error(`工作目录不是目录：${cwd}`)
  return cwd
}

/** Build argv for an explicit, administrator-approved Full Control repair. */
export function buildRepairArgs(cwd, identity) {
  if (!identity) throw new Error('无法确定当前 Windows 身份')
  return [cwd, '/grant', `${identity}:(OI)(CI)F`, '/C', '/Q']
}
