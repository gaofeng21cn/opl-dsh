import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyRuntimeBackup,
  reclaimOfficialArchives,
  reclaimOldReleases,
  reclaimRuntimeBackups,
} from '../installer/runtime-backups.mjs'

const installerDir = fileURLToPath(new URL('../installer', import.meta.url))
const macArm64IntegrationMissing =
  process.platform !== 'darwin' || process.arch !== 'arm64'
    ? 'install.command macOS integration requires darwin/arm64'
    : !existsSync('/bin/bash') || !existsSync('/usr/libexec/PlistBuddy')
      ? 'install.command integration requires /bin/bash and /usr/libexec/PlistBuddy'
      : false

function createFakeApp(appDir, version = '0.2.2-rc.5') {
  mkdirSync(join(appDir, 'Contents/MacOS'), { recursive: true })
  mkdirSync(join(appDir, 'Contents/Resources'), { recursive: true })
  writeFileSync(
    join(appDir, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict>
</plist>
`,
  )
  writeFileSync(
    join(appDir, 'Contents/MacOS/DeepSeek Harness'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    { mode: 0o700 },
  )
  writeFileSync(join(appDir, 'Contents/Resources/app.asar'), 'fake-asar\n')
}

function createSuiteFixture(
  t,
  { appDirName = 'apps/DeepSeek Harness.app', version = '0.2.2-rc.5' } = {},
) {
  const scratch = mkdtempSync(join(tmpdir(), 'opl-runtime-backups-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const root = join(scratch, 'suite')
  const runtime = join(root, 'runtime')
  const app = join(scratch, appDirName)
  mkdirSync(runtime, { recursive: true })
  createFakeApp(app, version)
  writeFileSync(
    join(root, 'installation.json'),
    JSON.stringify({ version: 3, suiteRoot: root, app, officialVersion: version }, null, 2),
  )
  return { scratch, root, runtime, app }
}

function makeBackup(runtime, name, mtimeMs) {
  const target = join(runtime, name)
  mkdirSync(join(target, 'Contents/MacOS'), { recursive: true })
  writeFileSync(join(target, 'Contents/MacOS/DeepSeek Harness'), '#!/bin/sh\nexit 0\n', {
    mode: 0o700,
  })
  if (mtimeMs !== undefined) {
    const time = new Date(mtimeMs)
    utimesSync(target, time, time)
  }
  return target
}

test('classifyRuntimeBackup recognizes official backups, legacy launcher backups, and legacy fork apps', () => {
  assert.deepEqual(classifyRuntimeBackup('DeepSeek Harness.backup.1764000000.app'), {
    kind: 'official-backup',
    tier: 2,
    hasEpoch: true,
    epoch: 1764000000,
    seq: 0,
  })
  assert.deepEqual(classifyRuntimeBackup('DeepSeek Harness.backup.1764000000-2.app'), {
    kind: 'official-backup',
    tier: 2,
    hasEpoch: true,
    epoch: 1764000000,
    seq: 2,
  })
  assert.deepEqual(classifyRuntimeBackup('OPL DSH.app.backup.1758800000'), {
    kind: 'launcher-backup',
    tier: 1,
    hasEpoch: true,
    epoch: 1758800000,
    seq: 0,
  })
  assert.deepEqual(classifyRuntimeBackup('OPL DSH.legacy-0.1.6-alpha.1.app'), {
    kind: 'legacy-app',
    tier: 0,
    hasEpoch: false,
    epoch: 0,
    seq: 0,
  })
  assert.equal(classifyRuntimeBackup('DeepSeek Harness.app'), null)
  assert.equal(classifyRuntimeBackup('unrelated-dir'), null)
})

test('reclaimRuntimeBackups keeps only the latest backup and removes older backups and legacy apps idempotently', (t) => {
  const { root, runtime, app } = createSuiteFixture(t)
  const keptName = 'DeepSeek Harness.backup.1764000400.app'
  for (const name of [
    'DeepSeek Harness.backup.1764000100.app',
    'DeepSeek Harness.backup.1764000200.app',
    'DeepSeek Harness.backup.1764000300.app',
    keptName,
    'OPL DSH.app.backup.1758800000',
    'OPL DSH.legacy-0.1.6-alpha.1.app',
  ]) {
    makeBackup(runtime, name)
  }
  // Unrelated runtime entries must remain untouched.
  makeBackup(runtime, 'DeepSeek Harness.app')
  mkdirSync(join(runtime, 'custom-dir'))
  writeFileSync(join(runtime, 'notes.txt'), 'keep\n')

  const first = reclaimRuntimeBackups({ root, app, listProcessCommands: () => [] })
  assert.deepEqual(first.kept, [join(runtime, keptName)])
  assert.equal(first.removed.length, 5)
  assert.deepEqual(first.skippedRunning, [])
  assert.deepEqual(first.failed, [])
  assert.deepEqual(readdirSync(runtime).sort(), [
    'DeepSeek Harness.app',
    keptName,
    'custom-dir',
    'notes.txt',
  ])

  const second = reclaimRuntimeBackups({ root, app, listProcessCommands: () => [] })
  assert.deepEqual(second.kept, [join(runtime, keptName)])
  assert.deepEqual(second.removed, [])
  assert.deepEqual(readdirSync(runtime).sort(), [
    'DeepSeek Harness.app',
    keptName,
    'custom-dir',
    'notes.txt',
  ])
})

test('reclaimRuntimeBackups respects same-second sequence suffixes, non-numeric mtimes, and launcher fallback retention', (t) => {
  const { root, runtime, app } = createSuiteFixture(t)
  // Create newer epoch/seq first with older mtime to ensure epoch+seq ordering wins over filesystem mtime.
  makeBackup(runtime, 'DeepSeek Harness.backup.1764000000-2.app', 1_000_000)
  makeBackup(runtime, 'DeepSeek Harness.backup.1764000000-1.app', 2_000_000)
  makeBackup(runtime, 'DeepSeek Harness.backup.1764000000.app', 3_000_000)
  makeBackup(runtime, 'DeepSeek Harness.backup.custom.app', 9_000_000)

  const res = reclaimRuntimeBackups({ root, app, listProcessCommands: () => [] })
  assert.deepEqual(res.kept, [join(runtime, 'DeepSeek Harness.backup.1764000000-2.app')])
  assert.deepEqual(readdirSync(runtime), ['DeepSeek Harness.backup.1764000000-2.app'])

  // When only OPL DSH.app.backup.* exist, keep the newest 1.
  rmSync(join(runtime, 'DeepSeek Harness.backup.1764000000-2.app'), {
    recursive: true,
    force: true,
  })
  makeBackup(runtime, 'OPL DSH.app.backup.1758800001')
  makeBackup(runtime, 'OPL DSH.app.backup.1758800002')
  const launcherOnly = reclaimRuntimeBackups({ root, app, listProcessCommands: () => [] })
  assert.deepEqual(launcherOnly.kept, [join(runtime, 'OPL DSH.app.backup.1758800002')])
  assert.deepEqual(readdirSync(runtime), ['OPL DSH.app.backup.1758800002'])

  // Non-numeric backup suffixes fall back to mtimeMs ordering.
  rmSync(join(runtime, 'OPL DSH.app.backup.1758800002'), { recursive: true, force: true })
  makeBackup(runtime, 'DeepSeek Harness.backup.alpha.app', 1_000_000)
  makeBackup(runtime, 'DeepSeek Harness.backup.beta.app', 5_000_000)
  const nonNumeric = reclaimRuntimeBackups({ root, app, listProcessCommands: () => [] })
  assert.deepEqual(nonNumeric.kept, [join(runtime, 'DeepSeek Harness.backup.beta.app')])
  assert.deepEqual(readdirSync(runtime), ['DeepSeek Harness.backup.beta.app'])
})

test('reclaimRuntimeBackups never deletes running bundles, active app paths, or symlinks', (t) => {
  const { scratch, root, runtime, app } = createSuiteFixture(t)
  const runningBackup = makeBackup(runtime, 'DeepSeek Harness.backup.1764000100.app')
  makeBackup(runtime, 'DeepSeek Harness.backup.1764000200.app')
  makeBackup(runtime, 'DeepSeek Harness.backup.1764000300.app')

  const externalTarget = join(scratch, 'external-dir')
  mkdirSync(externalTarget, { recursive: true })
  writeFileSync(join(externalTarget, 'important.txt'), 'do-not-delete\n')
  symlinkSync(externalTarget, join(runtime, 'DeepSeek Harness.backup.1764000050.app'))

  const result = reclaimRuntimeBackups({
    root,
    app,
    listProcessCommands: () => [`${runningBackup}/Contents/MacOS/DeepSeek Harness --type=renderer`],
  })
  assert.deepEqual(result.kept, [join(runtime, 'DeepSeek Harness.backup.1764000300.app')])
  assert.deepEqual(result.removed, [join(runtime, 'DeepSeek Harness.backup.1764000200.app')])
  assert.deepEqual(result.skippedRunning, [runningBackup])
  assert.equal(existsSync(join(externalTarget, 'important.txt')), true)
  assert.equal(existsSync(join(runtime, 'DeepSeek Harness.backup.1764000050.app')), true)

  // Even if active app is inside runtime/ and matches backup naming, it is never deleted.
  const activeInRuntime = join(runtime, 'DeepSeek Harness.backup.1764000999.app')
  createFakeApp(activeInRuntime, '0.2.2-rc.5')
  writeFileSync(
    join(root, 'installation.json'),
    JSON.stringify({
      version: 3,
      suiteRoot: root,
      app: activeInRuntime,
      officialVersion: '0.2.2-rc.5',
    }),
  )
  const activeProtected = reclaimRuntimeBackups({
    root,
    app: activeInRuntime,
    keep: 0,
    listProcessCommands: () => [],
  })
  assert.equal(existsSync(activeInRuntime), true)
  assert.ok(!activeProtected.removed.includes(activeInRuntime))
})

test('reclaimRuntimeBackups fails safe on missing receipt, unsafe runtime symlink, process inspection failure, or partial rm errors', (t) => {
  const { scratch, root, runtime, app } = createSuiteFixture(t)
  const oldBackup = makeBackup(runtime, 'DeepSeek Harness.backup.1764000100.app')
  const midBackup = makeBackup(runtime, 'DeepSeek Harness.backup.1764000200.app')
  makeBackup(runtime, 'DeepSeek Harness.backup.1764000300.app')

  // Process inspection error aborts without deletion.
  const warnings = []
  const psFailed = reclaimRuntimeBackups({
    root,
    app,
    listProcessCommands: () => null,
    onWarn: (msg) => warnings.push(msg),
  })
  assert.equal(psFailed.skipped, 'process-inspection-failed')
  assert.equal(psFailed.removed.length, 0)
  assert.equal(warnings.length, 1)
  assert.equal(existsSync(oldBackup), true)

  // Missing or mismatched installation.json aborts without deletion.
  const receiptPath = join(root, 'installation.json')
  const savedReceipt = readFileSync(receiptPath, 'utf8')
  writeFileSync(
    receiptPath,
    JSON.stringify({ app: join(scratch, 'other.app'), officialVersion: '0.2.2-rc.5' }),
  )
  assert.equal(
    reclaimRuntimeBackups({ root, app, listProcessCommands: () => [] }).skipped,
    'unverified-active-app',
  )
  assert.equal(existsSync(oldBackup), true)
  writeFileSync(receiptPath, savedReceipt)

  // Partial rm error logs warning and continues reclaiming other obsolete backups.
  const partial = reclaimRuntimeBackups({
    root,
    app,
    listProcessCommands: () => [],
    removeEntry: (target) => {
      if (target === midBackup) throw new Error('EACCES: busy')
      rmSync(target, { recursive: true, force: true })
    },
    onWarn: (msg) => warnings.push(msg),
  })
  assert.deepEqual(partial.removed, [oldBackup])
  assert.equal(partial.failed.length, 1)
  assert.equal(partial.failed[0].path, midBackup)
  assert.equal(existsSync(midBackup), true)

  // Symlinked runtime directory is rejected safely.
  const altSuite = join(scratch, 'alt-suite')
  mkdirSync(altSuite, { recursive: true })
  writeFileSync(join(altSuite, 'installation.json'), savedReceipt)
  symlinkSync(runtime, join(altSuite, 'runtime'))
  assert.equal(
    reclaimRuntimeBackups({ root: altSuite, app, listProcessCommands: () => [] }).skipped,
    'unsafe-runtime',
  )
})

function buildInstallCommandFixture(t, { installMjsBehavior = 'succeed' } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'opl-install-command-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const payload = join(scratch, 'payload')
  const bin = join(scratch, 'bin')
  const suite = join(scratch, 'suite')
  const apps = join(scratch, 'apps')
  const archiveStage = join(scratch, 'archive-stage')
  mkdirSync(payload, { recursive: true })
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(suite, 'runtime'), { recursive: true })
  mkdirSync(apps, { recursive: true })
  mkdirSync(archiveStage, { recursive: true })

  for (const file of [
    'install.command',
    'official-feed.awk',
    'compare.cjs',
    'runtime-backups.mjs',
  ]) {
    copyFileSync(join(installerDir, file), join(payload, file))
  }
  // compare.cjs requires semver; link node_modules so the standalone fixture payload can resolve it.
  symlinkSync(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(payload, 'node_modules'),
  )

  if (installMjsBehavior === 'succeed') {
    writeFileSync(
      join(payload, 'install.mjs'),
      `import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [app, root] = process.argv.slice(2)
const plist = readFileSync(join(app, 'Contents/Info.plist'), 'utf8')
const match = /<key>CFBundleShortVersionString<\\/key>\\s*<string>([^<]+)<\\/string>/u.exec(plist)
writeFileSync(
  join(root, 'installation.json'),
  JSON.stringify({ version: 3, suiteRoot: root, app, officialVersion: match?.[1] ?? '0.2.2-rc.5' }, null, 2),
)
`,
    )
  } else {
    writeFileSync(
      join(payload, 'install.mjs'),
      "console.error('MOCK_INSTALL_MJS_FAILURE'); process.exit(1)\n",
    )
  }

  const nextVersion = '0.2.2-rc.5'
  createFakeApp(join(archiveStage, 'DeepSeek Harness.app'), nextVersion)
  const archive = join(scratch, `deepseek-harness-${nextVersion}.zip`)
  execFileSync('/usr/bin/ditto', [
    '-c',
    '-k',
    '--keepParent',
    join(archiveStage, 'DeepSeek Harness.app'),
    archive,
  ])
  const sha512 = createHash('sha512').update(readFileSync(archive)).digest('base64')

  const stubScript = (name, body) =>
    writeFileSync(join(bin, name), '#!/bin/bash\nset -eu\n' + body, { mode: 0o700 })
  stubScript(
    'curl',
    `cat <<'EOF'
version: ${nextVersion}
path: https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-${nextVersion}-mac-arm64.zip
sha512: ${sha512}
EOF
`,
  )
  stubScript('codesign', 'exit 0\n')
  stubScript('spctl', 'exit 0\n')

  return { scratch, payload, bin, suite, apps, archive, nextVersion }
}

test(
  'install.command prunes historical runtime backups on upgrade, handles same-second retries, and stays idempotent',
  { skip: macArm64IntegrationMissing },
  (t) => {
    const { payload, bin, suite, apps, archive, nextVersion } = buildInstallCommandFixture(t)
    const activeApp = join(apps, 'DeepSeek Harness.app')
    createFakeApp(activeApp, '0.2.1-rc.1')
    for (const old of [
      'DeepSeek Harness.backup.1764000100.app',
      'DeepSeek Harness.backup.1764000200.app',
      'DeepSeek Harness.backup.1764000300.app',
      'OPL DSH.app.backup.1758800000',
      'OPL DSH.legacy-0.1.6-alpha.1.app',
    ]) {
      makeBackup(join(suite, 'runtime'), old)
    }
    mkdirSync(join(suite, 'runtime', 'keep-unrelated'))

    const env = {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      OPL_SUITE_ROOT: suite,
      OPL_APPLICATIONS_DIR: apps,
      OPL_OFFICIAL_ARCHIVE: archive,
      OPL_OFFICIAL_MIN_VERSION: '',
      OPL_INSTALL_NO_LAUNCH: '1',
    }
    const upgradeRun = spawnSync('/bin/bash', [join(payload, 'install.command')], {
      encoding: 'utf8',
      env,
    })
    assert.equal(upgradeRun.status, 0, upgradeRun.stderr)

    const afterUpgrade = readdirSync(join(suite, 'runtime')).sort()
    const retainedBackups = afterUpgrade.filter((name) =>
      name.startsWith('DeepSeek Harness.backup.'),
    )
    assert.equal(retainedBackups.length, 1, `Expected 1 retained backup, got: ${afterUpgrade}`)
    assert.deepEqual(afterUpgrade, [retainedBackups[0], 'keep-unrelated'])

    const installedVersion = execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print CFBundleShortVersionString', join(activeApp, 'Contents/Info.plist')],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(installedVersion, nextVersion)

    // Repeat run when already on latest official version (NEED_INSTALL=0) must remain idempotent.
    const repeatRun = spawnSync('/bin/bash', [join(payload, 'install.command')], {
      encoding: 'utf8',
      env,
    })
    assert.equal(repeatRun.status, 0, repeatRun.stderr)
    assert.deepEqual(readdirSync(join(suite, 'runtime')).sort(), [
      retainedBackups[0],
      'keep-unrelated',
    ])
  },
)

test(
  'install.command self-heals accumulated backups on NEED_INSTALL=0 while protecting running backup processes',
  { skip: macArm64IntegrationMissing },
  async (t) => {
    const { payload, bin, suite, apps, archive, nextVersion } = buildInstallCommandFixture(t)
    const activeApp = join(apps, 'DeepSeek Harness.app')
    createFakeApp(activeApp, nextVersion)

    const runningBackup = makeBackup(
      join(suite, 'runtime'),
      'DeepSeek Harness.backup.1764000100.app',
    )
    makeBackup(join(suite, 'runtime'), 'DeepSeek Harness.backup.1764000200.app')
    makeBackup(join(suite, 'runtime'), 'DeepSeek Harness.backup.1764000300.app')
    makeBackup(join(suite, 'runtime'), 'OPL DSH.legacy-0.1.6-alpha.1.app')

    // Launch a real child process whose argv[0] sits inside the older backup bundle.
    const runnerExe = join(runningBackup, 'Contents/MacOS/DeepSeek Harness')
    rmSync(runnerExe)
    symlinkSync(process.execPath, runnerExe)
    const child = spawn(runnerExe, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    t.after(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    })

    // Wait briefly until ps observes the child command line.
    let observed = false
    for (let i = 0; i < 20; i++) {
      const ps = spawnSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' })
      if (ps.stdout?.includes(runnerExe)) {
        observed = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(observed, true, 'expected running backup process in /bin/ps output')

    const result = spawnSync('/bin/bash', [join(payload, 'install.command')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        OPL_SUITE_ROOT: suite,
        OPL_APPLICATIONS_DIR: apps,
        OPL_OFFICIAL_ARCHIVE: archive,
        OPL_OFFICIAL_MIN_VERSION: '',
        OPL_INSTALL_NO_LAUNCH: '1',
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readdirSync(join(suite, 'runtime')).sort(), [
      'DeepSeek Harness.backup.1764000100.app',
      'DeepSeek Harness.backup.1764000300.app',
    ])
  },
)

test(
  'install.command preserves all runtime backups when install.mjs fails',
  { skip: macArm64IntegrationMissing },
  (t) => {
    const { payload, bin, suite, apps, archive } = buildInstallCommandFixture(t, {
      installMjsBehavior: 'fail',
    })
    createFakeApp(join(apps, 'DeepSeek Harness.app'), '0.2.1-rc.1')
    makeBackup(join(suite, 'runtime'), 'DeepSeek Harness.backup.1764000100.app')
    makeBackup(join(suite, 'runtime'), 'DeepSeek Harness.backup.1764000200.app')
    makeBackup(join(suite, 'runtime'), 'OPL DSH.legacy-0.1.6-alpha.1.app')

    const failedRun = spawnSync('/bin/bash', [join(payload, 'install.command')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        OPL_SUITE_ROOT: suite,
        OPL_APPLICATIONS_DIR: apps,
        OPL_OFFICIAL_ARCHIVE: archive,
        OPL_OFFICIAL_MIN_VERSION: '',
        OPL_INSTALL_NO_LAUNCH: '1',
      },
    })
    assert.notEqual(failedRun.status, 0)
    assert.match(failedRun.stderr, /MOCK_INSTALL_MJS_FAILURE/)
    const entries = readdirSync(join(suite, 'runtime')).sort()
    assert.equal(entries.length, 4, `All backups including newly moved app must remain: ${entries}`)
    assert.ok(entries.includes('DeepSeek Harness.backup.1764000100.app'))
    assert.ok(entries.includes('DeepSeek Harness.backup.1764000200.app'))
    assert.ok(entries.includes('OPL DSH.legacy-0.1.6-alpha.1.app'))
  },
)

test(
  'install.command avoids same-second backup collisions during launcher migration and retains the newest backup',
  { skip: macArm64IntegrationMissing },
  (t) => {
    const { payload, bin, suite, apps, archive, nextVersion } = buildInstallCommandFixture(t)
    writeFileSync(join(bin, 'date'), '#!/bin/bash\necho 1764000500\n', { mode: 0o700 })

    // Pre-seed old launcher wrapper in $APPS and old runtime in $ROOT/runtime/DeepSeek Harness.app,
    // plus an existing backup sharing the exact same epoch second.
    const wrapperApp = join(apps, 'DeepSeek Harness.app')
    mkdirSync(join(wrapperApp, 'Contents/Resources'), { recursive: true })
    writeFileSync(join(wrapperApp, 'Contents/Resources/opl-launcher-owner.txt'), suite + '\n')
    createFakeApp(join(suite, 'runtime/DeepSeek Harness.app'), '0.2.1-rc.1')
    makeBackup(join(suite, 'runtime'), 'DeepSeek Harness.backup.1764000500.app')

    const result = spawnSync('/bin/bash', [join(payload, 'install.command')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        OPL_SUITE_ROOT: suite,
        OPL_APPLICATIONS_DIR: apps,
        OPL_OFFICIAL_ARCHIVE: archive,
        OPL_OFFICIAL_MIN_VERSION: '',
        OPL_INSTALL_NO_LAUNCH: '1',
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readdirSync(join(suite, 'runtime')).sort(), [
      'DeepSeek Harness.backup.1764000500-1.app',
    ])
    const installedVersion = execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print CFBundleShortVersionString', join(wrapperApp, 'Contents/Info.plist')],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(installedVersion, nextVersion)
  },
)

test(
  'install.command accepts /stable/ feed paths and promotes feeds below 0.2.3-alpha.2 to verified 0.2.3-alpha.2 floor',
  { skip: macArm64IntegrationMissing },
  (t) => {
    const { scratch, payload, bin, suite, apps } = buildInstallCommandFixture(t, {
      nextVersion: '0.2.2-rc.5',
    })
    const stableFeedStub = `cat <<'EOF'\n# dsh-feed-origin: stable\nversion: 0.2.2-rc.5\npath: https://download.deepseek.com/dsh-desk/bin/mac-arm64/stable/deepseek-harness-0.2.2-rc.5-mac-arm64.zip\nsha512: ${Buffer.alloc(64, 9).toString('base64')}\nEOF\n`
    writeFileSync(join(bin, 'curl'), '#!/bin/bash\nset -eu\n' + stableFeedStub, { mode: 0o700 })
    const wrongFloorArchive = join(scratch, 'wrong-floor.zip')
    writeFileSync(wrongFloorArchive, 'not-official-alpha-2')
    createFakeApp(join(apps, 'DeepSeek Harness.app'), '0.2.2-rc.5')
    const failedFloor = spawnSync('/bin/bash', [join(payload, 'install.command')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        OPL_SUITE_ROOT: suite,
        OPL_APPLICATIONS_DIR: apps,
        OPL_OFFICIAL_ARCHIVE: wrongFloorArchive,
        OPL_INSTALL_NO_LAUNCH: '1',
      },
    })
    assert.notEqual(failedFloor.status, 0)
    assert.match(failedFloor.stdout + failedFloor.stderr, /官方安装包校验失败/)

    // Disable floor: /stable/ feed URL must be accepted cleanly and fail on archive hash only if wrong.
    const validStable = spawnSync('/bin/bash', [join(payload, 'install.command')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        OPL_SUITE_ROOT: suite,
        OPL_APPLICATIONS_DIR: apps,
        OPL_OFFICIAL_MIN_VERSION: '',
        OPL_INSTALL_NO_LAUNCH: '1',
      },
    })
    assert.equal(validStable.status, 0, validStable.stderr)
  },
)

