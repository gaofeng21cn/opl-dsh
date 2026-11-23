/** Runs isolated Node tests concurrently while serializing tests bound to shared outputs or fs.watch timing. */
import { readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERIAL_TESTS = new Set([
  // Inspect shared dist/ outputs produced by build.mjs
  'artifact.test.mjs',
  'native-bridge.test.mjs',
  // Reads/regenerates src/generated/ RPC outputs while testing idempotency
  'rpc-generation.test.mjs',
  // Relies on tight wall-clock fs.watch / detached watcher handshake windows
  'coordinator-cli.test.mjs',
  'coordinator-runtime.test.mjs',
])

const files = readdirSync(resolve(root, 'tests'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
const parallel = files.filter((name) => !SERIAL_TESTS.has(name)).map((name) => `tests/${name}`)
const serial = files.filter((name) => SERIAL_TESTS.has(name)).map((name) => `tests/${name}`)
const concurrency = String(Math.min(Math.max(availableParallelism(), 1), 8))

function runBatch(label, args) {
  if (args.length <= 2) return
  console.log(`\n==> ${label}`)
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

runBatch(`Running ${parallel.length} isolated test files (concurrency=${concurrency})`, [
  '--test',
  `--test-concurrency=${concurrency}`,
  ...parallel,
])
runBatch(`Running ${serial.length} shared-state / timing-sensitive test files (serial)`, [
  '--test',
  '--test-concurrency=1',
  ...serial,
])
