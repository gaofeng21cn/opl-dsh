import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readFileSync,
  linkSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  codexCandidatePlan as plan,
  verifyCodexCandidate,
  importCodexCandidate,
} from '../scripts/codex-candidate/lifecycle.mjs'
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'opl-codex-package-'))
  const source = join(root, 'source')
  mkdirSync(source)
  for (const name of Object.keys(plan.files)) {
    mkdirSync(dirname(join(source, name)), { recursive: true })
    writeFileSync(join(source, name), 'synthetic')
  }
  writeFileSync(join(source, 'manifest.json'), JSON.stringify(plan))
  try {
    run({ root, source })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
test('does not trust a manifest that merely rehashes an arbitrary installation', () =>
  fixture(({ source }) => {
    const forged = structuredClone(plan)
    for (const name of Object.keys(forged.files))
      forged.files[name] = createHash('sha256')
        .update(readFileSync(join(source, name)))
        .digest('hex')
    writeFileSync(join(source, 'manifest.json'), JSON.stringify(forged))
    assert.throws(() => verifyCodexCandidate(source), /已验收构建/)
  }))
test('rejects modified binaries even with the authentic build identity', () =>
  fixture(({ source }) => {
    assert.throws(() => verifyCodexCandidate(source), /摘要不一致/)
  }))
test('requires the code-mode host before accepting a package', () =>
  fixture(({ source }) => {
    rmSync(join(source, 'bin/codex-code-mode-host.exe'))
    assert.throws(() => verifyCodexCandidate(source), /文件集合/)
  }))
test('rejects extra launcher commands and unknown versions without importing', () =>
  fixture(({ root, source }) => {
    writeFileSync(join(source, 'codex.cmd'), '@echo unwanted')
    assert.throws(() => verifyCodexCandidate(source), /文件集合/)
    assert.throws(
      () => importCodexCandidate(source, join(root, 'store'), '../../outside'),
      /尚未验收/,
    )
  }))
test('rejects a Store junction before touching its external target', () =>
  fixture(({ root, source }) => {
    const target = join(root, 'canary'),
      store = join(root, 'linked-store')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'unchanged')
    symlinkSync(target, store, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => importCodexCandidate(source, store), /junction/)
    assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'unchanged')
  }))
test('never rewrites a linked manifest or an external canary on verification failure', () =>
  fixture(({ root, source }) => {
    const canary = join(root, 'canary.json'),
      manifest = join(source, 'manifest.json')
    rmSync(manifest)
    writeFileSync(canary, JSON.stringify(plan))
    linkSync(canary, manifest)
    const before = readFileSync(canary)
    assert.throws(() => importCodexCandidate(source, join(root, 'store')), /摘要不一致/)
    assert.deepEqual(readFileSync(canary), before)
  }))
