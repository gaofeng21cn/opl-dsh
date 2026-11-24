import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync, rmdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { currentMacTrash } from './macos-io.mjs'
import { finishWindowsRestore, safeTree, verifyRecycledTarget } from './windows-io.mjs'

const moveWindows = `& { param($data) $ErrorActionPreference='Stop'
  $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($data)) | ConvertFrom-Json
  if ([IO.Directory]::Exists($p[0])) { [IO.Directory]::Move($p[0],$p[1]) }
  else { [IO.File]::Move($p[0],$p[1]) } }`
const moveMac = `ObjC.import('Foundation'); function run(a) {
  const e = Ref(); if (!$.NSFileManager.defaultManager.moveItemAtPathToPathError(a[0], a[1], e))
    throw Error('Could not restore item to its original location'); }`
const entry = (path) => lstatSync(path, { throwIfNoEntry: false })

/** Restore a verified recycle receipt without replacing anything at the destination. */
export function restoreRecycledTree(receipt, target, platform = process.platform) {
  if (platform !== process.platform || !['darwin', 'win32'].includes(platform))
    throw Error('当前平台不支持回收站恢复')
  if (resolve(receipt.originalPath) !== resolve(target.path)) throw Error('恢复目标与回执不符')
  const win = platform === 'win32'
  const macFolder =
    !win && join(realpathSync(homedir()), '.Trash', 'OPL DSH-' + receipt.operationId)
  if (
    !win &&
    (!/^[a-f0-9-]{36}$/u.test(receipt.operationId) ||
      receipt.recyclePath !== join(macFolder, basename(target.path)))
  )
    throw Error('废纸篓回执无效')
  if (entry(target.path)) {
    if (entry(receipt.recyclePath) || !isDeepStrictEqual(safeTree(target.path), target.tree))
      throw Error('原路径已有内容，不能覆盖')
  } else {
    safeTreeParent(target.path)
    if (win) {
      verifyRecycledTarget(target, receipt)
      const data = Buffer.from(JSON.stringify([receipt.recyclePath, target.path])).toString(
        'base64',
      )
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', moveWindows, '--', data],
        { windowsHide: true },
      )
    } else {
      currentMacTrash().verifyRecycledTarget(target, receipt, receipt.operationId)
      execFileSync('/usr/bin/osascript', [
        '-l',
        'JavaScript',
        '-e',
        moveMac,
        '--',
        receipt.recyclePath,
        target.path,
      ])
    }
    if (!isDeepStrictEqual(safeTree(target.path), target.tree))
      throw Error('恢复文件的内容核验失败')
  }
  if (win && entry(receipt.metadataPath)) finishWindowsRestore(target, receipt)
  if (!win && entry(macFolder)) rmdirSync(macFolder)
}

function safeTreeParent(path) {
  const parent = dirname(path)
  if (!entry(parent)?.isDirectory() || realpathSync.native(parent) !== parent)
    throw Error('恢复目录缺失或已重定向')
}
