import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const run = promisify(execFile)
const installer = fileURLToPath(new URL('../installer/profile.cjs', import.meta.url))
const require = createRequire(import.meta.url)
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const teamBundle = '@deepseek-ai/dsh-experimental-agent-team-profile'
const autoReviewBundle = '@deepseek-ai/dsh-experimental-auto-review'
const computerUseBundle = '@deepseek-ai/dsh-cua-bundle'
const officialBundles = [teamBundle, autoReviewBundle]
const autoEnabledBundles = [teamBundle]
const officialVersion = '0.2.2-rc.1'

async function runtime(
  t,
  owner,
  existing,
  {
    disableAndReinstall = false,
    computerUsePlatforms,
    teamVersion,
    promotedTeam = false,
    migrationReceipt,
    cliProfile,
    defaultContext = false,
    installSuiteBundle = false,
    cordisPatch,
    removeContextAndReinstall = false,
  } = {},
) {
  const runtimeVersion = promotedTeam ? '0.2.2-rc.2' : officialVersion
  const root = await mkdtemp(join(tmpdir(), 'opl-profile-template-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const app = join(root, 'official')
  const resources =
    process.platform === 'win32' ? join(app, 'resources') : join(app, 'Contents/Resources')
  const runtime = cliProfile ? app : join(resources, 'app.asar/dsh')
  const payload = join(root, 'payload')
  const home = join(root, 'home')
  const profile = join(home, 'profiles', cliProfile ?? 'desktop')
  await mkdir(runtime, { recursive: true })
  await mkdir(payload)
  await writeFile(join(runtime, 'package.json'), '{"type":"module"}\n')
  await copyFile(installer, join(payload, 'profile.cjs'))
  await copyFile(
    fileURLToPath(new URL('../installer/ofm-owner.cjs', import.meta.url)),
    join(payload, 'ofm-owner.cjs'),
  )
  await writeFile(
    join(payload, 'model-plugins.cjs'),
    'exports.preserveModelPlugins = ({ install }) => install();\n' +
      'exports.installModelPlugins = async () => {};\n',
  )
  await writeFile(join(payload, 'official-pnpm.cjs'), 'exports.officialPnpm = () => "pnpm.cjs";\n')
  async function module(name, exports, source, metadata = {}) {
    const dir = join(runtime, 'node_modules', name)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name, type: 'module', exports, ...metadata }),
    )
    await writeFile(join(dir, 'index.mjs'), source)
  }
  const include = require.resolve('@deepseek-ai/cordis-plugin-include')
  for (const [name, resolved] of [
    ['@deepseek-ai/cordis-plugin-include', include],
    ['yaml', require.resolve('yaml')],
  ])
    await module(
      name,
      './index.mjs',
      `export * from ${JSON.stringify(pathToFileURL(resolved).href)};\n`,
    )
  const template = `export const PROFILE_TEMPLATES = { web: { bundles: ${JSON.stringify(bundles)} } };\n`
  await module(
    '@deepseek-ai/dsh-app-boot',
    './index.mjs',
    `import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export function initProfile(dir, bundles) {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ dsh: { profile: { bundles } } }));
  writeFileSync(join(dir, 'template-observation.json'), JSON.stringify(bundles));
}
export function readProfileManifest(bin, dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}
export function writeProfileBundles(dir, manifest, bundles) {
  const next = { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } } };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(next));
  return next;
}
export function loadProfileDirectory(bin, dir, anchor, options) {
  const manifest = readProfileManifest(bin, dir);
  const retired = ${JSON.stringify(promotedTeam ? [teamBundle] : [])};
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const kept = bundles.filter(name => !retired.includes(name));
  if (kept.length !== bundles.length) writeProfileBundles(dir, manifest, kept);
  writeFileSync(join(dir, 'retirement-observation.json'), JSON.stringify({ bin, anchor, options }));
  return {};
}
${owner === 'app-boot' ? template : ''}`,
  )
  if (owner === 'official-bundles' || promotedTeam)
    await module(
      '@deepseek-ai/dsh-official-bundles',
      './index.mjs',
      template +
        `export const RETIRED_BUNDLES = new Set(${JSON.stringify(promotedTeam ? [teamBundle] : [])});\n`,
    )
  await module(
    '@deepseek-ai/dsh-plugin-manager',
    { './operations': './index.mjs' },
    `import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export async function runPluginCommand(profile, args) {
  if (args[1] === 'billion-context@0.1.216') {
    const file = join(profile.dir, 'package.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.dependencies['billion-context'] = '0.1.216';
    manifest.dsh.profile.bundles.push('billion-context');
    writeFileSync(file, JSON.stringify(manifest));
    return { exitCode: 0 };
  }
  writeFileSync(join(profile.dir, 'install-observation.json'), JSON.stringify({ profile: profile.profile, args }));
  const additions = ${JSON.stringify(installSuiteBundle ? ['@one-person-lab/dsh-opl'] : [])};
  if (additions.length) {
    const manifest = JSON.parse(readFileSync(join(profile.dir, 'package.json'), 'utf8'));
    manifest.dependencies ??= {};
    manifest.dsh ??= { profile: {} };
    manifest.dsh.profile ??= {};
    manifest.dsh.profile.bundles ??= [];
    for (const name of additions) {
      manifest.dependencies[name] = 'file:fixture.tgz';
      manifest.dsh.profile.bundles.push(name);
    }
    writeFileSync(join(profile.dir, 'package.json'), JSON.stringify(manifest));
  }
  return { exitCode: 0 };
}`,
  )
  await module(
    '@deepseek-ai/dsh-atomic-write',
    './index.mjs',
    `import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
export const writeFileAtomic = writeFile;
export async function withFileLock(file, operation, options) {
  assert(file.endsWith('package.json') || file.endsWith('cordis.patch.yml'));
  assert.equal(options.waitMs, 1000);
  return operation();
}`,
  )
  const runtimeBundles = [
    ...officialBundles,
    ...(computerUsePlatforms ? [computerUseBundle] : []),
  ].filter((name) => !promotedTeam || name !== teamBundle)
  await module('@deepseek-ai/dsh', { './package.json': './package.json' }, '', {
    version: runtimeVersion,
    dependencies: Object.fromEntries(runtimeBundles.map((name) => [name, runtimeVersion])),
  })
  for (const bundle of runtimeBundles)
    await module(bundle, { './package.json': './package.json' }, '', {
      version: bundle === teamBundle ? (teamVersion ?? runtimeVersion) : runtimeVersion,
      dsh: {
        bundle: {
          patch: './cordis.patch.yml',
          ...(bundle === computerUseBundle ? { platforms: computerUsePlatforms } : {}),
        },
      },
    })
  if (existing) {
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify(existing))
  }
  if (cordisPatch !== undefined) {
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'cordis.patch.yml'), cordisPatch, 'utf8')
  }
  if (migrationReceipt) {
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'opl-official-bundles.json'), JSON.stringify(migrationReceipt))
  }
  const env = { ...process.env, OPL_DSH_CLI_PROFILE: cliProfile }
  if (cliProfile === undefined) delete env.OPL_DSH_CLI_PROFILE
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'])
    delete env[key]
  const archive = join(root, 'owned-enhancement.tgz')
  const install = () =>
    run(
      process.execPath,
      [
        join(payload, 'profile.cjs'),
        app,
        home,
        archive,
        ...(defaultContext ? ['--default-context'] : []),
      ],
      {
        env,
        timeout: 30000,
        windowsHide: true,
      },
    )
  await install()
  if (disableAndReinstall) {
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(
      (name) => !runtimeBundles.includes(name),
    )
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
    await install()
  }
  if (removeContextAndReinstall) {
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    delete manifest.dependencies['billion-context']
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(
      (name) => name !== 'billion-context',
    )
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
    await install()
  }
  return {
    manifest: JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')),
    template: JSON.parse(await readFile(join(profile, 'template-observation.json'), 'utf8')),
    install: JSON.parse(await readFile(join(profile, 'install-observation.json'), 'utf8')),
    archive,
    reinstall: install,
    readProfileFile: (name) =>
      readFile(join(profile, name), 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      }),
    retirement: await readFile(join(profile, 'retirement-observation.json'), 'utf8').then(
      JSON.parse,
      (error) => {
        if (error.code !== 'ENOENT') throw error
        return undefined
      },
    ),
  }
}