test('reclaimOfficialArchives keeps only the active officialVersion archive and ignores staging/symlinks', (t) => {
  const { scratch, root, app } = createSuiteFixture(t, { version: '0.2.2-rc.5' })
  const cache = join(root, 'cache')
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, 'deepseek-harness-0.1.7-rc.2.zip'), 'old1')
  writeFileSync(join(cache, 'deepseek-harness-0.2.2-rc.1.zip'), 'old2')
  writeFileSync(join(cache, 'deepseek-harness-0.2.2-rc.2.zip'), 'old3')
  writeFileSync(join(cache, 'deepseek-harness-0.2.2-rc.5.zip'), 'current')
  writeFileSync(join(cache, 'deepseek-harness-0.2.2-rc.6.zip.part'), 'in-flight')
  mkdirSync(join(cache, 'unpack.abc123'))
  const externalZip = join(scratch, 'external.zip')
  writeFileSync(externalZip, 'keep-target')
  symlinkSync(externalZip, join(cache, 'deepseek-harness-0.1.0.zip'))

  const first = reclaimOfficialArchives({ root, app })
  assert.deepEqual(first.kept, [join(cache, 'deepseek-harness-0.2.2-rc.5.zip')])
  assert.equal(first.removed.length, 3)
  assert.deepEqual(first.failed, [])
  assert.deepEqual(readdirSync(cache).sort(), [
    'deepseek-harness-0.1.0.zip',
    'deepseek-harness-0.2.2-rc.5.zip',
    'deepseek-harness-0.2.2-rc.6.zip.part',
    'unpack.abc123',
  ])
  assert.equal(readFileSync(externalZip, 'utf8'), 'keep-target')

  const second = reclaimOfficialArchives({ root, app })
  assert.deepEqual(second.kept, [join(cache, 'deepseek-harness-0.2.2-rc.5.zip')])
  assert.deepEqual(second.removed, [])
})

