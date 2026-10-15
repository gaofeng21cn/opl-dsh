import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildNativeBridge } from '../scripts/build-native-bridge.mjs'

test('the standalone bridge builder creates its output tree on a clean runner', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'opl-clean-bridge-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const output = join(scratch, 'new-output')
  await buildNativeBridge(process.cwd(), output)
  const bytes = await readFile(join(output, 'package/lib/native-harness-bridge.mjs'))
  assert.ok(bytes.length > 0)
})
