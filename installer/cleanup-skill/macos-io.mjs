import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { assertSafePath, safeTree } from './windows-io.mjs'

/** ps must enumerate even orphaned profile users. Never expose argv in diagnostics. */
export function checkMacProcesses(output, self, executable, home) {
  const rows = output.trimEnd().split('\n')
  const bundleContents = dirname(dirname(executable))
  const helpers = bundleContents.endsWith('.app/Contents')
    ? join(bundleContents, 'Frameworks') + '/'
    : null
  let sawSelf = false
  for (const row of rows) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(row)
    if (!match) throw Error('无法核验 macOS 进程清单')
    if (Number(match[1]) === self) {
      sawSelf = true
      continue
    }
    const args = match[2]
    if (
      args === executable ||
      args.startsWith(executable + ' ') ||
      (helpers && args.startsWith(helpers)) ||
      args.includes(home)
    )
      throw Error('请退出使用此配置的 DeepSeek Harness 后重试')
  }
  if (!sawSelf) throw Error('无法核验 macOS 进程清单')
}

export function assertDesktopStopped(executable, home) {
  if (process.platform !== 'darwin' || !home || !lstatSync(executable).isFile())
    throw Error('无法核验 macOS Desktop 路径')
  let output
  try {
    output = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch {
    throw Error('无法读取 macOS 进程清单')
  }
  checkMacProcesses(output, process.pid, realpathSync(executable), realpathSync(home))
}

/** Each journaled intent owns one private folder. rename cannot cross volumes. */
export function macTrash(trash, uid) {
  function checkTrash(path) {
    const root = lstatSync(trash)
    if (!root.isDirectory() || root.uid !== uid || realpathSync(trash) !== trash)
      throw Error('无法核验当前用户的废纸篓')
    if (path && lstatSync(path).dev !== root.dev) throw Error('仅支持与用户废纸篓同卷的会话')
  }
  function paths(target, id) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
      throw Error('缺少有效的废纸篓操作编号')
    const folder = join(trash, 'OPL DSH-' + id)
    return {
      originalPath: target.path,
      recyclePath: join(folder, basename(target.path)),
      operationId: id,
    }
  }
  function verifyRecycledTarget(target, receipt, id) {
    checkTrash()
    const expected = paths(target, id)
    if (!isDeepStrictEqual(receipt, expected)) throw Error('废纸篓回执与清单不匹配')
    assertSafePath(expected.recyclePath, trash)
    if (
      lstatSync(target.path, { throwIfNoEntry: false }) ||
      !isDeepStrictEqual(safeTree(expected.recyclePath), target.tree)
    )
      throw Error('废纸篓内容或原路径核验失败')
    return true
  }
  function recycleTarget(target, id) {
    checkTrash(target.path)
    const receipt = paths(target, id)
    if (!isDeepStrictEqual(safeTree(target.path), target.tree)) throw Error('目标文件已变化')
    mkdirSync(dirname(receipt.recyclePath), { mode: 0o700 })
    renameSync(target.path, receipt.recyclePath)
    verifyRecycledTarget(target, receipt, id)
    return receipt
  }
  function findRecycledTarget(target, _sinceMs, id) {
    const receipt = paths(target, id)
    verifyRecycledTarget(target, receipt, id)
    return receipt
  }
  return { preflight: checkTrash, recycleTarget, verifyRecycledTarget, findRecycledTarget }
}

export function currentMacTrash() {
  return macTrash(join(realpathSync(homedir()), '.Trash'), process.getuid())
}
