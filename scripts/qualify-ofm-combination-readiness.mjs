/** Prove OFM model readiness gates automatic combinations in an isolated official Desktop. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertIsolatedRoot, safeBinding, sha256, verifyPayload } from './qualification-support.mjs'
import { startModelPluginFixture, MODEL_PLUGIN_FIXTURE } from './qualification-model-plugins.mjs'

const repo = resolve(import.meta.dirname, '..')
const payload = resolve(process.argv[2] ?? join(repo, 'dist/OPL DSH 一键安装'))
const app = resolve(process.argv[3] ?? '/Users/gaofeng/Applications/DeepSeek Harness.app')
const artifact = await verifyPayload(payload)

const root = await assertIsolatedRoot(await mkdtemp(join(tmpdir(), 'opl-dsh-accept-')))
const suite = join(root, 'suite')
const environment = {
  ...process.env,
  DSH_HOME: root,
  OPL_DSH_HOME: root,
  OPL_SUITE_ROOT: suite,
  OPL_CODEX_HOME: join(root, 'codex'),
  OPL_APPLICATIONS_DIR: join(root, 'applications'),
  OPL_INSTALL_NO_LAUNCH: '1',
  OPL_LEGACY_HOME: join(root, 'empty-legacy'),
  OPL_DESKTOP_LAUNCHER: join(root, 'qualification-launcher'),
}
delete environment.ELECTRON_RUN_AS_NODE
for (const key of Object.keys(environment))
  if (/API_KEY|API_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD/i.test(key))
    delete environment[key]

const executable = join(app, 'Contents/MacOS/DeepSeek Harness')
const fixture = await startModelPluginFixture()
Object.assign(environment, fixture.environment)
let desktop
let binding

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repo,
      env: environment,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGTERM')
      }
    }, options.timeout ?? 120_000)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once(
      'close',
      (code) => (
        clearTimeout(timeout),
        code === 0
          ? resolveRun(stdout)
          : reject(
              new Error(
                timedOut
                  ? `command timed out after ${String(options.timeout ?? 120_000)}ms: ${stdout.slice(-2000)}${stderr.slice(-2000)}`
                  : `command failed (${code}): ${stderr.slice(-4000)}`,
              ),
            )
      ),
    )
  })
}

async function rpc(namespace, method, args = {}, timeoutMs = 30000) {
  const response = await fetch(binding.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${binding.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ namespace, method, args, timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs + 5000),
  })
  const value = await response.json()
  if (!value.ok) throw new Error(`${namespace}/${method}: ${value.error}`)
  return value.value
}

async function startDesktop() {
  await rm(join(root, 'profiles/desktop/control.json'), { force: true })
  desktop = spawn(
    executable,
    [
      '--user-data-dir=' + join(root, 'electron'),
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
    { env: environment, detached: true, stdio: 'ignore', windowsHide: false },
  )
  for (let attempt = 0; attempt < 180; attempt++) {
    if (desktop.exitCode !== null) throw new Error(`isolated desktop exited: ${desktop.exitCode}`)
    try {
      binding = safeBinding(
        JSON.parse(await readFile(join(root, 'profiles/desktop/control.json'), 'utf8')),
      )
      await rpc('oplSuite', 'setupStatus')
      return
    } catch {}
    await delay(500)
  }
  throw new Error('isolated desktop did not become ready')
}

async function stopDesktop() {
  if (!desktop) return
  if (desktop.exitCode === null)
    try {
      process.kill(-desktop.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  for (let attempt = 0; attempt < 60 && desktop.exitCode === null; attempt++) await delay(100)
  if (desktop.exitCode === null)
    try {
      process.kill(-desktop.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  desktop = undefined
}

try {
  await mkdir(environment.OPL_LEGACY_HOME, { recursive: true })
  await writeFile(environment.OPL_DESKTOP_LAUNCHER, 'qualification-owned\n', { mode: 0o600 })
  const profile = join(root, 'profiles/desktop')
  await mkdir(profile, { recursive: true })
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n',
    { mode: 0o600 },
  )
  await run(executable, [join(payload, 'install.mjs'), app, suite, payload, '--no-launch'], {
    env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 20 * 60_000,
  })
  await startDesktop()
  let summary
  for (let attempt = 0; attempt < 90; attempt++) {
    summary = await rpc('oplSuite', 'setupStatus').catch(() => undefined)
    const catalog = await rpc('oplExecution', 'catalog').catch(() => undefined)
    if (catalog?.models?.some((item) => item.ref.model === MODEL_PLUGIN_FIXTURE)) break
    await delay(500)
  }
  const catalog = await rpc('oplExecution', 'catalog')
  const model = catalog.models.find(
    (item) => item.ref.provider === 'our-free-model' && item.ref.model === MODEL_PLUGIN_FIXTURE,
  )
  assert(model, 'fixture model missing from OPL catalog')
  assert.equal(model.available, true, 'DSH-native OFM model must remain usable without forward')
  const visible = await rpc('oplExecution', 'combinations', { request: {} })
  assert(
    !visible.some((item) => item.modelId === MODEL_PLUGIN_FIXTURE),
    'generic model was automatically exposed as an official pairing',
  )
  const all = await rpc('oplExecution', 'combinations', {
    request: { includeDisabled: true },
  })
  assert(
    !all.some((item) => item.modelId === MODEL_PLUGIN_FIXTURE),
    'generic model must not receive an automatic built-in combination',
  )
  const harnesses = await rpc('oplExecution', 'harness-installations', undefined)
  for (const id of ['minimax-code', 'opencode', 'kilo', 'pi']) {
    const item = harnesses.find((candidate) => candidate.id === id)
    assert(item, 'missing installable Harness row: ' + id)
    assert(
      ['install', 'update'].includes(item.maintenanceAction),
      'missing official install/update action: ' + id,
    )
  }
  const beforeManual = await rpc('oplExecution', 'catalog')
  const manual = structuredClone(beforeManual)
  manual.combinations.push({
    id: 'qualification-manual-dsh',
    name: 'Qualification manual + DSH',
    modelRef: { provider: 'our-free-model', model: MODEL_PLUGIN_FIXTURE },
    harnessRef: 'dsh',
    permissionPolicy: 'workspace',
    isDefault: true,
    enabled: true,
    autoEnabled: false,
    autoEnabledDisabled: true,
  })
  await rpc('oplExecution', 'save-catalog', { request: { catalog: manual } })
  const savedManual = await rpc('oplExecution', 'catalog')
  assert(
    savedManual.combinations.some(
      (item) =>
        item.id === 'qualification-manual-dsh' &&
        item.generated !== true &&
        item.modelRef.model === MODEL_PLUGIN_FIXTURE,
    ),
    'manual generic pairing was not saved as a custom combination',
  )
  // Turn the external lane on in OFM's own public surface. The login exchange is
  // the same one the Host uses for management.
  const web = await rpc('oplSuite', 'setupUrl')
  const origin = new URL(web).origin
  const auth = await fetch(web, { redirect: 'manual' })
  const cookie = auth.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ')
  assert(cookie, 'OFM login cookie missing')
  const forward = await fetch(origin + '/api/our-free-model/settings', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      forward: {
        enabled: true,
        host: '127.0.0.1',
        port: 18899,
        lan: { enabled: false, port: 0 },
      },
    }),
  })
  assert.equal(forward.status, 200, 'OFM forward settings write failed')
  for (let attempt = 0; attempt < 60; attempt++) {
    const current = await rpc('oplExecution', 'catalog')
    const currentModel = current.models.find(
      (item) => item.ref.provider === 'our-free-model' && item.ref.model === MODEL_PLUGIN_FIXTURE,
    )
    if (currentModel?.available === true) break
    await delay(500)
  }
  const ready = await rpc('oplExecution', 'combinations', { request: {} })
  const readyCombination = ready.find((item) => item.modelId === MODEL_PLUGIN_FIXTURE)
  assert(readyCombination, 'forward-on manual combination was not enabled')

  // A user stop is durable: saving the enabled row off must not be undone by
  // the next catalog projection while the model remains available.
  const execution = await rpc('oplExecution', 'catalog')
  const stored = execution.combinations.find((item) => item.id === 'qualification-manual-dsh')
  assert(stored, 'stored manual combination missing')
  stored.enabled = false
  await rpc('oplExecution', 'save-catalog', { request: { catalog: execution } })
  const afterUserStop = await rpc('oplExecution', 'catalog')
  const stopped = afterUserStop.combinations.find(
    (item) => item.modelRef.model === MODEL_PLUGIN_FIXTURE,
  )
  assert.equal(stopped?.enabled, false, 'user-disabled combination was reopened')
  const visibleAfterStop = await rpc('oplExecution', 'combinations', { request: {} })
  assert(
    !visibleAfterStop.some((item) => item.modelId === MODEL_PLUGIN_FIXTURE),
    'user-disabled combination remained visible',
  )

  console.log(
    JSON.stringify({
      status: 'passed',
      isolatedProfile: root,
      fixtureModel: MODEL_PLUGIN_FIXTURE,
      forwardOff: { modelAvailable: true, automaticCombination: false },
      officialInstallers: ['minimax-code', 'opencode', 'kilo', 'pi'],
      manualPairing: { saved: true, generated: false },
      forwardOn: { modelAvailable: true, manualCombinationAvailable: true },
      userStop: { enabled: false, visible: false },
      setupCompleted: summary?.completed === true,
    }),
  )
} finally {
  await fixture.close()
  await stopDesktop()
  await rm(root, { recursive: true, force: true })
}