function hashDirName(seed) {
  return createHash('sha256').update(seed).digest('hex')
}

test('reclaimOldReleases keeps active, previous, preservePaths, non-hash dirs, and symlinks while removing older releases', (t) => {
  const { scratch, root, app } = createSuiteFixture(t, { version: '0.2.2-rc.5' })
  const releases = join(root, 'releases')
  const currentHash = hashDirName('0.2.84')
  const previousHash = hashDirName('0.2.83')
  const preservedHash = hashDirName('staging-preserve')
  const staleA = hashDirName('0.2.80')
  const staleB = hashDirName('0.2.81')
  for (const dir of [currentHash, previousHash, preservedHash, staleA, staleB, 'custom-dir']) {
    mkdirSync(join(releases, dir), { recursive: true })
  }
  const externalRelease = join(scratch, 'external-release')
  mkdirSync(externalRelease, { recursive: true })
  symlinkSync(externalRelease, join(releases, hashDirName('symlink-release')))

  writeFileSync(
    join(root, 'installation.json'),
    JSON.stringify(
      {
        version: 3,
        suiteRoot: root,
        app,
        officialVersion: '0.2.2-rc.5',
        release: join(releases, currentHash),
        previousRelease: join(releases, previousHash),
      },
      null,
      2,
    ),
  )

  const first = reclaimOldReleases({
    root,
    app,
    preservePaths: [join(releases, preservedHash)],
    listProcessCommands: () => [`/usr/bin/node ${join(releases, currentHash)}/setup.mjs`],
  })
  assert.equal(first.kept.length, 3)
  assert.deepEqual(first.removed.sort(), [join(releases, staleA), join(releases, staleB)].sort())
  assert.deepEqual(first.skippedRunning, [])
  assert.deepEqual(first.failed, [])
  assert.equal(existsSync(join(releases, currentHash)), true)
  assert.equal(existsSync(join(releases, previousHash)), true)
  assert.equal(existsSync(join(releases, preservedHash)), true)
  assert.equal(existsSync(join(releases, 'custom-dir')), true)
  assert.equal(existsSync(externalRelease), true)

  const second = reclaimOldReleases({
    root,
    app,
    preservePaths: [join(releases, preservedHash)],
    listProcessCommands: () => [],
  })
  assert.deepEqual(second.removed, [])
})

