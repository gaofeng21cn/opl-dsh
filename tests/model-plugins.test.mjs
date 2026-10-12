import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MODEL_PLUGINS,
  installModelPlugins,
  preserveModelPlugins,
} from '../installer/model-plugins.cjs'

async function profile(manifest, run) {
  const dir = await mkdtemp(join(tmpdir(), 'opl-model-plugins-'))
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('first installation delegates the original upstream package to the official manager', async () => {
  await profile({ dependencies: { 'user-plugin': '1.0.0' } }, async (dir) => {
    const calls = []
    await installModelPlugins({ dir, install: async (args) => calls.push(args) })
    assert.deepEqual(
      calls,
      MODEL_PLUGINS.map((plugin) => ['add', plugin.source]),
    )
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')), {
      dependencies: { 'user-plugin': '1.0.0' },
    })
  })
})

test('OPL reinstall preserves a user-selected source, newer version and disabled bundle', async () => {
  const manifest = {
    dependencies: { 'dsh-our-free-model': 'file:/user/ofm-3.0.0.tgz' },
    dsh: { profile: { bundles: ['@one-person-lab/dsh-opl'] } },
  }
  await profile(manifest, async (dir) => {
    const installed = join(dir, 'node_modules/dsh-our-free-model')
    await mkdir(installed, { recursive: true })
    await writeFile(join(installed, 'package.json'), JSON.stringify({ version: '3.0.0' }))
    await installModelPlugins({ dir, install: async () => assert.fail('must not reinstall') })
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')), manifest)
    assert.equal(
      JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version,
      '3.0.0',
    )
  })
})

test('repair restores the existing profile instead of replacing the upstream dependency', async () => {
  await profile({ dependencies: { 'dsh-our-free-model': 'file:/user/ofm.tgz' } }, async (dir) => {
    const calls = []
    await installModelPlugins({ dir, install: async (args) => calls.push(args) })
    assert.deepEqual(calls, [['install']])
  })
})

for (const failed of [false, true])
  test(`OPL package installation preserves self-updated plugin bytes after ${failed ? 'failure' : 'success'}`, async () => {
    await profile({ dependencies: { 'dsh-our-free-model': 'original-source' } }, async (dir) => {
      const installed = join(dir, 'node_modules/dsh-our-free-model')
      await mkdir(installed, { recursive: true })
      await writeFile(join(installed, 'package.json'), '{"version":"3.0.0"}')
      await writeFile(join(installed, 'upstream-new-file.js'), 'original upstream bytes')
      const result = preserveModelPlugins({
        dir,
        install: async () => {
          await rm(installed, { recursive: true })
          await mkdir(installed)
          await writeFile(join(installed, 'package.json'), '{"version":"2.1.0"}')
          await writeFile(join(installed, 'old-version-file.js'), 'old bytes')
          if (failed) throw Error('pnpm failed')
        },
      })
      if (failed) await assert.rejects(result, /pnpm failed/)
      else await result
      assert.equal(await readFile(join(installed, 'package.json'), 'utf8'), '{"version":"3.0.0"}')
      assert.equal(
        await readFile(join(installed, 'upstream-new-file.js'), 'utf8'),
        'original upstream bytes',
      )
      await assert.rejects(readFile(join(installed, 'old-version-file.js')), { code: 'ENOENT' })
    })
  })
