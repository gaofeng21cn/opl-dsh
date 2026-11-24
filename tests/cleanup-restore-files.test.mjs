import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recycleTarget, safeTree } from '../installer/cleanup-skill/windows-io.mjs'
import { currentMacTrash } from '../installer/cleanup-skill/macos-io.mjs'
import { restoreRecycledTree } from '../installer/cleanup-skill/restore-files.mjs'
test(
  'a recycled session can be restored and resumed without replacing an occupied path',
  { skip: !['darwin', 'win32'].includes(process.platform) },
  async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'opl-restore-test-'))
    const path = join(root, 'test-session')
    const marker = join(path, 'fixture')
    try {
      mkdirSync(path)
      writeFileSync(marker, 'round trip')
      const target = { path, tree: safeTree(path) }
      const receipt =
        process.platform === 'darwin'
          ? currentMacTrash().recycleTarget(target, randomUUID())
          : await recycleTarget(target)
      mkdirSync(path)
      writeFileSync(marker, 'keep me')
      assert.throws(() => restoreRecycledTree(receipt, target), /不能覆盖/)
      assert.equal(readFileSync(marker, 'utf8'), 'keep me')
      rmSync(path, { recursive: true })
      restoreRecycledTree(receipt, target)
      restoreRecycledTree(receipt, target)
      assert.equal(readFileSync(marker, 'utf8'), 'round trip')
      assert.equal(lstatSync(receipt.recyclePath, { throwIfNoEntry: false }), undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
