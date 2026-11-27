/** Read actual plugin/runtime dependency identities using the official Electron loader. */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const [app, profile, expectedZod] = process.argv.slice(2)
const runtime = createRequire(
  join(
    app,
    process.platform === 'darwin' ? 'Contents/Resources' : 'resources',
    'app.asar/dsh/package.json',
  ),
)
const installed = createRequire(join(profile, 'package.json'))
const pluginPath = installed.resolve('@one-person-lab/dsh-opl/package.json')
const plugin = createRequire(pluginPath)
function dependency(owner, name) {
  const path = owner.resolve(name + '/package.json')
  return { path, version: JSON.parse(readFileSync(path, 'utf8')).version }
}
const ownZod = dependency(plugin, 'zod')
const manifest = JSON.parse(readFileSync(pluginPath, 'utf8'))
if (manifest.dependencies?.zod !== expectedZod || ownZod.version !== expectedZod)
  throw new Error('Installed OPL validation dependency does not match the qualified source')
const official = {}
for (const name of ['@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-storage-domain']) {
  const path = runtime.resolve(name + '/package.json')
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  const zod = dependency(createRequire(path), 'zod')
  if (zod.version !== pkg.dependencies.zod)
    throw new Error('Official runtime validation dependency changed: ' + name)
  official[name] = { version: pkg.version, zod }
}
const bundleName = '@deepseek-ai/dsh-cua-bundle'
const runtimePackage = JSON.parse(
  readFileSync(runtime.resolve('@deepseek-ai/dsh/package.json'), 'utf8'),
)
const computerUseManifestPath = runtimePackage.dependencies?.[bundleName]
  ? runtime.resolve(bundleName + '/package.json')
  : undefined
const computerUse = computerUseManifestPath
  ? JSON.parse(readFileSync(computerUseManifestPath, 'utf8'))
  : undefined
let computerUseSupported = computerUse?.dsh?.bundle?.platforms?.includes(process.platform) === true
let computerUseBundledHelper = computerUseSupported
if (computerUseSupported && process.platform === 'win32' && computerUseManifestPath) {
  let helperPath
  try {
    let winPkg
    try {
      winPkg = createRequire(computerUseManifestPath).resolve(
        '@deepseek-ai/dsh-cua-windows/package.json',
      )
    } catch {
      winPkg = runtime.resolve('@deepseek-ai/dsh-cua-windows/package.json')
    }
    const unpackedRoot = dirname(winPkg).replace(
      /([\\/])app\.asar(?=[\\/])/u,
      '$1app.asar.unpacked',
    )
    helperPath = join(unpackedRoot, 'native', 'bin', `win-${process.arch}`, 'dsh-cua-windows.exe')
  } catch {
    helperPath = undefined
  }
  if (!helperPath || !existsSync(helperPath)) {
    computerUseSupported = false
    computerUseBundledHelper = false
  }
}
console.log(
  JSON.stringify({
    plugin: { path: pluginPath, zod: ownZod },
    official,
    computerUseSupported,
    computerUseBundledHelper,
  }),
)
