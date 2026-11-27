/** Use the installed official release's shared, locked package operations. */
const { join, resolve, delimiter, dirname } = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { parseArgs } = require('node:util')
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs')
const { installModelPlugins, preserveModelPlugins } = require('./model-plugins.cjs')
const { officialPnpm } = require('./official-pnpm.cjs')
const parsedArgs = parseArgs({
  args: process.argv.slice(2),
  options: {
    'ofm-upgrade': { type: 'boolean', default: false },
    'default-context': { type: 'boolean', default: false },
  },
  allowPositionals: true,
  strict: false,
})
const [application, home, archive, companion] = parsedArgs.positionals
const installDefaultContext = Boolean(parsedArgs.values['default-context'])
const ofmUpgradeMode = Boolean(parsedArgs.values['ofm-upgrade'])
const teamBundle = '@deepseek-ai/dsh-experimental-agent-team-profile'
const computerUseBundle = '@deepseek-ai/dsh-cua-bundle'
const cliProfile = process.env.OPL_DSH_CLI_PROFILE
if (
  cliProfile !== undefined &&
  (!/^[a-z][a-z0-9-]*$/u.test(cliProfile) || cliProfile === 'desktop')
)
  throw new Error('CLI profile 名称无效')
const profileName = cliProfile ?? 'desktop'

function isBundledComputerUseReady(requireRuntime, manifestPath) {
  if (process.platform !== 'win32') return true
  try {
    let winPkg
    try {
      winPkg = createRequire(manifestPath).resolve('@deepseek-ai/dsh-cua-windows/package.json')
    } catch {
      winPkg = requireRuntime.resolve('@deepseek-ai/dsh-cua-windows/package.json')
    }
    const unpackedRoot = dirname(winPkg).replace(
      /([\\/])app\.asar(?=[\\/])/u,
      '$1app.asar.unpacked',
    )
    return existsSync(
      join(unpackedRoot, 'native', 'bin', `win-${process.arch}`, 'dsh-cua-windows.exe'),
    )
  } catch {
    return false
  }
}