for (const owner of ['app-boot', 'official-bundles'])
  test(`profile installation reads the official web template from ${owner}`, async (t) => {
    const result = await runtime(t, owner)
    assert.deepEqual(result.template, bundles)
    assert.deepEqual(result.manifest.dsh.profile.bundles, [...bundles, ...autoEnabledBundles])
    assert.deepEqual(result.install, { profile: 'desktop', args: ['add', result.archive] })
  })

test('CLI installation uses the requested custom profile with the web template', async (t) => {
  const result = await runtime(t, 'app-boot', undefined, { cliProfile: 'opl-linux' })
  assert.deepEqual(result.template, bundles)
  assert.deepEqual(result.manifest.dsh.profile.bundles, [...bundles, ...autoEnabledBundles])
  assert.deepEqual(result.install, { profile: 'opl-linux', args: ['add', result.archive] })
})

test('unified installation installs @one-person-lab/dsh-opl, billion-context, and migrates legacy split config idempotently', async (t) => {
  const existing = {
    dependencies: {
      '@one-person-lab/dsh-opl': 'file:old.tgz',
      '@one-person-lab/dsh-execution': 'file:exec.tgz',
      '@one-person-lab/dsh-collaboration': 'file:collab.tgz',
    },
    dsh: {
      profile: {
        bundles: [
          ...bundles,
          '@one-person-lab/dsh-opl',
          '@one-person-lab/dsh-execution',
          '@one-person-lab/dsh-collaboration',
        ],
      },
    },
  }
  const cordisPatch = [
    '- id: opl-suite',
    '  config:',
    '    rememberPermissionPreset: true',
    '- id: opl-execution',
    '  config:',
    '    rememberPermissionPreset: false',
    '    minimaxCodeEnabled: false',
    '    toolAutoReview:',
    '      enabled: true',
    '- id: opl-collaboration',
    '  config:',
    '    wakeTransport: codex-queue',
    '    cooperation:',
    '      maxRevisions: 4',
    '',
  ].join('\n')
  const result = await runtime(t, 'app-boot', existing, {
    defaultContext: true,
    cordisPatch,
  })
  assert.equal(result.manifest.dependencies['@one-person-lab/dsh-execution'], undefined)
  assert.equal(result.manifest.dependencies['@one-person-lab/dsh-collaboration'], undefined)
  assert.deepEqual(result.manifest.dsh.profile.bundles, [
    ...bundles,
    ...autoEnabledBundles,
    '@one-person-lab/dsh-opl',
    'billion-context',
  ])
  assert.equal(result.manifest.dependencies['billion-context'], '0.1.216')
  const migrated = await result.readProfileFile('cordis.patch.yml')
  const backup = await result.readProfileFile('cordis.patch.before-v2-merge.yml')
  assert.equal(backup, cordisPatch)
  assert.ok(!migrated.includes('id: opl-execution'))
  assert.ok(!migrated.includes('id: opl-collaboration'))
  assert.ok(!migrated.includes('toolAutoReview'))
  assert.ok(migrated.includes('rememberPermissionPreset: true'))
  assert.ok(migrated.includes('minimaxCodeEnabled: false'))
  assert.ok(migrated.includes('wakeTransport: codex-queue'))
  await result.reinstall()
  assert.equal(await result.readProfileFile('cordis.patch.yml'), migrated)
  assert.equal(await result.readProfileFile('cordis.patch.before-v2-merge.yml'), cordisPatch)
})