test('reclaimOldReleases skips running release directories and fails safe on missing receipt, missing release, symlink, or ps failure', (t) => {
  const { scratch, root, app } = createSuiteFixture(t, { version: '0.2.2-rc.5' })
  const releases = join(root, 'releases')
  const currentHash = hashDirName('0.2.84')
  const runningOldHash = hashDirName('0.2.79')
  const idleOldHash = hashDirName('0.2.78')
  for (const dir of [currentHash, runningOldHash, idleOldHash]) {
    mkdirSync(join(releases, dir), { recursive: true })
  }

  // Without receipt `release` field, fails safe.
  const withoutRelease = reclaimOldReleases({ root, app, listProcessCommands: () => [] })
  assert.equal(withoutRelease.skipped, 'unverified-active-app')
  assert.deepEqual(withoutRelease.removed, [])

  // Active release pointing to non-existent directory fails safe.
  writeFileSync(
    join(root, 'installation.json'),
    JSON.stringify(
      {
        version: 3,
        suiteRoot: root,
        app,
        officialVersion: '0.2.2-rc.5',
        release: join(releases, hashDirName('missing')),
      },
      null,
      2,
    ),
  )
  const missingActive = reclaimOldReleases({ root, app, listProcessCommands: () => [] })
  assert.equal(missingActive.skipped, 'missing-active-release')
  assert.deepEqual(missingActive.removed, [])

  // Valid receipt: ps failure skips without removing anything.
  writeFileSync(
    join(root, 'installation.json'),
    JSON.stringify(
      {
        version: 3,
        suiteRoot: root,
        app,
        officialVersion: '0.2.2-rc.5',
        release: join(releases, currentHash),
      },
      null,
      2,
    ),
  )
  const psFailed = reclaimOldReleases({
    root,
    app,
    listProcessCommands: () => null,
    onWarn: () => {},
  })
  assert.equal(psFailed.skipped, 'process-inspection-failed')
  assert.deepEqual(psFailed.removed, [])

  // Running process keeps runningOldHash while idleOldHash is pruned.
  const runningResult = reclaimOldReleases({
    root,
    app,
    listProcessCommands: () => [`node ${join(releases, runningOldHash, 'plugin/dist/host.js')}`],
  })
  assert.deepEqual(runningResult.skippedRunning, [join(releases, runningOldHash)])
  assert.deepEqual(runningResult.removed, [join(releases, idleOldHash)])

  // Symlink releases directory fails safe.
  rmSync(releases, { recursive: true, force: true })
  const external = join(scratch, 'external-releases')
  mkdirSync(external, { recursive: true })
  symlinkSync(external, releases)
  const symlinked = reclaimOldReleases({ root, app, listProcessCommands: () => [] })
  assert.equal(symlinked.skipped, 'unsafe-releases')
})