async function main() {
  const resources = cliProfile
    ? undefined
    : process.platform === 'win32'
      ? join(application, 'resources')
      : join(application, 'Contents/Resources')
  const runtime = cliProfile ? application : join(resources, 'app.asar/dsh')
  const pnpm = cliProfile ? 'pnpm' : officialPnpm(resources)
  const requireRuntime = createRequire(join(runtime, 'package.json'))
  const load = (name) => import(pathToFileURL(requireRuntime.resolve(name)).href)
  const official = JSON.parse(
    readFileSync(requireRuntime.resolve('@deepseek-ai/dsh/package.json'), 'utf8'),
  )
  const retiredTeam = !official.dependencies?.[teamBundle]
  if (
    retiredTeam &&
    !(await load('@deepseek-ai/dsh-official-bundles')).RETIRED_BUNDLES?.has(teamBundle)
  )
    throw new Error('官方桌面缺少 Team 插件且未声明迁移，未改动插件选择')
  const officialBundles = retiredTeam ? [] : [teamBundle]
  if (!cliProfile && official.dependencies?.[computerUseBundle]) {
    const computerUseManifestPath = requireRuntime.resolve(computerUseBundle + '/package.json')
    const metadata = JSON.parse(readFileSync(computerUseManifestPath, 'utf8'))
    if (
      metadata.dsh?.bundle?.platforms?.includes(process.platform) &&
      isBundledComputerUseReady(requireRuntime, computerUseManifestPath)
    )
      officialBundles.push(computerUseBundle)
  }
  process.env.DSH_HOME = home
  const boot = await load('@deepseek-ai/dsh-app-boot')
  const { initProfile } = boot
  const templates =
    boot.PROFILE_TEMPLATES ?? (await load('@deepseek-ai/dsh-official-bundles')).PROFILE_TEMPLATES
  const { runPluginCommand } = await load('@deepseek-ai/dsh-plugin-manager/operations')
  const dir = join(home, 'profiles', profileName)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  initProfile(dir, templates.web.bundles)
  const workspace = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspace))
    writeFileSync(workspace, 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n', {
      mode: 0o600,
      flag: 'wx',
    })
  const install = async (args) => {
    const result = await runPluginCommand(
      {
        profile: profileName,
        dir,
        installAnchor: requireRuntime.resolve('@deepseek-ai/dsh/package.json'),
        cwd: process.cwd(),
      },
      args,
      {
        ...(cliProfile
          ? { command: pnpm }
          : {
              command: process.execPath,
              args: ['--expose-internals', pnpm],
              env: {
                ELECTRON_RUN_AS_NODE: '1',
                PATH: join(resources, 'runtime/bin') + delimiter + process.env.PATH,
              },
            }),
        execution: cliProfile ? 'cli' : 'service',
        outputBytes: 8192,
        lockWaitMs: 1000,
        idleTimeoutMs: 120000,
        onOutput: (text) => process.stdout.write(text),
      },
    )
    if (result.exitCode !== 0) throw new Error('Plugin installation failed')
  }
  const restoreBundles = async (bundles) => {
    const { withFileLock } = await load('@deepseek-ai/dsh-atomic-write')
    const { stopped } = require('./ofm-owner.cjs')
    await withFileLock(
      join(dir, 'package.json'),
      async () => {
        await stopped(dir)
        const manifest = boot.readProfileManifest('dsh', dir)
        boot.writeProfileBundles(dir, manifest, bundles)
      },
      { waitMs: 1000 },
    )
  }
  if (ofmUpgradeMode) {
    // Register the independent OFM directory through the official profile operations.
    const { MODEL_PLUGINS } = require('./model-plugins.cjs')
    const { migrateOfmLink } = require('./ofm-upgrade.cjs')
    const result = await migrateOfmLink({ dir, install, restoreBundles, plugin: MODEL_PLUGINS[0] })
    process.stdout.write(JSON.stringify(result) + '\n')
    return
  }
  const suitePackage = '@one-person-lab/dsh-opl'
  const legacyOplPackages = [
    '@one-person-lab/dsh-execution',
    '@one-person-lab/dsh-collaboration',
  ]
  const manifestBefore = boot.readProfileManifest('dsh', dir)
  const depsBefore = manifestBefore.dependencies ?? {}
  const bundlesBefore = manifestBefore.dsh?.profile?.bundles ?? []
  const hadSuiteInstalled = Object.hasOwn(depsBefore, suitePackage)
  const suiteWasDisabled = hadSuiteInstalled && !bundlesBefore.includes(suitePackage)
  const executionWasDisabled =
    Object.hasOwn(depsBefore, '@one-person-lab/dsh-execution') &&
    !bundlesBefore.includes('@one-person-lab/dsh-execution')
  const collaborationWasDisabled =
    Object.hasOwn(depsBefore, '@one-person-lab/dsh-collaboration') &&
    !bundlesBefore.includes('@one-person-lab/dsh-collaboration')
  const { withFileLock: lockManifest, writeFileAtomic: writeAtomic } = await load(
    '@deepseek-ai/dsh-atomic-write',
  )
  await migrateUnifiedPatchSettings({
    dir,
    yaml: requireRuntime('yaml'),
    withFileLock: lockManifest,
    writeFileAtomic: writeAtomic,
    stopped: require('./ofm-owner.cjs').stopped,
    disabledModules: {
      execution: executionWasDisabled,
      collaboration: collaborationWasDisabled,
    },
  })
  await preserveModelPlugins({ dir, install: () => install(['add', resolve(archive)]) })
  await lockManifest(
    join(dir, 'package.json'),
    async () => {
      await require('./ofm-owner.cjs').stopped(dir)
      const manifest = boot.readProfileManifest('dsh', dir)
      let manifestChanged = false
      if (manifest.dependencies) {
        for (const legacy of legacyOplPackages) {
          if (Object.hasOwn(manifest.dependencies, legacy)) {
            delete manifest.dependencies[legacy]
            manifestChanged = true
          }
        }
      }
      const currentBundles = manifest.dsh?.profile?.bundles ?? []
      let nextBundles = currentBundles.filter((name) => !legacyOplPackages.includes(name))
      if (suiteWasDisabled) nextBundles = nextBundles.filter((name) => name !== suitePackage)
      if (manifestChanged || JSON.stringify(nextBundles) !== JSON.stringify(currentBundles)) {
        manifest.dsh ??= {}
        manifest.dsh.profile ??= {}
        manifest.dsh.profile.bundles = nextBundles
        await writeAtomic(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', {
          mode: 0o600,
        })
      }
    },
    { waitMs: 1000 },
  )
  await installModelPlugins({ dir, install, restoreBundles })
  const { releaseOfmManaged } = require('./ofm-owner.cjs')
  await releaseOfmManaged({
    dir,
    home,
    installAnchor: requireRuntime.resolve('@deepseek-ai/dsh/package.json'),
    load,
  })
  if (companion) await install(['add', resolve(companion)])
  // Select the shipped official layers once. Their plugin-manager switches own
  // later enablement; a suite repair must not undo the person's disabled choice.
  const receipt = join(dir, 'opl-official-bundles.json')
  const { withFileLock } = await load('@deepseek-ai/dsh-atomic-write')
  await withFileLock(
    join(dir, 'package.json'),
    async () => {
      await require('./ofm-owner.cjs').stopped(dir)
      // The official profile loader removes its retired bundle references before
      // the previous suite receipt can skip the optional-bundle migration.
      if (retiredTeam) {
        boot.loadProfileDirectory(
          'dsh',
          dir,
          requireRuntime.resolve('@deepseek-ai/dsh/package.json'),
          { userLayer: false },
        )
      }
      const saved = existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : undefined
      if (saved && (saved.schemaVersion !== 1 || !Array.isArray(saved.bundles)))
        throw new Error('官方插件迁移回执无效，已保留现有配置')
      const additions = officialBundles.filter((bundle) => !saved?.bundles.includes(bundle))
      if (saved && !additions.length) return
      const manifest = boot.readProfileManifest('dsh', dir)
      const bundles = manifest.dsh?.profile?.bundles ?? []
      if (!bundles.includes('@deepseek-ai/dsh-base')) return
      for (const bundle of additions) {
        const metadata = JSON.parse(
          readFileSync(requireRuntime.resolve(bundle + '/package.json'), 'utf8'),
        )
        if (
          official.dependencies?.[bundle] !== official.version ||
          metadata.version !== official.version
        )
          throw new Error('官方插件与桌面版本不一致，未改动插件选择：' + bundle)
        if (!metadata.dsh?.bundle?.patch)
          throw new Error('官方插件缺少 bundle 声明，未改动插件选择：' + bundle)
      }
      const next = bundles.filter((bundle) => !additions.includes(bundle))
      const suite = next.indexOf('@one-person-lab/dsh-opl')
      const preservedDisabled = additions.filter(
        (bundle) => Object.hasOwn(manifest.dependencies ?? {}, bundle) && !bundles.includes(bundle),
      )
      next.splice(
        suite < 0 ? next.length : suite,
        0,
        ...additions.filter((bundle) => !preservedDisabled.includes(bundle)),
      )
      if (JSON.stringify(next) !== JSON.stringify(bundles))
        boot.writeProfileBundles(dir, manifest, next)
      const { writeFileAtomic } = await load('@deepseek-ai/dsh-atomic-write')
      await writeFileAtomic(
        receipt,
        JSON.stringify(
          {
            schemaVersion: 1,
            bundles: [
              ...new Set([
                ...(saved?.bundles ?? []).filter(
                  (bundle) => !(retiredTeam && bundle === teamBundle),
                ),
                ...additions,
              ]),
            ],
            preservedDisabled: [
              ...(saved?.preservedDisabled ?? []).filter(
                (bundle) => !(retiredTeam && bundle === teamBundle),
              ),
              ...preservedDisabled,
            ],
            officialVersion: official.version,
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      )
    },
    { waitMs: 1000 },
  )
  // The official plugin manager owns enablement and subsequent removal.
  const contextPlugin = 'billion-context'
  const contextReceipt = join(dir, 'opl-billion-context-default')
  const contextProfile = boot.readProfileManifest('dsh', dir)
  if (
    installDefaultContext &&
    !existsSync(contextReceipt) &&
    contextProfile.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-base') &&
    !contextProfile.dsh.profile.bundles.includes('billion-context-dsh')
  ) {
    if (!Object.hasOwn(contextProfile.dependencies ?? {}, contextPlugin)) {
      try {
        await install(['add', contextPlugin + '@0.1.216'])
      } catch (error) {
        console.warn('Billion Context 安装待重试：' + error.message)
        return
      }
    }
    writeFileSync(contextReceipt, '1\n', { mode: 0o600 })
  }
}

function collectYamlAnchors(node, yaml, into) {
  if (!node || typeof node !== 'object') return
  if (typeof node.anchor === 'string' && node.anchor) into.add(node.anchor)
  if (yaml.isMap(node)) {
    for (const pair of node.items) {
      collectYamlAnchors(pair.key, yaml, into)
      collectYamlAnchors(pair.value, yaml, into)
    }
  } else if (yaml.isSeq(node)) {
    for (const item of node.items) collectYamlAnchors(item, yaml, into)
  }
}

function hasYamlAnchorOrAlias(node, yaml) {
  if (!node || typeof node !== 'object') return false
  if (yaml.isAlias(node) || (typeof node.anchor === 'string' && node.anchor)) return true
  if (yaml.isMap(node))
    return node.items.some(
      (pair) =>
        hasYamlAnchorOrAlias(pair.key, yaml) || hasYamlAnchorOrAlias(pair.value, yaml),
    )
  if (yaml.isSeq(node)) return node.items.some((item) => hasYamlAnchorOrAlias(item, yaml))
  return false
}

function materializeAliasesForAnchors(node, document, yaml, anchors) {
  if (!node || typeof node !== 'object') return
  if (yaml.isMap(node)) {
    for (const pair of node.items) {
      if (yaml.isAlias(pair.value) && anchors.has(pair.value.source)) {
        pair.value = document.createNode(pair.value.toJS(document))
      } else {
        materializeAliasesForAnchors(pair.value, document, yaml, anchors)
      }
    }
  } else if (yaml.isSeq(node)) {
    for (let i = 0; i < node.items.length; i++) {
      const item = node.items[i]
      if (yaml.isAlias(item) && anchors.has(item.source)) {
        node.items[i] = document.createNode(item.toJS(document))
      } else {
        materializeAliasesForAnchors(item, document, yaml, anchors)
      }
    }
  }
}

async function migrateUnifiedPatchSettings({
  dir,
  yaml,
  withFileLock,
  writeFileAtomic,
  stopped,
  disabledModules = { execution: false, collaboration: false },
}) {
  const file = join(dir, 'cordis.patch.yml')
  const hasDisabledModule = Boolean(disabledModules.execution || disabledModules.collaboration)
  if (!existsSync(file) && !hasDisabledModule) return
  await withFileLock(
    file,
    async () => {
      await stopped(dir)
      const hadFile = existsSync(file)
      const original = hadFile ? readFileSync(file, 'utf8') : '[]\n'
      const document = yaml.parseDocument(original, { logLevel: 'silent' })
      if (document.errors.length || !yaml.isSeq(document.contents))
        throw new Error('OPL 插件设置合并迁移无法读取现有配置，已保留原文件')
      const rows = document.contents.items
      const legacyIds = new Set(['opl-execution', 'opl-collaboration'])
      const legacyRows = rows.filter((row) => yaml.isMap(row) && legacyIds.has(row.get('id')))
      if (!legacyRows.length && !hasDisabledModule) return
      let suiteRow = rows.find((row) => yaml.isMap(row) && row.get('id') === 'opl-suite')
      if (!suiteRow) {
        suiteRow = document.createNode({ id: 'opl-suite', config: {} })
        document.contents.add(suiteRow)
      }
      let suiteConfig = suiteRow.get('config', true)
      if (!suiteConfig) {
        suiteConfig = document.createNode({})
        suiteRow.set('config', suiteConfig)
      }
      if (yaml.isAlias(suiteConfig)) {
        suiteConfig = document.createNode(suiteConfig.toJS(document) ?? {})
        suiteRow.set('config', suiteConfig)
      }
      if (!yaml.isMap(suiteConfig))
        throw new Error('opl-suite 配置不是映射结构，已保留现有配置文件')
      const legacyAnchors = new Set()
      for (const row of legacyRows) collectYamlAnchors(row, yaml, legacyAnchors)
      for (const row of legacyRows) {
        const rawConfig = row.get('config', true)
        const legacyConfig = yaml.isAlias(rawConfig) ? rawConfig.resolve(document) : rawConfig
        if (yaml.isMap(legacyConfig)) {
          for (const pair of legacyConfig.items) {
            const key = pair.key?.value ?? pair.key
            if (typeof key !== 'string' || key === 'toolAutoReview') continue
            if (
              yaml.isScalar(pair.value) &&
              (pair.value.value === null || pair.value.value === undefined)
            )
              continue
            if (pair.value === null || pair.value === undefined) continue
            if (!suiteConfig.has(key)) {
              const cloned = hasYamlAnchorOrAlias(pair.value, yaml)
                ? document.createNode(pair.value.toJS(document))
                : pair.value?.clone
                  ? pair.value.clone()
                  : pair.value
              suiteConfig.set(key, cloned)
            }
          }
        }
      }
      if (disabledModules.execution && !suiteConfig.has('executionEnabled')) {
        suiteConfig.set('executionEnabled', false)
      }
      if (disabledModules.collaboration && !suiteConfig.has('collaborationEnabled')) {
        suiteConfig.set('collaborationEnabled', false)
      }
      if (legacyAnchors.size > 0) {
        for (const row of rows) {
          if (!legacyRows.includes(row)) {
            materializeAliasesForAnchors(row, document, yaml, legacyAnchors)
          }
        }
      }
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]
        if (yaml.isMap(row) && legacyIds.has(row.get('id'))) rows.splice(i, 1)
      }
      const rendered = document.toString()
      const checkDoc = yaml.parseDocument(rendered, { logLevel: 'silent' })
      if (checkDoc.errors.length) {
        throw new Error('OPL 插件设置合并迁移校验失败，已保留原文件')
      }
      if (hadFile) {
        const backup = join(dir, 'cordis.patch.before-v2-merge.yml')
        if (!existsSync(backup)) writeFileSync(backup, original, { mode: 0o600, flag: 'wx' })
      }
      await writeFileAtomic(file, rendered, { mode: 0o600 })
    },
    { waitMs: 1000 },
  )
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
