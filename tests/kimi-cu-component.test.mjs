import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { acquireSuiteMaintenance } from '../installer/update-transaction.mjs'
import { componentStatus, updateComponent } from '../installer/kimi-cu-component.mjs'

async function windowsInstallation(root, version) {
  for (const dir of ['plugin/runtime', 'plugin/public/node_modules/@kimi/cu', 'runtime'])
    await mkdir(join(root, dir), { recursive: true })
  for (const file of [
    'plugin/runtime/node-repl.exe',
    'plugin/public/node_modules/@kimi/cu/index.mjs',
    'runtime/kimi-cu.exe',
  ])
    await writeFile(join(root, file), '')
  await writeFile(
    join(root, 'plugin/kimi.plugin.json'),
    JSON.stringify({
      version,
      name: 'kimi-cu-win',
      mcpServers: { win: { command: './runtime/node-repl.exe' } },
    }),
  )
}

test('Windows reads the DSH plugin and retains its version if the official feed is unavailable or incompatible', async (t) => {
  const suiteRoot = await mkdtemp(join(tmpdir(), 'opl-component-status-'))
  t.after(() => rm(suiteRoot, { recursive: true, force: true }))
  const root = join(suiteRoot, 'kimi-cu', '0.3.10')
  await windowsInstallation(root, '0.3.10')
  const options = { suiteRoot, platform: 'win32', arch: 'x64', env: {} }
  const local = await componentStatus({
    ...options,
    fetchImpl: () => assert.fail('local-only read'),
  })
  assert.equal(local.installedVersion, '0.3.10')
  const failed = await componentStatus({
    ...options,
    check: true,
    fetchImpl: async () => new Response('', { status: 503 }),
  })
  assert.equal(failed.installedVersion, local.installedVersion)
  assert.equal(failed.error, 'check-failed')
  const unknown = await updateComponent({
    ...options,
    fetchImpl: async () => Response.json({ version: '0.4.0' }),
  })
  assert.equal(unknown.latestVersion, '0.4.0')
  assert.equal(unknown.available, false)
  assert.equal(unknown.error, 'unvalidated')
  await rm(join(root, 'runtime/kimi-cu.exe'))
  assert.equal((await componentStatus(options)).error, 'read-failed')
})

test('Windows preserves an external runtime and skips unusable managed candidates', async (t) => {
  const suiteRoot = await mkdtemp(join(tmpdir(), 'opl-component-selection-'))
  t.after(() => rm(suiteRoot, { recursive: true, force: true }))
  const external = join(suiteRoot, 'external')
  const older = join(suiteRoot, 'kimi-cu', '0.3.10')
  const newer = join(suiteRoot, 'kimi-cu', '0.3.13')
  const options = { suiteRoot, platform: 'win32', arch: 'x64' }
  await windowsInstallation(external, '0.3.10')
  await windowsInstallation(older, '0.3.10')
  await windowsInstallation(newer, '0.3.13')

  const explicit = await updateComponent({
    ...options,
    env: { OPL_KIMI_CU_WINDOWS_ROOT: external },
    fetchImpl: () => assert.fail('the Suite does not update an external installation'),
  })
  assert.deepEqual(explicit, {
    installedVersion: '0.3.10',
    latestVersion: null,
    available: false,
  })
  const legacyDefault = { ...options, env: { OPL_KIMI_CU_WINDOWS_ROOT: older } }
  assert.equal((await componentStatus(legacyDefault)).installedVersion, '0.3.13')
  await rm(join(newer, 'plugin/public/node_modules/@kimi/cu/index.mjs'))
  assert.equal((await componentStatus(legacyDefault)).installedVersion, '0.3.10')
})

test('macOS compares the architecture-specific release and refuses a changed update target', async (t) => {
  const suiteRoot = await mkdtemp(join(tmpdir(), 'opl-component-mac-'))
  t.after(() => rm(suiteRoot, { recursive: true, force: true }))
  let requests = 0
  const options = {
    suiteRoot,
    appPath: join(suiteRoot, 'KimiCU.app'),
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: async () => {
      requests++
      return Response.json({
        version: '0.7.6',
        app: {
          url: 'https://cdn.kimi.com/kimi-computer-use/0.7.6/KimiCU.app.zip',
          sha256: 'a'.repeat(64),
          team_id: '2J9472RW75',
        },
      })
    },
  }
  assert.deepEqual(await componentStatus({ ...options, check: true }), {
    installedVersion: null,
    latestVersion: '0.7.6',
    available: true,
  })
  const changed = await updateComponent({ ...options, expectedVersion: '0.7.5' })
  assert.equal(changed.error, 'check-failed')
  assert.equal(requests, 2)
  const lease = await acquireSuiteMaintenance(suiteRoot)
  try {
    assert.equal((await updateComponent(options)).error, 'busy')
    assert.equal(requests, 3)
  } finally {
    await lease.release()
  }
})