test('verifyVerifiedInstallation supports Windows DeepSeek Harness.exe layout for archive and release reclamation', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'opl-win-reclaim-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const root = join(scratch, 'suite')
  const app = join(root, 'runtime/official')
  const releases = join(root, 'releases')
  const cache = join(root, 'cache')
  const currentHash = hashDirName('win-0.2.84')
  const staleHash = hashDirName('win-0.2.80')
  mkdirSync(join(app, 'resources'), { recursive: true })
  mkdirSync(join(releases, currentHash), { recursive: true })
  mkdirSync(join(releases, staleHash), { recursive: true })
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(app, 'DeepSeek Harness.exe'), 'exe')
  writeFileSync(join(app, 'resources/app.asar'), 'asar')
  writeFileSync(join(cache, 'deepseek-harness-0.2.2-rc.5-win-x64.exe'), 'current')
  writeFileSync(join(cache, 'deepseek-harness-0.2.2-rc.1-win-x64.exe'), 'old')
  writeFileSync(
    join(root, 'installation.json'),
    JSON.stringify(
      {
        version: 3,
        suiteRoot: root,
        app,
        officialVersion: '0.2.2-rc.5',
        release: join(releases, currentHash),
      },
      null,
      2,
    ),
  )

  const archives = reclaimOfficialArchives({ root, app })
  assert.deepEqual(archives.removed, [join(cache, 'deepseek-harness-0.2.2-rc.1-win-x64.exe')])
  const oldReleases = reclaimOldReleases({ root, app, listProcessCommands: () => [] })
  assert.deepEqual(oldReleases.removed, [join(releases, staleHash)])
})
