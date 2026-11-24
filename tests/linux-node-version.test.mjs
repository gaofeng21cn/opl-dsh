import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test(
  'Linux installer rejects unsupported Node versions before reading the payload or writing data',
  {
    skip: process.platform !== 'linux',
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'opl-node-version-'))
    const entry = fileURLToPath(new URL('../installer/install-linux.mjs', import.meta.url))
    try {
      for (const [version, supported] of [
        ['24.22.2', false],
        ['24.22.3', true],
        ['25.0.0', false],
        ['26.13.0', false],
        ['26.13.1', true],
        ['27.0.0', true],
        ['27.0.0-rc.1', false],
      ]) {
        const override =
          'data:text/javascript,' +
          encodeURIComponent(
            `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} })`,
          )
        const result = spawnSync(process.execPath, ['--import', override, entry, root], {
          encoding: 'utf8',
          env: { ...process.env, OPL_SUITE_ROOT: root, OPL_DSH_HOME: root },
        })
        assert.equal(result.status, 1)
        assert.match(result.stderr, supported ? /ENOENT.*artifact\.json/ : /Linux 安装需要 Node.js/)
      }
      assert.deepEqual(readdirSync(root), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
