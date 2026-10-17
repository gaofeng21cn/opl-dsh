import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { officialPnpm } from '../installer/official-pnpm.cjs'

test('installer supports official ESM and legacy CJS pnpm distributions', async () => {
  const resources = await mkdtemp(join(tmpdir(), 'opl-pnpm-'))
  try {
    const bin = join(resources, 'runtime/pnpm/bin')
    await mkdir(bin, { recursive: true })
    assert.throws(() => officialPnpm(resources), /缺少内置 pnpm/)
    await writeFile(join(bin, 'pnpm.cjs'), '')
    assert.equal(officialPnpm(resources), join(bin, 'pnpm.cjs'))
    await writeFile(join(bin, 'pnpm.mjs'), '')
    assert.equal(officialPnpm(resources), join(bin, 'pnpm.mjs'))
    await rm(join(bin, 'pnpm.cjs'))
    assert.equal(officialPnpm(resources), join(bin, 'pnpm.mjs'))
  } finally {
    await rm(resources, { recursive: true })
  }
})
