/** Use the installed official release's shared, locked package operations. */
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { mkdirSync, writeFileSync, existsSync } = require('node:fs')
const [application, home, archive] = process.argv.slice(2)
async function main() {
  const resources = join(application, 'Contents/Resources')
  const runtime = join(resources, 'app.asar/dsh')
  const requireRuntime = createRequire(join(runtime, 'package.json'))
  const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
  process.env.DSH_HOME = home
  const { initProfile, PROFILE_TEMPLATES } = await load('@deepseek-ai/dsh-app-boot')
  const { runPluginCommand } = await load('@deepseek-ai/dsh-plugin-manager/operations')
  const dir = join(home, 'profiles/desktop')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  initProfile(dir, PROFILE_TEMPLATES.web.bundles)
  const workspace = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspace)) writeFileSync(workspace, 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n', { mode: 0o600, flag: 'wx' })
  const result = await runPluginCommand({ profile: 'desktop', dir, installAnchor: requireRuntime.resolve('@deepseek-ai/dsh/package.json'), cwd: process.cwd() }, ['add', resolve(archive)], {
    command: process.execPath, args: ['--expose-internals', join(resources, 'runtime/pnpm/bin/pnpm.cjs')],
    env: { ELECTRON_RUN_AS_NODE: '1', PATH: join(resources,'runtime/bin')+':'+process.env.PATH },
    execution: 'service', outputBytes: 8192, lockWaitMs: 1000, idleTimeoutMs: 120000,
    onOutput: text => process.stdout.write(text),
  })
  if(result.exitCode !== 0) throw new Error('Enhancement installation failed')
}
main().catch(error => { console.error(error.message); process.exitCode=1 })
