import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  lstatSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error Installer JavaScript has no declaration file.
import { checkMacProcesses, macTrash } from '../../installer/cleanup-skill/macos-io.mjs'
// @ts-expect-error Installer JavaScript has no declaration file.
import { safeTree } from '../../installer/cleanup-skill/windows-io.mjs'

it('recovers the exact trash receipt after interruption and rejects another intent or changed content', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mac-trash-')))
  try {
    const trash = join(root, '.Trash')
    mkdirSync(trash)
    const io = macTrash(trash, lstatSync(trash).uid)
    const path = join(root, 'archived session')
    mkdirSync(path)
    writeFileSync(join(path, 'log'), 'fixture')
    const target = { path, tree: safeTree(path) }
    const id = randomUUID()
    const receipt = io.recycleTarget(target, id)
    expect(io.findRecycledTarget(target, Date.now(), id)).toEqual(receipt)
    expect(() => io.verifyRecycledTarget(target, receipt, randomUUID())).toThrow()
    expect(readFileSync(join(receipt.recyclePath, 'log'), 'utf8')).toBe('fixture')
    writeFileSync(join(receipt.recyclePath, 'log'), 'changed')
    expect(() => io.verifyRecycledTarget(target, receipt, id)).toThrow()
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})
it('reuses an intent folder left behind before the move', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mac-trash-resume-')))
  try {
    const trash = join(root, '.Trash')
    mkdirSync(trash)
    const io = macTrash(trash, lstatSync(trash).uid)
    const path = join(root, 'archived session')
    mkdirSync(path)
    writeFileSync(join(path, 'log'), 'fixture')
    const id = randomUUID()
    mkdirSync(join(trash, 'OPL DSH-' + id))
    const target = { path, tree: safeTree(path) }
    expect(io.recycleTarget(target, id).operationId).toBe(id)
    expect(existsSync(path)).toBe(false)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})
it('blocks Desktop and detached profile users and refuses an incomplete process list', () => {
  const check = (text: string) =>
    checkMacProcesses(
      text,
      42,
      '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      '/Users/test/.dsh',
    )
  const self = ' 42 node cleanup.mjs --home /Users/test/.dsh'
  expect(() => check(self)).not.toThrow()
  expect(() =>
    check(
      self + '\n99 /Users/other/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    ),
  ).not.toThrow()
  for (const process of [
    '99 /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    '99 /Applications/DeepSeek Harness.app/Contents/Frameworks/DeepSeek Harness Helper.app/Contents/MacOS/DeepSeek Harness Helper',
    '99 node host --home /Users/test/.dsh',
  ]) {
    expect(() => check(self + '\n' + process)).toThrow()
  }
  expect(() => check('99 unrelated')).toThrow()
})