test('suite update preserves an already installed but disabled Billion Context', async (t) => {
  const existing = {
    dependencies: { 'billion-context': '0.1.216' },
    dsh: { profile: { bundles } },
  }
  const result = await runtime(t, 'app-boot', existing, { defaultContext: true })
  assert.equal(result.manifest.dependencies['billion-context'], '0.1.216')
  assert(!result.manifest.dsh.profile.bundles.includes('billion-context'))
})

test('suite repair preserves a user uninstalling Billion Context', async (t) => {
  const result = await runtime(t, 'app-boot', undefined, {
    defaultContext: true,
    installSuiteBundle: true,
    removeContextAndReinstall: true,
  })
  assert(!Object.hasOwn(result.manifest.dependencies, 'billion-context'))
  assert(!result.manifest.dsh.profile.bundles.includes('billion-context'))
})

test('the moved template leaves an existing profile manifest intact', async (t) => {
  const existing = {
    dependencies: { 'personal-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['personal-bundle'] } },
  }
  const result = await runtime(t, 'official-bundles', existing)
  assert.deepEqual(result.manifest, existing)
  assert.deepEqual(result.install.args, ['add', result.archive])
})

test('official Team selection precedes OPL and preserves unrelated profile fields', async (t) => {
  const existing = {
    dependencies: { 'personal-plugin': '1.0.0' },
    dsh: { profile: { bundles: [...bundles, '@one-person-lab/dsh-opl'], personal: true } },
  }
  const result = await runtime(t, 'official-bundles', existing)
  assert.deepEqual(result.manifest, {
    ...existing,
    dsh: {
      profile: {
        ...existing.dsh.profile,
        bundles: [...bundles, ...autoEnabledBundles, '@one-person-lab/dsh-opl'],
      },
    },
  })
})

test('suite repair preserves a person disabling the migrated official bundles', async (t) => {
  const result = await runtime(t, 'official-bundles', undefined, { disableAndReinstall: true })
  assert.deepEqual(result.manifest.dsh.profile.bundles, bundles)
})

test('first migration places already enabled official bundles before the enhancement layer', async (t) => {
  const existing = {
    dsh: { profile: { bundles: [...bundles, '@one-person-lab/dsh-opl', ...officialBundles] } },
  }
  const result = await runtime(t, 'official-bundles', existing)
  assert.deepEqual(result.manifest.dsh.profile.bundles, [
    ...bundles,
    teamBundle,
    '@one-person-lab/dsh-opl',
    autoReviewBundle,
  ])
})

test('first migration preserves already installed official bundles that the person disabled', async (t) => {
  const existing = {
    dependencies: Object.fromEntries(officialBundles.map((name) => [name, officialVersion])),
    dsh: { profile: { bundles } },
  }
  const result = await runtime(t, 'official-bundles', existing)
  assert.deepEqual(result.manifest, existing)
})

test('Team activation refuses a package outside the actual official desktop cohort', async (t) => {
  await assert.rejects(
    runtime(t, 'official-bundles', undefined, { teamVersion: '0.2.1-rc.5' }),
    /官方插件与桌面版本不一致/,
  )
})

test('a desktop with built-in Team keeps experimental Auto Review disabled by default', async (t) => {
  const result = await runtime(t, 'official-bundles', undefined, { promotedTeam: true })
  assert.deepEqual(result.manifest.dsh.profile.bundles, bundles)
  assert.equal(result.retirement.bin, 'dsh')
  assert.deepEqual(result.retirement.options, { userLayer: false })
  assert(
    result.retirement.anchor.endsWith('/package.json') ||
      result.retirement.anchor.endsWith('\\package.json'),
  )
})

test('official retirement runs before a previous suite receipt can skip migration', async (t) => {
  const existing = {
    dependencies: { 'personal-plugin': '1.0.0' },
    dsh: {
      profile: {
        bundles: [...bundles, ...officialBundles, '@one-person-lab/dsh-opl'],
        personal: true,
      },
    },
  }
  const result = await runtime(t, 'official-bundles', existing, {
    promotedTeam: true,
    migrationReceipt: { schemaVersion: 1, bundles: officialBundles, officialVersion },
  })
  assert.deepEqual(result.manifest, {
    ...existing,
    dsh: {
      profile: {
        ...existing.dsh.profile,
        bundles: [...bundles, autoReviewBundle, '@one-person-lab/dsh-opl'],
      },
    },
  })
  assert(result.retirement)
})

test('Team promotion preserves a previously disabled Auto Review bundle', async (t) => {
  const existing = {
    dependencies: Object.fromEntries(officialBundles.map((name) => [name, officialVersion])),
    dsh: { profile: { bundles: [...bundles, teamBundle, '@one-person-lab/dsh-opl'] } },
  }
  const result = await runtime(t, 'official-bundles', existing, {
    promotedTeam: true,
    migrationReceipt: {
      schemaVersion: 1,
      bundles: officialBundles,
      officialVersion,
      preservedDisabled: [autoReviewBundle],
    },
  })
  assert.deepEqual(result.manifest.dependencies, existing.dependencies)
  assert.deepEqual(result.manifest.dsh.profile.bundles, [...bundles, '@one-person-lab/dsh-opl'])
})

test('installation preserves an explicitly enabled Auto Review without enabling it on a new profile', async (t) => {
  const existing = {
    dsh: { profile: { bundles: [...bundles, autoReviewBundle, '@one-person-lab/dsh-opl'] } },
  }
  const result = await runtime(t, 'official-bundles', existing, { promotedTeam: true })
  assert.deepEqual(result.manifest, existing)
})

test('desktop upgrade enables supported Computer Use once and preserves later opt-out', async (t) => {
  const existing = { dsh: { profile: { bundles: [...bundles, '@one-person-lab/dsh-opl'] } } }
  const migrationReceipt = { schemaVersion: 1, bundles: [teamBundle], preservedDisabled: [] }
  const options = { computerUsePlatforms: [process.platform], migrationReceipt }
  const enabled = await runtime(t, 'official-bundles', existing, options)
  assert.deepEqual(enabled.manifest.dsh.profile.bundles, [
    ...bundles,
    computerUseBundle,
    '@one-person-lab/dsh-opl',
  ])
  const optedOut = await runtime(t, 'official-bundles', existing, {
    ...options,
    disableAndReinstall: true,
  })
  assert.deepEqual(optedOut.manifest, existing)
  const unsupported = await runtime(t, 'official-bundles', existing, {
    ...options,
    computerUsePlatforms: [],
  })
  assert.deepEqual(unsupported.manifest, existing)
})
